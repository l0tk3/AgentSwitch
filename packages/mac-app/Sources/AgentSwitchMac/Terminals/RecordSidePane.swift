import AgentSwitchMacCore
import SwiftUI

// Beside the record in a pane's simple view (docs/simple-view-v0.md §5.2 “宽的时候”): where the pane has the room, what
// the phone folds away is laid out next to the record instead of leaving the window's sides empty — how full the
// agent's context is, its task list, and the files its work changed, each opening into its diff.

struct RecordSidePane: View {
    let record: PaneRecord
    let files: [RecordChangedFile]
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var record = record
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let meter = RecordDisplay.contextMeter(record.usage) { context(meter) }
                if let line = RecordDisplay.plan(record.plan) {
                    VStack(alignment: .leading, spacing: 7) {
                        title("Tasks \(line.done)/\(line.total)")
                        RecordPlanRows(plan: record.plan, size: 12.5)
                    }
                }
                if !files.isEmpty { changes }
            }
            .padding(.horizontal, 16).padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Look.ground)
    }

    private func title(_ text: String) -> some View {
        Text(text).mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink)
    }

    private func context(_ meter: (part: Double, words: String)) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                title("Context")
                Spacer(minLength: 4)
                Text(meter.words).mono(Look.size(11, look)).foregroundStyle(Look.ink2)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Look.code)
                    Rectangle().fill(Look.ink2).frame(width: max(2, geo.size.width * meter.part))
                }
            }
            .frame(height: 4)
            .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 2 : 0))
        }
    }

    private var changes: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                title("Changes")
                RecordDiffStat(added: files.reduce(0) { $0 + $1.added }, removed: files.reduce(0) { $0 + $1.removed }, plain: true)
                Spacer(minLength: 4)
                Text(files.count == 1 ? "1 file" : "\(files.count) files").mono(Look.size(11, look)).foregroundStyle(Look.faint)
            }
            .padding(.bottom, 4)
            ForEach(files) { file in
                let open = record.openFiles.contains(file.path)
                Button { if open { record.openFiles.remove(file.path) } else { record.openFiles.insert(file.path) } } label: {
                    HStack(spacing: 6) {
                        RecordFold(open: open)
                        Text(file.name).font(.system(size: Look.size(12, look), weight: .medium, design: .monospaced)).foregroundStyle(Look.ink).lineLimit(1).layoutPriority(1)
                        Text(file.folder).font(.system(size: Look.size(11, look), design: .monospaced)).foregroundStyle(Look.faint).lineLimit(1).truncationMode(.head)
                        Spacer(minLength: 4)
                        RecordDiffStat(added: file.added, removed: file.removed, plain: true)
                    }
                    .padding(.vertical, 3)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(file.path)
                if open { diff(file) }
            }
        }
    }

    /// The file as its latest run of work left it changed; asked for when opened, and again when that run changes it more.
    @ViewBuilder private func diff(_ file: RecordChangedFile) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let all = record.diffs[file.work] {
                if let found = all.first(where: { $0.path == file.path }) {
                    RecordFileDiff(file: found, header: false)
                    if file.runs > 1 { Text("最近一次的改动；这个文件一共改了 \(file.runs) 次。").font(.system(size: Look.size(11, look))).foregroundStyle(Look.faint) }
                } else {
                    Text("没有记录到这次改动的内容。").font(.system(size: Look.size(11.5, look))).foregroundStyle(Look.faint)
                }
            } else {
                BrailleSpinner().foregroundStyle(Look.ink2).frame(maxWidth: .infinity).padding(.vertical, 8)
            }
        }
        .padding(.leading, 17).padding(.bottom, 6)
        .task(id: "\(file.work)/\(file.added)/\(file.removed)") { await record.loadChanges(work: file.work) }
    }
}

/// The agent's task list, one on a line: done, the one it is on, and what is left.
struct RecordPlanRows: View {
    @Environment(\.interfaceLook) private var look
    let plan: [PlanEntry]
    var size: CGFloat = 12

    var body: some View {
        ForEach(Array(plan.enumerated()), id: \.offset) { _, entry in
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(entry.state == .done ? "[x]" : entry.state == .doing ? "[>]" : "[ ]").mono(Look.size(11, look))
                    .foregroundStyle(entry.state == .doing ? Color.busy : entry.state == .done ? Color.ok : Look.faint)
                Text(entry.text).font(.system(size: size)).foregroundStyle(entry.state == .done ? Look.ink2 : Look.ink)
                    .strikethrough(entry.state == .done, color: Look.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
