import AgentSwitchKit
import SwiftUI

/// A tool call in the process list (2026-09-25, like Claude's own remote view): one line — the tool as a verb and what
/// it works on — that opens to the input field by field and what came back. The result is the `tool_result` event
/// with the same id (Claude, Codex) or the call's own `output` (OpenCode, which reports a call once it finished).
struct ToolCallRow: View {
    let event: TaskEvent
    let result: TaskEvent?
    /// The task still runs: a call without a result is still going.
    var active = false
    @State private var open = ToolCallRow.startOpen

    /// Debug builds with `-uiDemoOpenTools YES`: every call (and every fold of calls) open, for looking at the screen
    /// (docs/ui-v0.md §5).
    static var startOpen: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "uiDemoOpenTools")
        #else
        return false
        #endif
    }

    /// A call with something to show: its input or command (not a refused one, not an old bare count).
    static func opens(_ event: TaskEvent) -> Bool {
        event.type == "tool_call" && event.payload["denied"] == nil && (event.payload["input"] != nil || event.payload["command"]?.string != nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    EventRow.time(event)
                    Text(MessageDisplay.readable(EventDescriber.line(event)))
                        .font(.footnote)
                        .foregroundStyle(failed ? Theme.failed : .secondary)
                        .lineLimit(open ? nil : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    // ▸ / ▾ mean folded / open, as the system uses them (§7.2.6).
                    LookGlyph.fold(open: open).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "收起" : "展开以查看输入和结果")
            if open {
                details.padding(.leading, EventRow.timeWidth + 10)
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                Field(name: Self.name(field.name), value: MessageDisplay.readable(field.value))
            }
            Field(name: outcome.title, value: outcome.text, tint: failed ? Theme.failed : nil, faint: outcome.faint)
        }
        .padding(Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        .transition(.opacity)
    }

    private var fields: [(name: String, value: String)] {
        let input = ToolDisplay.fields(event.payload["input"])
        if !input.isEmpty { return input }
        return event.payload["command"]?.string.map { [("Command", EventDescriber.unwrapShell($0))] } ?? []
    }

    private var failed: Bool {
        result?.payload["ok"]?.bool == false || event.payload["error"]?.string != nil
    }

    private var outcome: (title: String, text: String, faint: Bool) {
        if let error = event.payload["error"]?.string { return ("Error", MessageDisplay.readable(error), false) }
        let output = result?.payload["output"]?.string ?? event.payload["output"]?.string
        if let output { return (failed ? "Result · Failed" : "Result", output.isEmpty ? "No Output" : MessageDisplay.readable(output), output.isEmpty) }
        return ("Result", active ? "Busy" : "None", true)
    }

    /// Input keys as words; unknown ones stay as the tool named them.
    static func name(_ key: String) -> String {
        names[key] ?? key
    }

    private static let names = [
        // Short words in English (docs/ui-v0.md §7.2.7), the tools' own names where they read well.
        "command": "Command", "description": "About", "file_path": "File", "filePath": "File", "notebook_path": "File", "path": "Path",
        "url": "URL", "pattern": "Pattern", "query": "Query", "element": "Element", "ref": "Ref", "text": "Text", "timeout": "Timeout",
        "content": "Content", "old_string": "Old", "new_string": "New", "replace_all": "Replace All", "offset": "From Line",
        "limit": "Lines", "glob": "Files", "output_mode": "Output", "prompt": "Prompt", "subagent_type": "Agent Type",
        "files": "Files", "key": "Key", "values": "Values", "time": "Time", "filename": "File", "skill": "Skill",
    ]
}

/// One labelled value of an opened call.
private struct Field: View {
    let name: String
    let value: String
    var tint: Color?
    var faint = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name).font(.caption2.weight(.medium)).foregroundStyle(tint ?? .secondary)
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(faint ? AnyShapeStyle(.tertiary) : AnyShapeStyle(tint ?? .primary))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
