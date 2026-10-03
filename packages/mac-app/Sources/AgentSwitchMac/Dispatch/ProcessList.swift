import AgentSwitchMacCore
import SwiftUI

/// A task page's `// Process` (control-v0 §5; DispatchProcess): every event, oldest first, one line each. A tool call is
/// its verb and object (`运行 xcodebuild …`) with its mark and time, opening to its input field by field and what came
/// back; calls in a row fold into one line (`读取 3 个文件，运行 5 条命令`) that opens to them; a finished task ends with how
/// long it took.
struct ProcessList: View {
    let events: [DispatchTaskEvent]
    let task: DispatchTask?
    var live = false

    var body: some View {
        let active = task?.status.isActive ?? false
        let results = DispatchProcess.results(events)
        let items = DispatchProcess.items(events)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                PartLabel("Process")
                Spacer()
                if live {
                    BrailleSpinner()
                    Text("Live").mono(11).foregroundStyle(Color.busy)
                }
            }
            if items.isEmpty {
                Text(live ? "暂无记录" : "无记录").font(.system(size: 12)).foregroundStyle(Look.faint)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(items) { item in
                    switch item {
                    case .event(let event):
                        if DispatchToolCall.opens(event) {
                            ProcessToolRow(call: DispatchToolCall(event: event, results: results), active: active)
                        } else {
                            ProcessEventRow(event: event)
                        }
                    case .tools(let calls):
                        ProcessFoldRow(calls: calls, results: results, active: active,
                                    ongoing: DispatchProcess.isOngoing(item, in: items, taskActive: active))
                    }
                }
            }
            if let task, let line = DispatchTaskDuration.line(task, events: events) {
                Text(line).font(.system(size: 11.5)).foregroundStyle(Look.faint).padding(.leading, 24)
            }
        }
    }
}

/// The columns of a process row: mark, line, time, ▸ / ▾.
private struct ProcessRowFrame<Mark: View, Line: View>: View {
    var time: String?
    var opens = false
    var open = false
    @ViewBuilder let mark: Mark
    @ViewBuilder let line: Line
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark.frame(width: 14, alignment: .leading)
            line.frame(maxWidth: .infinity, alignment: .leading)
            if let time { Text(time).font(.system(size: 11, design: .monospaced)).foregroundStyle(Look.faint) }
            Text(opens ? (open ? "▾" : "▸") : "").font(.system(size: 11, design: .monospaced)).foregroundStyle(Look.faint)
                .frame(width: 12)
        }
        .padding(.vertical, 6)
        .padding(.trailing, 4)
        .background(hovering && opens ? Look.hover : .clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// One tool call: a click opens its input and result.
struct ProcessToolRow: View {
    let call: DispatchToolCall
    let active: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProcessRowFrame(time: call.duration, opens: true, open: open) {
                StatusMark(level: call.level(taskActive: active))
            } line: {
                Text(call.line)
                    .font(.system(size: 13))
                    .foregroundStyle(call.failed ? Color.failed : Look.ink)
                    .lineLimit(open ? nil : 1)
                    .truncationMode(.tail)
            }
            .onTapGesture { open.toggle() }
            .help(call.event.date.formatted(date: .omitted, time: .standard))
            if open { details }
        }
    }

    /// Field by field, then what came back: the demo's `pre` with a rule on its left.
    private var details: some View {
        let outcome = call.outcome(taskActive: active)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(call.fields.enumerated()), id: \.offset) { _, field in
                ProcessToolField(name: field.name, value: field.value)
            }
            ProcessToolField(name: outcome.title, value: outcome.text, tint: call.failed ? .failed : nil, faint: outcome.faint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(alignment: .leading) { Rectangle().fill(Look.faint).frame(width: 1) }
        .padding(.leading, 24)
        .padding(.bottom, 6)
    }
}

private struct ProcessToolField: View {
    let name: String
    let value: String
    var tint: Color?
    var faint = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.system(size: 11, design: .monospaced)).foregroundStyle(tint ?? Look.faint)
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .lineSpacing(3)
                .foregroundStyle(faint ? Look.faint : tint ?? Look.ink2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Calls in a row as one line; a click opens them one by one.
struct ProcessFoldRow: View {
    let calls: [DispatchTaskEvent]
    let results: [String: DispatchTaskEvent]
    let active: Bool
    let ongoing: Bool
    @State private var open = false

    var body: some View {
        let failures = DispatchProcess.failures(calls, results: results)
        VStack(alignment: .leading, spacing: 0) {
            ProcessRowFrame(opens: true, open: open) {
                StatusMark(level: ongoing ? .busy : failures > 0 ? .error : .ok)
            } line: {
                (Text(DispatchProcess.summary(calls, ongoing: ongoing)).foregroundStyle(Look.ink)
                    + Text(failures > 0 ? "，\(failures) 次失败" : "").foregroundStyle(Color.failed))
                    .font(.system(size: 13))
                    .lineLimit(1)
            }
            .onTapGesture { open.toggle() }
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(calls) { call in ProcessToolRow(call: DispatchToolCall(event: call, results: results), active: active) }
                }
                .padding(.leading, 24)
            }
        }
    }
}

/// Any other event: the daemon's line (the model's own text as Markdown), coloured by its tone only for the attention,
/// success and failure lines.
struct ProcessEventRow: View {
    let event: DispatchTaskEvent

    var body: some View {
        ProcessRowFrame {
            Text("")
        } line: {
            Text(DispatchProcess.isMarkdown(event) ? DispatchMarkdown.flattened(DispatchEventDescriber.line(event)).codeWashed()
                 : AttributedString(DispatchEventDescriber.line(event)))
                .font(.system(size: event.type == "text" ? 13 : 12.5))
                .lineSpacing(3)
                .foregroundStyle(color)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .help(event.date.formatted(date: .omitted, time: .standard))
    }

    private var color: Color {
        switch DispatchEventDescriber.tone(event) {
        case .normal: return Look.ink
        case .muted: return Look.ink2
        case .attention: return .waiting
        case .success: return .ok
        case .failure: return .failed
        }
    }
}
