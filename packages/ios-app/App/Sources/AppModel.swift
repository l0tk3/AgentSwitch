import AgentSwitchKit
import SwiftUI
import UIKit

/// The one sheet the home screen shows at a time (app-v0 §5: one input box, everything else behind it).
enum HomeSheet: String, Identifiable {
    case settings, pickCiphertext, makeCiphertext, approvals
    var id: String { rawValue }
}

enum GateKeyStatus: Equatable {
    case unknown
    case available
    /// The Mac could not read its gate key (`GET /gate/pubkey` → 503); minting waits until it can.
    case unavailable(String)
}

/// App-wide state: the paired Mac, the live connection, the log's data and the input box. Views read it from the
/// environment; everything network-bound goes through `api`, which is pinned to the paired certificate.
@MainActor
@Observable
final class AppModel {
    private(set) var profile: ServerProfile?
    private(set) var connection: ConnectionState = .idle
    private(set) var api: AgentSwitchAPI?
    private(set) var me: Me?
    private(set) var tasks: [AgentTask] = []
    private(set) var approvals: [Approval] = []
    private(set) var ciphertexts: [SavedCiphertext] = []
    private(set) var gateKeyStatus: GateKeyStatus = .unknown
    private(set) var targets: Targets?
    private(set) var sending = false

    var composeText = ""
    /// Files waiting to go with the next task, already prepared (images shrunk, metadata dropped).
    private(set) var attachments: [PendingAttachment] = []
    /// Attachments still being read or prepared; sending waits for them.
    private(set) var preparingAttachments = 0
    /// The executor for the next task only; nil lets the router choose (the default).
    var pin: TargetRef?
    let speaker = Speaker()
    let feedback = Feedback()
    /// Threads as the router filed the tasks (the home screen labels and strip, the thread page).
    private(set) var threads: [AgentThread] = []
    private var cues = CueTracker()
    var sheet: HomeSheet?
    /// A pairing link from a tap or a scan, waiting for the user to confirm.
    var incomingPairingLink: String?
    var banner: String?

    private let store: LocalStore?
    private let vault: any TokenVault
    let notifications: any NotificationSink
    private var manager: ConnectionManager?
    private var watcher: Task<Void, Never>?

    init(store: LocalStore?, vault: any TokenVault, notifications: any NotificationSink = NoNotifications()) {
        self.store = store
        self.vault = vault
        self.notifications = notifications
        loadSaved()
    }

    static func live() -> AppModel {
        let store = try? LocalStore.standard()
        let model = AppModel(store: store, vault: KeychainTokenVault())
        if store == nil { model.banner = "无法打开本地存储，配对信息不会被保存" }
        return model
    }

    var isPaired: Bool { profile != nil }
    var canMint: Bool { profile?.gate?.isValid == true }

    // MARK: - pairing

    func receivePairingLink(_ text: String) {
        incomingPairingLink = text
    }

    /// Pairs with the Mac in `payload`, replacing any earlier pairing only once the new one succeeded.
    func pair(_ payload: PairingPayload, deviceName: String) async throws {
        let transport = PinnedSessionTransport(fingerprint: payload.fp)
        let outcome = try await PairingService(transport: transport, discovery: BonjourDiscovery()).pair(payload, deviceName: deviceName)
        if let old = profile { forgetQuietly(old) }
        try vault.save(outcome.token, account: outcome.profile.tokenAccount)
        try store?.saveProfile(outcome.profile)
        profile = outcome.profile
        gateKeyStatus = outcome.profile.gate == nil ? .unknown : .available
        connect(token: outcome.token, transport: transport)
    }

    /// Re-pair: drop the token, the profile and everything fetched from that Mac. Saved ciphertexts stay.
    func forget() {
        guard let old = profile else { return }
        forgetQuietly(old)
        sheet = nil
    }

    private func forgetQuietly(_ old: ServerProfile) {
        stopConnection()
        try? vault.delete(account: old.tokenAccount)
        try? store?.deleteProfile()
        profile = nil
        connection = .idle
        api = nil
        me = nil
        tasks = []
        approvals = []
        threads = []
        cues = CueTracker()
        targets = nil
        pin = nil
        gateKeyStatus = .unknown
    }

    // MARK: - connection

    private func loadSaved() {
        ciphertexts = (try? store?.loadCiphertexts()) ?? []
        guard let saved = try? store?.loadProfile() else { return }
        profile = saved
        gateKeyStatus = saved.gate == nil ? .unknown : .available
        guard let token = try? vault.load(account: saved.tokenAccount) else {
            connection = .unauthorized
            return
        }
        connect(token: token, transport: PinnedSessionTransport(fingerprint: saved.fingerprint))
    }

    private func connect(token: String, transport: PinnedSessionTransport) {
        guard let profile else { return }
        stopConnection()
        let manager = ConnectionManager(book: profile, token: token, discovery: BonjourDiscovery(),
                                        prober: HTTPEndpointProber(transport: transport))
        self.manager = manager
        api = AgentSwitchAPI(endpoints: manager, transport: transport, token: token)
        watcher = Task { [weak self] in
            await manager.startMonitoring(NetworkPathMonitor())
            for await state in await manager.states() {
                self?.connectionChanged(state)
            }
        }
        Task { await manager.reselect() }
    }

    private func stopConnection() {
        watcher?.cancel()
        watcher = nil
        if let manager { Task { await manager.stop() } }
        manager = nil
    }

    private func connectionChanged(_ state: ConnectionState) {
        let wasConnected = connection.endpoint != nil
        connection = state
        if state.endpoint != nil && !wasConnected {
            Task {
                await refreshAll()
                await refreshGateKey()
                me = try? await api?.me()
                await refreshTargets()
            }
        }
    }

    /// Back in the foreground: look for a better path if we had none, and refresh what the tabs show.
    func resume() {
        guard let manager else { return }
        if connection.endpoint == nil, connection != .unauthorized {
            Task { await manager.reselect() }
        } else {
            Task { await refreshAll() }
        }
    }

    func reconnect() {
        guard let manager else { return }
        Task { await manager.reselect() }
    }

    // MARK: - data

    func refreshAll() async {
        await refreshTasks()
        await refreshApprovals()
        await refreshThreads()
    }

    func refreshThreads() async {
        guard let api else { return }
        if let fresh = try? await api.threads() { threads = fresh }
    }

    func thread(_ id: String?) -> AgentThread? {
        id.flatMap { id in threads.first { $0.id == id } }
    }

    func refreshTargets() async {
        guard let api else { return }
        do { targets = try await api.targets() } catch { handle(error) }
    }

    func refreshTasks() async {
        guard let api else { return }
        do {
            tasks = try await api.tasks()
            announce()
        } catch { handle(error) }
    }

    /// Endings get a sound; in voice mode a finished task's spoken script is read once it has arrived.
    private func announce() {
        for cue in cues.taskCues(tasks) { feedback.play(cue.cue, speaking: speaker.isSpeaking) }
        guard feedback.settings.voiceMode else { _ = cues.newScripts(tasks); return }
        for task in cues.newScripts(tasks) { speaker.toggle(task) }
    }

    func refreshApprovals() async {
        guard let api else { return }
        do {
            let fresh = try await api.approvals()
            for approval in cues.newApprovals(fresh) {
                feedback.play(.needsYou, speaking: speaker.isSpeaking)
                if feedback.settings.voiceMode { speaker.say(Self.spokenQuestion(approval), key: approval.id) }
                await notifications.needsAttention(taskId: approval.taskId, approval: approval)
            }
            approvals = fresh
        } catch { handle(error) }
    }

    /// The Mac's current gate key. Kept as is when the Mac cannot read it (503), so minting keeps working with the key
    /// from pairing; the gate still opens tokens made for any of its keypairs.
    func refreshGateKey() async {
        guard let api, let profile else { return }
        do {
            let key = try await api.gatePubkey()
            guard key.isValid else { return }
            if key != profile.gate {
                let updated = profile.with(gate: key)
                try? store?.saveProfile(updated)
                self.profile = updated
            }
            gateKeyStatus = .available
        } catch APIError.http(status: 503, message: let message) {
            if profile.gate == nil { gateKeyStatus = .unavailable(message.isEmpty ? "gate 公钥暂时不可用" : message) }
        } catch {
            handle(error)
        }
    }

    /// Central error funnel: a 401 anywhere means this phone is no longer paired.
    func handle(_ error: Error) {
        if error is CancellationError { return }
        if let api = error as? APIError, api == .unauthorized {
            connection = .unauthorized
            banner = api.localizedDescription
            return
        }
        banner = error.localizedDescription
    }

    func taskCreated(_ task: AgentTask) {
        tasks.removeAll { $0.id == task.id }
        tasks.insert(task, at: 0)
    }

    /// The input box's send: no thread and no parent, the router files it (threads-v0). Text and pin are cleared only
    /// once the Mac accepted the task, and the text only if it was not edited meanwhile. A failure keeps them for
    /// another try and returns the message for the input box (not the banner, so it shows once).
    func send() async -> String? {
        let typed = composeText
        let written = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        // Attachments alone are a task too.
        let text = written.isEmpty && !attachments.isEmpty ? Self.attachmentsOnlyTask : written
        guard let api, !text.isEmpty, !sending, preparingAttachments == 0 else { return nil }
        feedback.play(.sent, speaking: speaker.isSpeaking)
        sending = true
        defer { sending = false }
        let outgoing = attachments
        let staged: [StagedUpload]
        do {
            staged = outgoing.isEmpty ? [] : try await api.upload(outgoing.map(\.file))
        } catch {
            feedback.play(.failed, speaking: speaker.isSpeaking)
            if case APIError.unauthorized = error { handle(error) }
            // Nothing was created yet: the task is only sent after its files are staged.
            return "附件没传上去（\(error.localizedDescription)），再发一次试试。"
        }
        do {
            let task = try await api.createTask(NewTaskRequest(task: text, pin: pin, attachments: staged.map(\.id)))
            if composeText == typed { composeText = "" }
            pin = nil
            attachments.removeAll { item in outgoing.contains { $0.id == item.id } }
            taskCreated(task)
            feedback.play(.accepted, speaking: speaker.isSpeaking)
            if feedback.settings.voiceMode { speaker.say("收到，正在安排。", key: task.id) }
            return nil
        } catch let error as APIError where error.isNetworkFailure {
            // The Mac may have created it before the connection broke: look before sending again.
            feedback.play(.failed, speaking: speaker.isSpeaking)
            await refreshTasks()
            return Self.unconfirmedSend
        } catch {
            feedback.play(.failed, speaking: speaker.isSpeaking)
            if case APIError.unauthorized = error { handle(error) }
            return error.localizedDescription
        }
    }

    static let attachmentsOnlyTask = "请查看附件。"

    /// What voice mode reads when something needs you: the questions, else the action to approve.
    static func spokenQuestion(_ approval: Approval) -> String {
        if let evidence = approval.questionEvidence {
            return "需要你回答：" + evidence.questions.map(\.text).joined(separator: "。")
        }
        return "需要你批准：" + approval.action
    }
    static let unconfirmedSend = "没收到 Mac 的确认，任务可能已经建好了：先看日志里有没有这条，再决定要不要重发。"

    /// Answering in the log: the result shows up in the task's state and the approvals list right after.
    func decide(_ approval: Approval, _ decision: ApprovalDecision) async {
        await act { try await $0.approve(taskId: approval.taskId, approvalId: approval.id, decision: decision) }
    }

    func answer(_ approval: Approval, _ answers: [String: [String]]) async {
        await act { try await $0.answer(taskId: approval.taskId, approvalId: approval.id, answers: answers) }
    }

    private func act(_ body: (AgentSwitchAPI) async throws -> Void) async {
        guard let api else { return }
        do { try await body(api) } catch { handle(error) }
        await refreshAll()
    }

    /// Adds files to the next task: images are prepared off the main thread; the limits are the Mac's (20 files, 50 MB
    /// each) plus 100 MB in all on the phone. Returns what could not be added, if anything.
    /// `prepare`: photos, camera shots and pasted images are shrunk and re-encoded without metadata (ImagePrep); a file
    /// picked in the Files app goes as it is.
    func addAttachments(_ files: [UploadFile], prepare: Bool) async -> String? {
        preparingAttachments += 1
        defer { preparingAttachments -= 1 }
        let prepared = await Task.detached(priority: .userInitiated) { files.map { ($0.name, prepare ? ImagePrep.prepare($0) : $0) } }.value
        var problems: [String] = []
        for (name, file) in prepared {
            guard let file else { problems.append("\(name) 读不出来"); continue }
            if let problem = PendingAttachment.problem(adding: file, to: attachments) { problems.append(problem); continue }
            attachments.append(PendingAttachment(file: file))
        }
        return problems.isEmpty ? nil : problems.joined(separator: "；")
    }

    func removeAttachment(_ id: UUID) {
        attachments.removeAll { $0.id == id }
    }

    func taskDeleted(_ id: String) {
        tasks.removeAll { $0.id == id }
        approvals.removeAll { $0.taskId == id }
    }

    /// The explicit deletes (log entry, task page, settings): nil when done, else the message to show.
    func delete(_ request: DeleteRequest) async -> String? {
        guard let api else { return nil }
        do {
            switch request {
            case .task(let task):
                try await api.deleteTask(task.id)
                taskDeleted(task.id)
            case .thread(let id, _):
                try await api.deleteThread(id)
                await refreshAll()
            }
            return nil
        } catch {
            handle(error)
            return DeleteRequest.message(for: error)
        }
    }

    // MARK: - ciphertexts

    /// Seals the draft's value to the gate key on this phone; only the ciphertext and note are kept.
    func mint(_ draft: SecretDraft) throws -> SavedCiphertext {
        guard let gate = profile?.gate else { throw TokenError.badPublicKey }
        let token = try TokenMinter(publicKeyBase64URL: gate.publicKey).mint(try draft.payload())
        let item = SavedCiphertext(token: token, note: draft.effectiveNote)
        ciphertexts.insert(item, at: 0)
        persistCiphertexts()
        return item
    }

    func deleteCiphertexts(_ ids: Set<UUID>) {
        ciphertexts.removeAll { ids.contains($0.id) }
        persistCiphertexts()
    }

    /// Appends a ciphertext to the input box and closes whatever sheet it was picked in.
    func insertIntoCompose(_ token: String) {
        composeText += (composeText.isEmpty || composeText.hasSuffix(" ") ? "" : " ") + token
        sheet = nil
    }

    private func persistCiphertexts() {
        do { try store?.saveCiphertexts(ciphertexts) } catch { banner = error.localizedDescription }
    }
}

extension AppModel {
    /// Sample state for SwiftUI previews only.
    static func preview() -> AppModel {
        let model = AppModel(store: nil, vault: MemoryTokenVault())
        let payload = PairingPayload(name: "Mac mini", port: 4713, fp: String(repeating: "ab", count: 32), code: "7K3M-9QZX",
                                     lan: ["192.168.1.5"], tailnet: ["100.101.102.103"], bonjour: "AgentSwitch on Mac mini",
                                     gate: GateKey(publicKey: Base64URLPreview.key, keypair: "default"))
        model.profile = ServerProfile(payload: payload, deviceId: "dev-preview", gate: nil)
        model.connection = .connected(APIEndpoint(host: "192.168.1.5", port: 4713, kind: .bonjour))
        model.ciphertexts = [SavedCiphertext(token: "enc:v1:" + String(repeating: "Q", count: 120), note: "公司 VPN（vpn/pass）")]
        return model
    }
}

enum Base64URLPreview {
    static let key = String(repeating: "A", count: 43)
}
