#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-dispatchProbe <dir>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running service, e.g. an
/// `AGENTSWITCH_ROUTER=echo` daemon with throw-away data): opens the main window's Dispatch page behind every other
/// window (the app is not made active), waits for the record, and writes `record.png`; `-probeTask <id>` also opens that
/// task's page (`task.png`). `-probeCalls YES` then goes through every `DispatchService` call the page and the settings
/// group make against the service — reads, a message sent, a question answered, an approval decided — and writes what
/// came back to `calls.txt`, so the Core's decoding is checked against real responses. Nothing else of the app starts.
@MainActor
enum DispatchProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "dispatchProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        let client = model.client
        model.probeServiceUp()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        MainWindowController.probing = true
        main.show(.dispatch)
        Task {
            try? await Task.sleep(for: .seconds(4))
            shot(main, dir.appendingPathComponent("record.png"))
            if let id = UserDefaults.standard.string(forKey: "probeTask") {
                main.show(task: id)
                try? await Task.sleep(for: .seconds(3))
                shot(main, dir.appendingPathComponent("task.png"))
            }
            if UserDefaults.standard.bool(forKey: "probeCalls") {
                let lines = await calls(client)
                try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("calls.txt"), atomically: true, encoding: .utf8)
                try? await Task.sleep(for: .seconds(7))   // one poll after the writes
                main.show(.dispatch)
                shot(main, dir.appendingPathComponent("record-after.png"))
            }
            exit(0)
        }
    }

    private static func shot(_ main: MainWindowController, _ file: URL) {
        guard let view = main.window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }

    /// Each call once; a line per call: what it returned in brief, or the error.
    private static func calls(_ s: some DispatchService) async -> [String] {
        var out: [String] = []
        func step(_ name: String, _ body: () async throws -> String) async {
            do { out.append("ok   \(name): \(try await body())") } catch { out.append("FAIL \(name): \(error)") }
        }
        await step("messages(last:)") { try await s.messages(last: 50).map { "\($0.seq):\($0.role)/\($0.kind)" }.joined(separator: " ") }
        await step("tasks") { try await s.tasks(limit: 50).map { "\($0.id)=\($0.status.label)" }.joined(separator: " ") }
        await step("approvals") { try await s.approvals().map { "\($0.taskId):\($0.kind)/\($0.status)" }.joined(separator: " ") }
        await step("threads(open)") { try await s.threads(.open, limit: 30).map { "\($0.id):\($0.displayTitle)" }.joined(separator: " | ") }
        await step("targets") { try await s.targets().pinOptions.map(\.label).prefix(6).joined(separator: ", ") }
        // a task that has ended: its event stream ends too (a running one's would follow it)
        if let first = try? await s.tasks(limit: 50).first(where: { $0.status.isTerminal }) {
            await step("task(id:) \(first.id)") { let d = try await s.task(id: first.id); return "\(d.task.status.label), approvals \(d.approvals.count)" }
            await step("taskFiles \(first.id)") { try await s.taskFiles(taskId: first.id).map(\.name).joined(separator: ", ") }
            await step("events \(first.id)") {
                var n = 0
                for try await _ in s.taskEvents(taskId: first.id, after: 0) { n += 1; if n >= 200 { break } }
                return "\(n) events"
            }
        }
        await step("search") { try await s.search(query: "整理", limit: 10).map { $0.taskId }.joined(separator: " ") }
        await step("context") { "\(try await s.context().text.count) chars" }
        await step("contextExample") { "\(try await s.contextExample().count) chars" }
        await step("memory") { "\(try await s.memory().text.count) chars" }
        await step("platformMemory") { "\(try await s.platformMemory().count) rows" }
        await step("mcpServers") { try await s.mcpServers().map(\.name).joined(separator: ", ") }
        await step("skills") { try await s.skills().map(\.name).joined(separator: ", ") }
        await step("discoverSkills") { "\(try await s.discoverSkills().count) found" }
        await step("routingLog") { try await s.routingLog(limit: 10).map { "\($0.id):\($0.source)" }.joined(separator: " ") }
        // writes: a message, the open question answered with its first option, an open approval allowed
        await step("send") {
            let reply = try await s.send(DispatchNewMessage(text: "探针发来的任务 @echo {\"delayMs\":200,\"result\":\"probe ok\"}", clientId: DispatchNewMessage.newClientId()))
            return "user \(reply.user.seq), assistant \(reply.assistant.seq) \(reply.assistant.kind), tasks \(reply.assistant.taskIds), task \(reply.task?.id ?? "-")"
        }
        if let open = try? await s.approvals().filter({ $0.status == .pending }) {
            for a in open {
                if a.kind == .question, case .questions(let evidence) = a.card, let q = evidence.questions.first, let option = q.options.first {
                    await step("answer \(a.taskId)") { try await s.answer(taskId: a.taskId, approvalId: a.id, answers: [q.id: [option.label]]); return option.label }
                } else if a.kind != .question {
                    await step("decide \(a.taskId)") { try await s.decide(taskId: a.taskId, approvalId: a.id, decision: .allow); return "allow" }
                }
            }
        }
        await step("messages(after:)") { try await s.messages(after: 0).count.description }
        return out
    }
}
#endif
