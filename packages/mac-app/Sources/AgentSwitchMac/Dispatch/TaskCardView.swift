import AgentSwitchMacCore
import SwiftUI

/// A task's card (docs/dispatch-v0.md §2, demo `.card`; DispatchTaskCard decides what it shows): the status line —
/// mark, word, agent, model, clock — the title, the progress blocks and the current step while it runs, the outcome
/// said once when it ended, the files it handed back, its actions, and the approvals and questions waiting inside it.
/// A click on its upper part opens the task; right-click is the phone's long-press menu. It glitches once when the task
/// fails while it is on screen; on screen in the window in use, it is read (no longer unread).
struct TaskCardView: View {
    let card: DispatchTaskCard
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    let delete: (DeleteRequest) -> Void
    /// In the record (not on a topic page): its boxes may take ⌘↩ / ⌘⌫.
    var onRecord = true

    static let resultLines = 5

    private var task: DispatchTask { card.task }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open(.task(task.id)) } label: { summary }
                .buttonStyle(.plain)
            if !card.files.isEmpty { files }
            if !card.actions.isEmpty {
                TaskActions(actions: card.actions, task: task, model: model, open: open).padding(.top, 8)
            }
            ForEach(card.approvals) { approval in
                ApprovalBoxView(approval: approval, task: task, step: card.progress?.step, model: model,
                                keys: model.takesKeys(approval.id, onRecord: onRecord),
                                hints: model.takesKeys(approval.id, onRecord: onRecord, typing: false))
                    .padding(.top, 10)
            }
        }
        .padding(EdgeInsets(top: 10, leading: 13, bottom: 11, trailing: 13))
        .background(Look.panel)
        .modifier(HoverFrame())
        .contextMenu { menu }
        .glitch(on: task.status, when: { $0 == .failed })
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            TaskStatusLine(card: card)
            Text(card.title)
                .font(.system(size: 14.5, weight: .semibold))
                .lineSpacing(3)
                .foregroundStyle(Look.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
                .padding(.bottom, 5)
            if let progress = card.progress { ProgressBlocks(progress: progress).padding(.top, 2).padding(.bottom, 6) }
            if let step = card.step { StepLine(text: step) }
            if let summary = card.summary {
                outcome(Text(summary), speaking: model.speaker.isSpeaking(task.id))
            } else if let result = card.result {
                outcome(Text(DispatchMarkdown.flattened(result)), speaking: false)
            }
            if let error = card.error {
                outcome(Text(DispatchMarkdown.flattened(error)), speaking: false, faint: !card.errorIsFailure)
                    .padding(.top, card.summary != nil || card.result != nil ? 4 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// The outcome in the reading font; colour is left to the short words (ui-v0 §7.4, 2026-10-01).
    private func outcome(_ text: Text, speaking: Bool, faint: Bool = false) -> some View {
        text.font(.system(size: 13.5))
            .lineSpacing(4)
            .lineLimit(Self.resultLines)
            .foregroundStyle(speaking ? Color.signal : faint ? Look.ink2 : Look.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var files: some View {
        FlowLayout(spacing: 14, lineSpacing: 6) {
            ForEach(card.files) { file in FileChip(file: file, taskId: task.id, model: model) }
            if card.moreFiles > 0 {
                Button { open(.task(task.id)) } label: { Text("+\(card.moreFiles) Files").mono(12) }
                    .buttonStyle(QuietButtonStyle())
            }
        }
        .padding(.top, 8)
    }

    private var menu: some View {
        RecordMenu(items: DispatchMenuItem.task(task, speaking: model.speaker.isSpeaking(task.id))) { item in
            switch item {
            case .open: open(.task(task.id))
            case .topic: if let id = task.threadId { open(.topic(id)) }
            case .readAloud: model.speaker.toggle(task)
            case .copy: Clipboard.copy(card.title)
            case .delete: delete(.task(task))
            }
        }
    }
}

/// `⠙ Busy ✻ Claude Code · Opus 5.5 … 2m 14s`: mark, word, agent sprite, who, quiet note, clock, unread square.
struct TaskStatusLine: View {
    let card: DispatchTaskCard

    var body: some View {
        HStack(spacing: 8) {
            TaskMark(level: card.level, waiting: card.waiting || card.task.waitsForYou)
            Text(card.statusWord).foregroundStyle(card.level.wordColor)
            AgentSprite(harness: card.task.harness ?? card.task.pin?.harness)
            if let who = card.who { Text(who) }
            if let stale = card.stale { Text("· \(stale)") }
            Spacer(minLength: 8)
            TaskClock(card: card)
            if card.unread { UnreadSquare() }
        }
        .font(.system(size: 11.5, design: .monospaced))
        .foregroundStyle(Look.ink2)
        .lineLimit(1)
    }
}

/// How long it has run (ticking while active) or ran.
struct TaskClock: View {
    let card: DispatchTaskCard

    var body: some View {
        if card.task.status.isActive {
            TimelineView(.periodic(from: .now, by: 1)) { context in Text(card.clock(now: context.date)) }
                .foregroundStyle(Look.faint)
        } else {
            Text(card.clock()).foregroundStyle(Look.faint)
        }
    }
}

/// `└─ 运行 xcodebuild -scheme AgentSwitch`: what a running task is doing now.
struct StepLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("└─").foregroundStyle(Look.faint)
            Text(text).foregroundStyle(Look.ink2).lineLimit(2)
        }
        .font(.system(size: 12, design: .monospaced))
    }
}

/// A file handed back: its mark (hollow on the Mac only, the spinner while it comes, solid once here), name and size;
/// a click downloads and opens it.
struct FileChip: View {
    let file: DispatchTaskFile
    let taskId: String
    let model: DispatchModel

    var body: some View {
        let state = model.fileState(file, taskId: taskId)
        Button { Task { await model.open(file, taskId: taskId) } } label: {
            HStack(spacing: 6) {
                FileMark(state: state)
                Text(file.name).lineLimit(1).truncationMode(.middle)
                Text(state == .remote ? "\(file.sizeText) ↓" : file.sizeText).foregroundStyle(Look.faint)
            }
            .font(.system(size: 12, design: .monospaced))
        }
        .buttonStyle(QuietButtonStyle())
        .help(file.path)
    }
}

struct FileMark: View {
    let state: DispatchFileState

    var body: some View {
        switch state {
        case .remote: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Look.ink2).accessibilityLabel("On the Mac")
        case .downloading: BrailleSpinner()
        case .local: PixelSprite(rows: PixelArt.square, pixel: 2, color: Look.ink2).accessibilityLabel("Downloaded")
        }
    }
}

/// `[ Retry ]` `[ Hand to ▾ ]` (a card's or a page's actions; Cancel and Delete are the page's and confirmed there).
/// While one of them is on its way, the task's buttons wait (one click, one follow-up).
struct TaskActions: View {
    let actions: [DispatchTaskAction]
    let task: DispatchTask
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    var cancel: () -> Void = {}
    var delete: () -> Void = {}
    /// On a task's page, the task a retry or a handoff made opens; on a card it shows up in the record.
    var opensNext = false

    var body: some View {
        HStack(spacing: 14) {
            ForEach(actions, id: \.self) { action in button(action) }
        }
    }

    @ViewBuilder
    private func button(_ action: DispatchTaskAction) -> some View {
        let word = String(action.title.dropFirst(2).dropLast(2))
        let busy = model.isBusy(task)
        switch action {
        case .handTo:
            MenuButton(entries: { handToEntries(model.targets) { target in hand(to: target) } }, help: "Hand to Another Model") {
                BracketLabel(word: word)
            }
            .buttonStyle(BracketButtonStyle())
            .disabled(busy)
        case .retry:
            Button { follow { await model.retry(task) } } label: { BracketLabel(word: word) }
                .buttonStyle(BracketButtonStyle())
                .disabled(busy)
        case .continueRun:
            // Interrupted by a restart: handed on with the choice left to the router (the phone's 继续执行).
            Button { hand(to: nil) } label: { BracketLabel(word: word) }
                .buttonStyle(BracketButtonStyle())
                .disabled(busy)
        case .cancel:
            Button(action: cancel) { BracketLabel(word: word) }.buttonStyle(BracketButtonStyle(role: .destructive))
                .disabled(busy)
        case .delete:
            Button(action: delete) { BracketLabel(word: word) }.buttonStyle(BracketButtonStyle(role: .destructive))
        }
    }

    private func hand(to target: DispatchTarget?) {
        follow { await model.handoff(task, to: target) }
    }

    /// The follow-up a click made: opened on a task's page.
    private func follow(_ make: @escaping @MainActor () async -> DispatchTask?) {
        Task { if let next = await make(), opensNext { open(.task(next.id)) } }
    }
}

/// Rows of items that wrap (a card's files).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + CGFloat(max(rows.count - 1, 0)) * lineSpacing
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !row.items.isEmpty && row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append(index)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
