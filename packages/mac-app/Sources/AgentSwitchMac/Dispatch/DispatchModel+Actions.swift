import AgentSwitchMacCore
import AppKit
import UniformTypeIdentifiers

/// What the Dispatch page does (the phone's AppModel actions): send from the input (files staged first, a pin), answer
/// and approve, cancel, retry, hand on, rate, delete, the topics' rename / archive, and the files.
extension DispatchModel {
    // MARK: sending

    /// Something to send: words or files, within the Mac's length, and nothing still on its way.
    var canSend: Bool {
        service != nil && outgoing == nil && !sending && preparing == 0 && !DispatchLimits.messageTooLong(text)
            && DispatchNewMessage.text(typed: text, hasAttachments: !attachments.isEmpty) != nil
    }

    /// ↩: the input empties at once and the message waits in its box until the Mac answers; a failure stays there with a
    /// resend, which the Mac knows by its client id and answers once.
    func send() async {
        guard canSend, let words = DispatchNewMessage.text(typed: text, hasAttachments: !attachments.isEmpty) else { return }
        outgoing = OutgoingMessage(message: DispatchNewMessage(text: words, pin: pin), files: attachments)
        text = ""
        attachments = []
        pin = nil
        await deliver()
    }

    /// The waiting message again, same client id.
    func resend() async {
        guard let waiting = outgoing, waiting.failure != nil, !sending else { return }
        outgoing = waiting.failing(nil)
        await deliver()
    }

    /// Back into the input to change it (the Mac never got it, or answers the old one only if it is resent).
    func editOutgoing() {
        guard let waiting = outgoing, waiting.failure != nil else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text = waiting.text == DispatchNewMessage.attachmentsOnlyText ? "" : waiting.text
        }
        attachments = waiting.files + attachments
        pin = pin ?? waiting.message.pin
        outgoing = nil
        focusInput()
    }

    private func deliver() async {
        guard let service, var message = outgoing else { return }
        sending = true
        defer { sending = false }
        if message.staged == nil {
            do {
                let ids = message.files.isEmpty ? [] : try await service.upload(message.files.map(\.file)).map(\.id)
                message = message.staging(ids)
                outgoing = message
            } catch {
                return fail("附件上传失败（\(DispatchErrors.text(error))）。")
            }
        }
        do {
            let reply = try await service.send(message.sendable)
            log = log.merging([reply.user, reply.assistant])
            if let task = reply.task { replace(task) }
            outgoing = nil
        } catch {
            if DispatchErrors.isUnreachable(error) {
                fail("未收到 Mac 的响应。重发不会导致重复处理。")
                await refreshConversation()   // it may have arrived: the stored message confirms it
            } else {
                fail(DispatchErrors.text(error))
            }
        }
    }

    private func fail(_ reason: String) {
        outgoing = outgoing?.failing(reason)
    }

    // MARK: attachments

    /// Files from the disk (dropped, `Files…`, pasted from Finder), read off the main thread; what cannot join is said.
    func attach(urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return }
        preparing += 1
        Task {
            let read = await Task.detached(priority: .userInitiated) { files.map(Self.read) }.value
            preparing -= 1
            add(read)
        }
    }

    /// `Paste Image` (⌘V with an image or files on the clipboard).
    func pasteFromClipboard() {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return attach(urls: urls)
        }
        guard let image = Self.pastedImage(board) else { banner = "剪贴板中无图片"; return }
        add([.file(image)])
    }

    /// `Files…`: the system's open panel, several files.
    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        guard panel.runModal() == .OK else { return }
        attach(urls: panel.urls)
    }

    func removeAttachment(_ id: UUID) {
        attachments = attachments.filter { $0.id != id }
    }

    private func add(_ read: [ReadFile]) {
        var problems: [String] = []
        var next = attachments
        for item in read {
            switch item {
            case .unreadable(let name): problems.append("\(name) 无法读取")
            case .tooBig(let name): problems.append("\(name) 超过 50 MB")
            case .file(let file):
                if let problem = DispatchUploadFile.problem(adding: file, to: next.map(\.file)) { problems.append(problem) } else {
                    next.append(PendingFile(file: file))
                }
            }
        }
        attachments = next
        if !problems.isEmpty { banner = problems.joined(separator: "；") }
    }

    /// A file as read from the disk; one over the Mac's limit is refused by its size before it is read.
    enum ReadFile: Sendable {
        case file(DispatchUploadFile)
        case tooBig(String)
        case unreadable(String)
    }

    nonisolated private static func read(_ url: URL) -> ReadFile {
        let name = url.lastPathComponent
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > DispatchUploadFile.maxFileBytes { return .tooBig(name) }
        guard let data = try? Data(contentsOf: url) else { return .unreadable(name) }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return .file(DispatchUploadFile(name: name, type: type, data: data))
    }

    /// An image on the clipboard as PNG (screenshots and copies from Preview come as TIFF or PNG).
    static func pastedImage(_ board: NSPasteboard) -> DispatchUploadFile? {
        if let png = board.data(forType: .png) { return DispatchUploadFile(name: pastedName(), type: "image/png", data: png) }
        guard let image = NSImage(pasteboard: board), let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return DispatchUploadFile(name: pastedName(), type: "image/png", data: png)
    }

    private static func pastedName() -> String {
        let format = DateFormatter()
        format.dateFormat = "yyyyMMdd-HHmmss"
        return "pasted-\(format.string(from: Date())).png"
    }

    // MARK: ciphertexts

    /// `New Ciphertext`: sealed by this Mac's gate, then put into the input at the cursor, unless the sheet was
    /// cancelled meanwhile. The value is dropped either way.
    func seal(_ request: GateSealRequest) async -> String? {
        guard let gate else { return "此处无法生成密文。" }
        let attempt = UUID()
        sealAttempt = attempt
        sealing = true
        // A newer sheet's seal may be on its way: only it says when sealing is over.
        defer { if sealAttempt == nil || sealAttempt == attempt { sealing = false } }
        do {
            let token = try await gate.seal(request)
            guard sealAttempt == attempt else { return nil }
            sealAttempt = nil
            insertRequest = InsertRequest(text: token)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// The sheet is cancelled or closed: a token still being made goes nowhere.
    func cancelSeal() { sealAttempt = nil }

    // MARK: approvals

    func decide(_ approval: DispatchApproval, _ decision: DispatchApprovalDecision) async {
        await respond(to: approval) { try await $0.decide(taskId: approval.taskId, approvalId: approval.id, decision: decision) }
    }

    func answer(_ approval: DispatchApproval, _ answers: [String: [String]]) async {
        await respond(to: approval) { try await $0.answer(taskId: approval.taskId, approvalId: approval.id, answers: answers) }
    }

    func isBusy(_ approval: DispatchApproval) -> Bool { busyApprovals.contains(approval.id) }

    /// One decision or answer at a time per request; one the Mac no longer has (handled elsewhere) is said so, and the
    /// lists are read again either way.
    private func respond(to approval: DispatchApproval, _ body: (any DispatchService) async throws -> Void) async {
        guard let service, !busyApprovals.contains(approval.id) else { return }
        busyApprovals.insert(approval.id)
        defer { busyApprovals.remove(approval.id) }
        do {
            try await body(service)
        } catch let error where DispatchApprovalRefusal.isHandledElsewhere(error) {
            banner = DispatchApprovalRefusal.handledElsewhere
        } catch {
            report(error)
        }
        await refreshAfterAction()
    }

    // MARK: tasks

    func isBusy(_ task: DispatchTask) -> Bool { busyTasks.contains(task.id) }

    func cancel(_ task: DispatchTask) async {
        await working(on: task) { service in self.replace(try await service.cancel(taskId: task.id)) }
    }

    /// `[ Retry ]`: the same request again as a follow-up, on the executor it ran on; the new task, or nil.
    @discardableResult
    func retry(_ task: DispatchTask) async -> DispatchTask? {
        var next: DispatchTask?
        await working(on: task) { service in
            let created = try await service.retry(task)
            self.replace(created)
            next = created
        }
        return next
    }

    /// `[ Hand to ▾ ]`: a follow-up on another executor; nil, and `[ Continue ]` (a task a restart interrupted, as the
    /// phone does): the router picks one.
    @discardableResult
    func handoff(_ task: DispatchTask, to target: DispatchTarget?) async -> DispatchTask? {
        var next: DispatchTask?
        await working(on: task) { service in
            let created = try await service.handoff(taskId: task.id, to: target)
            self.replace(created)
            next = created
        }
        return next
    }

    /// One request at a time per task (a second click while one is on its way does nothing).
    private func working(on task: DispatchTask, _ body: (any DispatchService) async throws -> Void) async {
        guard !busyTasks.contains(task.id) else { return }
        busyTasks.insert(task.id)
        defer { busyTasks.remove(task.id) }
        await act(body)
    }

    func rate(_ task: DispatchTask, _ clicked: Int) async {
        let rating = DispatchTaskPage.nextRating(current: task.rating, clicked: clicked)
        await act { try await $0.rate(taskId: task.id, rating: rating) }
    }

    /// The explicit deletes: nil when done, else what to say.
    func delete(_ request: DeleteRequest) async -> String? {
        guard let service else { return nil }
        do {
            switch request {
            case .entry(let entry):
                try await service.deleteEntry(seq: entry.seq)
                removeTasks(Set(entry.createdTaskIds))
                removeLines(entry.seqs)
                reloadConversation()
            case .task(let task):
                try await service.deleteTask(id: task.id)
                removeTasks([task.id])
                reloadConversation()
            case .topic(let id, _):
                try await service.deleteThread(id: id)
                removeTasks(Set(tasks.filter { $0.threadId == id }.map(\.id)))
                reloadConversation()
                await refreshAll()
            }
            return nil
        } catch {
            return DeleteRequest.message(for: error)
        }
    }

    // MARK: topics

    func renameThread(_ id: String, to title: String) async {
        if let problem = DispatchLimits.topicTitleProblem(title) { banner = problem; return }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        await act { _ = try await $0.renameThread(id: id, title: name.isEmpty ? nil : name) }
    }

    func archiveThread(_ id: String) async -> String? {
        guard let service else { return nil }
        do {
            _ = try await service.archiveThread(id: id)
            await refreshThreads()
            return nil
        } catch {
            return DeleteRequest.message(for: error)
        }
    }

    func reopenThread(_ id: String) async {
        await act { _ = try await $0.reopenThread(id: id) }
    }

    /// One call, then the lists again; a failure goes to the banner.
    private func act(_ body: (any DispatchService) async throws -> Void) async {
        guard let service else { return }
        do {
            try await body(service)
        } catch {
            report(error)
        }
        await refreshAfterAction()
    }

    private func refreshAfterAction() async {
        await refreshTasks()
        await refreshApprovals()
        await refreshThreads()
    }

    // MARK: files

    static func fileKey(_ taskId: String, _ path: String) -> String { "\(taskId)/\(path)" }

    /// The file's mark: coming, here (a copy of the version listed), or on the Mac only.
    func fileState(_ file: DispatchTaskFile, taskId: String) -> DispatchFileState {
        let key = Self.fileKey(taskId, file.path)
        if downloading.contains(key) { return .downloading }
        return copies[key] == file.version ? .local : .remote
    }

    /// Downloads into the app's caches, marked as a download (quarantine), and opens it as DispatchTaskFile.opening
    /// decides: a document in its app; anything that could run only shown in Finder; a web page, SVG or XML as its
    /// source. The copy is downloaded again whenever the Mac lists the file in another version (size, time written).
    func open(_ file: DispatchTaskFile, taskId: String) async {
        guard let service else { return }
        let key = Self.fileKey(taskId, file.path)
        guard !downloading.contains(key) else { return }
        downloading.insert(key)
        defer { downloading.remove(key) }
        do {
            let url = try DispatchFileCache.url(taskId: taskId, path: file.path)
            // The file as the Mac has it now (a card's list may be from long ago); unknown, the copy is not trusted.
            let listed = try? await service.taskFiles(taskId: taskId)
            if let listed { filesChanged(listed, for: taskId) }
            let current = listed?.first { $0.path == file.path }
            if current == nil || copies[key] != current?.version || !FileManager.default.fileExists(atPath: url.path) {
                copies[key] = nil
                try await service.downloadTaskFile(taskId: taskId, path: file.path, to: url)
                // Whichever Mac it came from (DaemonClient marks its own downloads already).
                try DispatchQuarantine.mark(url)
                copies[key] = (current ?? file).version
            }
            show(DispatchTaskFile.opening(file, at: url))
        } catch {
            report(error)
        }
    }

    private func show(_ opening: DispatchFileOpening) {
        switch opening {
        case .source(let url):
            let data = (try? Data(contentsOf: url)) ?? Data()
            sourceFile = SourceFile(url: url, text: String(decoding: data.prefix(SourceFile.maxBytes), as: UTF8.self))
        case .open(let url):
            NSWorkspace.shared.open(url)
        case .reveal(let url):
            NSWorkspace.shared.activateFileViewerSelecting([url])
            banner = "此文件不是可直接打开的文档类型，已在访达中显示。"
        case .ignore:
            banner = "文件不存在，无法打开。"
        }
    }

    #if DEBUG
    /// The demo: a file already downloaded.
    func markLocal(_ file: DispatchTaskFile, taskId: String) { copies[Self.fileKey(taskId, file.path)] = file.version }
    #endif
}

/// Downloads live in Caches/AgentSwitch/dispatch-files/<task>/<path>, emptied when the page first loads.
enum DispatchFileCache {
    static func root() throws -> URL {
        try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AgentSwitch", isDirectory: true)
            .appendingPathComponent("dispatch-files", isDirectory: true)
    }

    static func url(taskId: String, path: String) throws -> URL {
        let url = DispatchTaskFile.cacheURL(root: try root(), taskId: taskId, path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return url
    }

    static func clear() {
        guard let root = try? root() else { return }
        try? FileManager.default.removeItem(at: root)
    }
}

/// A web-type file shown as text (never rendered).
struct SourceFile: Identifiable {
    static let maxBytes = 512 * 1024
    let url: URL
    let text: String
    var id: URL { url }
}
