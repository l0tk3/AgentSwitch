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
    /// How the attempts went since the last connection: the tiers of the connection line (control-v0 §5).
    private(set) var connectionProgress = ConnectionProgress()
    private(set) var api: AgentSwitchAPI?
    private(set) var me: Me?
    /// How each address fared in the last route choice (settings › Mac), for "why can't it connect".
    private(set) var routeReport: (at: Date, reports: [ProbeReport])?
    private(set) var tasks: [AgentTask] = []
    /// Tasks opened on this phone and when, until the Mac's list says so too (no flicker back to unread in between).
    private var readLocally: [String: Int64] = [:]
    /// The Mac records read marks (`POST /tasks/:id/ack`); an older one answers 404 and then no task shows as unread.
    private(set) var readMarksSupported = true
    private(set) var approvals: [Approval] = []
    private(set) var ciphertexts: [SavedCiphertext] = []
    private(set) var gateKeyStatus: GateKeyStatus = .unknown
    private(set) var targets: Targets?
    /// `GET /quota` as last read (设置 › 用量); nil until the Mac has answered once. A failed re-read keeps it.
    private(set) var quota: [QuotaReading]?
    private(set) var sending = false
    /// The conversation with the assistant (the home screen); loaded newest first, then polled for what follows.
    private(set) var conversation = ConversationLog()
    private var conversationLoaded = false
    /// The Mac has the assistant (a Mac without it answers 404). Then the assistant reports ends and questions in the
    /// conversation, and voice mode reads those instead of reading tasks and approvals on its own (not twice).
    private(set) var hasAssistant = false
    /// The message on its way, until the Mac answers; one at a time.
    private(set) var outgoing: OutgoingMessage?

    var composeText = ""
    /// Files waiting to go with the next task, already prepared (images shrunk, metadata dropped).
    private(set) var attachments: [PendingAttachment] = []
    /// Attachments still being read or prepared; sending waits for them.
    private(set) var preparingAttachments = 0
    /// The executor for the next task only; nil lets the router choose (the default).
    var pin: TargetRef?
    let speaker = Speaker()
    let feedback = Feedback()
    let live = LiveActivities()
    /// The home screen's live event tails (FeedModel): the current step of each task in the Live Activity.
    var liveTails: [String: [TaskEvent]] = [:] { didSet { if liveTails != oldValue { syncLive() } } }
    /// A task to open, from a Live Activity's link (`agentswitch://task/<id>`); the home screen takes it.
    var openTaskRequest: String?
    /// Syncs one after another: two at once could each start an activity.
    @ObservationIgnored private var liveSync: Task<Void, Never>?
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
        if store == nil { model.banner = "无法打开本地存储，配对信息将无法保存。" }
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
        connectionProgress = ConnectionProgress()
        api = nil
        me = nil
        tasks = []
        readLocally = [:]
        readMarksSupported = true
        approvals = []
        threads = []
        conversation = ConversationLog()
        conversationLoaded = false
        hasAssistant = false
        outgoing = nil
        cues = CueTracker()
        targets = nil
        quota = nil
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
        connectionProgress = connectionProgress.after(state)
        if state != .selecting, let manager { Task { self.routeReport = await manager.lastReport } }
        if state.endpoint != nil && !wasConnected {
            Task {
                await refreshAll()
                await refreshGateKey()
                await refreshAddresses()
                me = try? await api?.me()
                await refreshTargets()
            }
        }
    }

    /// What the connection line says now (连接中 · 重连中 · 无法连接（第 N 次）· 未找到 Mac · 配对已失效).
    var connectionPhase: ConnectionPhase { connectionProgress.phase(connection) }

    /// Back in the foreground (control-v0 §5): the address in use is checked at once, since it may have gone while the
    /// phone slept (another Wi-Fi, Tailscale off), and a new one chosen if it does not answer; then a refresh. A
    /// connection that comes back refreshes by itself (connectionChanged).
    func resume() {
        guard let manager, connection != .unauthorized else { return }
        let before = connection.endpoint
        Task {
            let state = await manager.verify()
            if let endpoint = state.endpoint, endpoint == before { await refreshAll() }
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
        await refreshConversation()
    }

    /// First the newest messages, then what came after the last one held. An answer the phone missed (the connection
    /// broke after the Mac got the message) confirms the waiting bubble; one that arrives this way is sounded and, in
    /// voice mode, read.
    func refreshConversation() async {
        guard let api else { return }
        do {
            if !conversationLoaded {
                conversation = ConversationLog(try await api.assistantMessages(last: Conversation.defaultLimit))
                conversationLoaded = true
                hasAssistant = true
            } else {
                let fresh = try await api.assistantMessages(after: conversation.lastSeq)
                let arrived = conversation.newAssistantMessages(in: fresh)
                conversation = conversation.merging(fresh)
                for message in arrived { announceMessage(message) }
            }
            if let waiting = outgoing, conversation.contains(clientId: waiting.clientId) { outgoing = nil }
        } catch APIError.http(status: 404, message: _) {
            conversationLoaded = true   // a Mac without the assistant: the log shows tasks only
            hasAssistant = false
        } catch { handle(error) }
    }

    /// An assistant message: a sound, and in voice mode its text read aloud. A report of an end or a question has its
    /// sound already (the task's own cue); a progress line gets a light one.
    private func announceMessage(_ message: AssistantMessage) {
        switch message.kind {
        case .notice, .waiting: break
        case .progress: feedback.play(.sent, speaking: speaker.isSpeaking)
        default: feedback.play(.accepted, speaking: speaker.isSpeaking)
        }
        if feedback.settings.voiceMode { speaker.say(MessageDisplay.readable(message.text), key: "m\(message.seq)") }
    }

    func refreshThreads() async {
        guard let api else { return }
        if let fresh = try? await api.threads() { threads = fresh }
        syncLive()
    }

    /// The Live Activity follows the tasks, the questions waiting for you and the live tails (assistant-v0 §4).
    func syncLive() {
        let titles = Dictionary(threads.compactMap { t in t.title.map { (t.id, $0) } }, uniquingKeysWith: { a, _ in a })
        let state = LiveSummary.state(tasks: tasks, approvals: approvals, threadTitles: titles, tails: liveTails)
        let ended = state == nil ? LiveSummary.ended(tasks: tasks, threadTitles: titles) : nil
        let mac = profile?.name ?? "Mac"
        let live = live
        let previous = liveSync
        liveSync = Task {
            await previous?.value
            await live.sync(state, ended: ended, macName: mac)
        }
    }

    /// From a Live Activity: the home screen opens the task (sheets close first).
    func openTask(_ id: String) {
        sheet = nil
        openTaskRequest = id
    }

    func thread(_ id: String?) -> AgentThread? {
        id.flatMap { id in threads.first { $0.id == id } }
    }

    func refreshTargets() async {
        guard let api else { return }
        do { targets = try await api.targets() } catch { handle(error) }
    }

    /// Usage per executor, quietly: an older Mac or a failed read leaves the last numbers (or none) and no banner.
    /// `force` has the Mac read every executor again instead of answering from its cache (pull to refresh).
    func refreshQuota(force: Bool = false) async {
        guard let api else { return }
        do {
            quota = try await force ? api.refreshQuota() : api.quota()
        } catch {
            if case APIError.unauthorized = error { handle(error) }
        }
    }

    func refreshTasks() async {
        guard let api else { return }
        do {
            tasks = withLocalReads(try await api.tasks())
            announce()
            syncLive()
        } catch { handle(error) }
    }

    /// Endings get a sound; in voice mode a finished task's spoken script is read once it has arrived (the assistant's
    /// report reads it instead when the Mac has one).
    private func announce() {
        for cue in cues.taskCues(tasks) { feedback.play(cue.cue, speaking: speaker.isSpeaking) }
        guard feedback.settings.voiceMode, !hasAssistant else { _ = cues.newScripts(tasks); return }
        for task in cues.newScripts(tasks) { speaker.toggle(task) }
    }

    func refreshApprovals() async {
        guard let api else { return }
        do {
            let fresh = try await api.approvals()
            for approval in cues.newApprovals(fresh) {
                feedback.play(.needsYou, speaking: speaker.isSpeaking)
                if feedback.settings.voiceMode && !hasAssistant { speaker.say(Self.spokenQuestion(approval), key: approval.id) }
                await notifications.needsAttention(taskId: approval.taskId, approval: approval)
            }
            approvals = fresh
            syncLive()
        } catch { handle(error) }
    }

    /// The Mac's current addresses into the saved profile and the address choice, so a phone paired while Tailscale was
    /// off (or before the Mac's LAN address changed) still finds it elsewhere next time.
    func refreshAddresses() async {
        guard let api, let profile, let now = try? await api.addresses(), let updated = profile.updated(with: now) else { return }
        try? store?.saveProfile(updated)
        self.profile = updated
        await manager?.update(book: updated)
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
            if profile.gate == nil { gateKeyStatus = .unavailable(message.isEmpty ? "公钥暂时不可用" : message) }
        } catch {
            handle(error)
        }
    }

    /// Central error funnel: a 401 anywhere means this phone is no longer paired. A network failure is left to the
    /// connection line (无法连接（第 N 次）…), which says it better and goes away by itself once the Mac is back.
    func handle(_ error: Error) {
        if error is CancellationError { return }
        if let api = error as? APIError, api == .unauthorized {
            connection = .unauthorized
            banner = api.localizedDescription
            return
        }
        if let api = error as? APIError, api.isNetworkFailure { return }
        banner = error.localizedDescription
    }

    /// Ended and not opened yet, as far as this Mac keeps read marks.
    func isUnread(_ task: AgentTask) -> Bool {
        readMarksSupported && task.isUnread
    }

    /// Tasks with an open approval or question.
    var pendingTaskIds: Set<String> {
        Set(approvals.filter { $0.status == .pending }.map(\.taskId))
    }

    /// Opening a task reads it (control-v0 §4): marked here at once, then on the Mac. A Mac without read marks (404)
    /// turns the marks off rather than leaving every ended task unread.
    func acknowledge(_ task: AgentTask) async {
        guard readMarksSupported, task.isUnread, (readLocally[task.id] ?? 0) < task.updatedAt else { return }
        let at = max(Int64(Date().timeIntervalSince1970 * 1000), task.updatedAt)
        readLocally[task.id] = at
        tasks = withLocalReads(tasks)
        guard let api else { return }
        do {
            try await api.acknowledge(taskId: task.id)
        } catch APIError.http(status: 404, message: _) {
            readMarksSupported = false
        } catch {
            if case APIError.unauthorized = error { handle(error) }
        }
    }

    /// The Mac's list with this phone's newer read marks laid over it; a mark the Mac has caught up with is dropped.
    private func withLocalReads(_ fresh: [AgentTask]) -> [AgentTask] {
        guard !readLocally.isEmpty else { return fresh }
        readLocally = readLocally.filter { id, at in fresh.first { $0.id == id }.map { ($0.acknowledgedAt ?? 0) < at } ?? true }
        return fresh.map { task in
            guard let at = readLocally[task.id], (task.acknowledgedAt ?? 0) < at else { return task }
            return task.acknowledged(at: at)
        }
    }

    func taskCreated(_ task: AgentTask) {
        tasks.removeAll { $0.id == task.id }
        tasks.insert(task, at: 0)
    }

    /// The input box's send (assistant-v0 §1.1): the message goes to the assistant, which answers, looks up a task or
    /// hands the work to the router. The box empties at once and the message waits in its bubble until the Mac answers;
    /// a failure stays there with a resend, which the Mac recognizes by the client id and answers only once.
    func send() async -> String? {
        let typed = composeText
        let written = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        // Attachments alone are a task too.
        let text = written.isEmpty && !attachments.isEmpty ? Self.attachmentsOnlyTask : written
        guard api != nil, !text.isEmpty, !sending, outgoing == nil, preparingAttachments == 0 else { return nil }
        outgoing = OutgoingMessage(text: text, attachments: attachments, pin: pin)
        if composeText == typed { composeText = "" }
        attachments = []
        pin = nil
        await deliver()
        return nil
    }

    /// The waiting message again, same client id: the Mac answers a message it already has with its first answer.
    func resend() async {
        guard let waiting = outgoing, waiting.failure != nil, !sending else { return }
        outgoing = waiting.failing(nil)
        await deliver()
    }

    /// Back into the input box to change it; the Mac never got it, or answers the old one only if it is resent.
    func editOutgoing() {
        guard let waiting = outgoing, waiting.failure != nil else { return }
        if composeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { composeText = waiting.text == Self.attachmentsOnlyTask ? "" : waiting.text }
        attachments = waiting.attachments + attachments
        pin = pin ?? waiting.pin
        outgoing = nil
    }

    private func deliver() async {
        guard let api, var message = outgoing else { return }
        feedback.play(.sent, speaking: speaker.isSpeaking)
        sending = true
        defer { sending = false }
        if message.staged == nil {
            do {
                message = message.staging(message.attachments.isEmpty ? [] : try await api.upload(message.attachments.map(\.file)).map(\.id))
                outgoing = message
            } catch {
                return fail("附件上传失败（\(error.localizedDescription)）。", error)
            }
        }
        do {
            received(try await api.sendMessage(NewMessage(text: message.text, clientId: message.clientId, attachments: message.staged, pin: message.pin)))
        } catch APIError.http(status: 404, message: _) {
            await sendAsTask(message, api)
        } catch let error as APIError where error.isNetworkFailure {
            fail(Self.unconfirmedSend, error)
            await refreshConversation()   // it may have arrived: the stored message confirms it
        } catch {
            fail(error.localizedDescription, error)
        }
    }

    private func received(_ reply: AssistantReply) {
        conversation = conversation.merging([reply.user, reply.assistant])
        if let task = reply.task { taskCreated(task) }
        outgoing = nil
        announceMessage(reply.assistant)
    }

    /// A Mac without the assistant (an older daemon): the message becomes a task as before.
    private func sendAsTask(_ message: OutgoingMessage, _ api: AgentSwitchAPI) async {
        do {
            let task = try await api.createTask(NewTaskRequest(task: message.text, pin: message.pin, attachments: message.staged ?? []))
            taskCreated(task)
            outgoing = nil
            feedback.play(.accepted, speaking: speaker.isSpeaking)
        } catch {
            fail(error.localizedDescription, error)
        }
    }

    private func fail(_ reason: String, _ error: Error) {
        feedback.play(.failed, speaking: speaker.isSpeaking)
        if case APIError.unauthorized = error { handle(error) }
        outgoing = outgoing?.failing(reason)
    }

    static let attachmentsOnlyTask = "请查看附件。"

    /// What voice mode reads when something needs you: the questions, else the action to approve.
    static func spokenQuestion(_ approval: Approval) -> String {
        if let evidence = approval.questionEvidence {
            return "等你回答：" + evidence.questions.map(\.text).joined(separator: "。")
        }
        return "等你批准：" + approval.action
    }
    static let unconfirmedSend = "未收到 Mac 的响应。重发不会导致重复处理。"

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
            guard let file else { problems.append("\(name) 无法读取"); continue }
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

#if DEBUG
extension AppModel {
    /// The sample screens (`-uiDemo YES`): a paired Mac, the demo conversation and tasks, no network. `offline`: the
    /// Mac has not answered for three tries in a row, the last route choice found nothing.
    static func demo(offline: Bool = false) -> AppModel {
        let model = preview()
        model.tasks = DemoData.tasks
        model.threads = DemoData.threads
        model.approvals = DemoData.approvals
        model.conversation = ConversationLog(DemoData.messages)
        model.hasAssistant = true
        model.quota = DemoData.quota
        model.routeReport = (Date().addingTimeInterval(-40), DemoData.routeReport)
        model.connectionProgress = ConnectionProgress().after(model.connection)
        if offline {
            let start = Date().addingTimeInterval(-150)
            model.connection = .unreachable
            model.connectionProgress = (0..<3).reduce(model.connectionProgress) { p, i in p.after(.unreachable, at: start.addingTimeInterval(Double(i) * 30)) }
            model.routeReport = (Date().addingTimeInterval(-20), DemoData.routeReport.map { ProbeReport(endpoint: $0.endpoint, outcome: .unreachable("请求超时。"), seconds: 4) })
        }
        return model
    }
}
#endif

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
