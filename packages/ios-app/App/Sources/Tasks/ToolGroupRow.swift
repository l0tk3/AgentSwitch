import AgentSwitchKit
import SwiftUI

/// Tool calls in a row, as one line of the process (control-v0 §5): "读取 3 个文件，运行 5 条命令" (正在… while it is
/// the task's latest work), with how many failed; a tap opens the calls one by one, as ToolCallRow shows them.
struct ToolGroupRow: View {
    let calls: [TaskEvent]
    let results: [String: TaskEvent]
    var active = false
    /// The task still runs and nothing came after these calls.
    var ongoing = false
    @State private var open = ToolCallRow.startOpen

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if let first = calls.first { EventRow.time(first) }
                    summary
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "收起" : "展开以逐条查看")
            if open {
                ForEach(calls) { call in
                    ProcessEventRow(event: call, results: results, active: active)
                }
                .transition(.opacity)
            }
        }
    }

    private var summary: Text {
        let line = Text(ProcessFolding.summary(calls, ongoing: ongoing)).foregroundStyle(.secondary)
        guard failures > 0 else { return line }
        return line + Text("，\(failures) 次失败").foregroundStyle(Theme.failed)
    }

    private var failures: Int {
        calls.filter { call in
            call.payload["error"]?.string != nil || call.payload["id"]?.string.flatMap { results[$0] }?.payload["ok"]?.bool == false
        }.count
    }
}

/// One line of the process: a tool call that opens to its input and result, or any other event.
struct ProcessEventRow: View {
    let event: TaskEvent
    let results: [String: TaskEvent]
    var active = false

    var body: some View {
        if ToolCallRow.opens(event) {
            ToolCallRow(event: event, result: event.payload["id"]?.string.flatMap { results[$0] }, active: active)
        } else {
            EventRow(event: event)
        }
    }
}
