import Foundation

// Small pieces of the Dispatch page's words that the record and the task page share (docs/dispatch-v0.md §2, demo
// `mac-window.html`): an approval box's head and body, the "N attached" under what you said, and the request a task
// page starts with.

/// An approval box (`[!] Approval · Run Command`, the command, what it is for), from the approval's action and evidence,
/// as the web console's terminal page words it (daemon api/live.ts `splitAction`, ui/terminal.js `TOOL_WORDS`).
public struct DispatchApprovalText: Sendable, Hashable {
    /// The head's right side: `Run Command`, `Edit File`, or the tool's own name.
    public let tool: String
    /// The body: what it runs or touches (`xcrun devicectl …`), else the whole action.
    public let target: String
    /// What the executor says it is for (the tool input's `description`), when it says.
    public let about: String?

    public init(_ approval: DispatchApproval) {
        let (tool, target) = Self.split(approval.action)
        self.tool = Self.word(tool)
        self.target = DispatchMessageDisplay.readable(target.isEmpty ? approval.action : target)
        about = Self.about(approval.evidence)
    }

    /// `Bash: npm test` → (`Bash`, `npm test`); Codex's request methods name the kind of tool.
    public static func split(_ action: String) -> (tool: String, target: String) {
        guard let at = action.range(of: ": ") else { return (action.trimmingCharacters(in: .whitespaces), "") }
        let head = String(action[..<at.lowerBound])
        let tool = head.range(of: "commandExecution|execCommand", options: .regularExpression) != nil ? "Bash"
            : head.range(of: "fileChange|applyPatch", options: .regularExpression) != nil ? "Edit" : head
        return (tool, String(action[at.upperBound...]).trimmingCharacters(in: .whitespaces))
    }

    /// The tool as a short title-case phrase (ui-v0 §7.2.7); an unknown tool keeps its name.
    public static func word(_ tool: String) -> String {
        words[tool] ?? words[tool.lowercased()] ?? tool
    }

    private static let words = [
        "Write": "Write File", "write": "Write File", "Edit": "Edit File", "MultiEdit": "Edit File", "edit": "Edit File",
        "NotebookEdit": "Edit Notebook", "Bash": "Run Command", "bash": "Run Command", "shell": "Run Command",
        "WebFetch": "Fetch Page", "webfetch": "Fetch Page", "WebSearch": "Search Web", "websearch": "Search Web",
    ]

    /// The tool input's `description`, one line.
    static func about(_ evidence: String) -> String? {
        guard let data = evidence.data(using: .utf8), let input = try? JSONDecoder().decode(DispatchJSON.self, from: data),
              let text = input["description"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return DispatchText.clip(DispatchMessageDisplay.readable(text), 60)
    }
}

/// What you said and what came of it, looked up across the record.
public enum DispatchRecordLookup {
    /// The files sent with a message: those of the tasks its answers created (`1 attached` under the box).
    public static func attachments(of message: DispatchMessage, messages: [DispatchMessage], tasks: [DispatchTask]) -> Int {
        guard message.role == .user else { return 0 }
        let created = Set(messages.filter { $0.replyTo == message.seq && $0.createdTasks }.flatMap(\.taskIds))
        return tasks.filter { created.contains($0.id) }.reduce(0) { $0 + $1.attachments.count }
    }

    /// The words a task page starts with: what you said when an answer to it created the task, else the task's own
    /// request (made elsewhere, or a handoff).
    public static func request(of task: DispatchTask, messages: [DispatchMessage]) -> String {
        if let answer = messages.first(where: { $0.createdTasks && $0.taskIds.contains(task.id) }), let root = answer.replyTo,
           let said = messages.first(where: { $0.seq == root && $0.role == .user }) {
            return DispatchMessageDisplay.readable(said.text)
        }
        return DispatchMessageDisplay.readable(task.task)
    }
}
