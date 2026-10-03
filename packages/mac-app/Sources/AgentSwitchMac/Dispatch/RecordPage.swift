import AgentSwitchMacCore
import SwiftUI
import UniformTypeIdentifiers

/// The record (docs/dispatch-v0.md §2, the phone's home on a desk): one centred column — the active topics, the loose
/// approvals (only when there are any), the conversation with its tasks oldest first and following new items down, the
/// input at the foot. Files dropped anywhere on it are attachments. Nothing yet: one line.
struct RecordPage: View {
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    @State private var deleting: DeleteRequest?
    @State private var dropping = false
    /// How far the record's end is below the visible part (≤ 0: the end is on screen), the record's height and the
    /// visible height: the record follows its end as it grows (a step line, a box) while the end was on screen.
    @State private var belowEnd: CGFloat = 0
    @State private var recordHeight: CGFloat = 0
    @State private var visibleHeight: CGFloat = 0

    private static let bottom = "bottom"
    private static let space = "record"

    var body: some View {
        let items = model.record
        VStack(spacing: 0) {
            TopicStrip(model: model, open: open)
            LooseApprovalsLine(approvals: DispatchFeed.looseApprovals(model.approvals, record: items), model: model, open: open)
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let banner = model.banner {
                            BannerLine(text: banner) { model.banner = nil }
                        }
                        if model.loaded && items.isEmpty && model.outgoing == nil {
                            Text("发送任务或问题").font(.system(size: 13)).foregroundStyle(Look.ink2)
                                .frame(maxWidth: .infinity, minHeight: 240)
                        }
                        let days = DispatchConversation.dayHeaders(items)
                        ForEach(items) { item in
                            if let day = days[item.id] { DayLabel(text: day) }
                            row(item, items: items)
                        }
                        if let outgoing = model.outgoing { OutgoingBox(message: outgoing, model: model) }
                        Color.clear.frame(height: 1).id(Self.bottom)
                            .background(GeometryReader { g in
                                Color.clear.preference(key: RecordEndKey.self, value: g.frame(in: .named(Self.space)).minY)
                            })
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 20)
                    .dispatchColumn()
                    .background(GeometryReader { g in Color.clear.preference(key: RecordHeightKey.self, value: g.size.height) })
                }
                .coordinateSpace(name: Self.space)
                .defaultScrollAnchor(.bottom)
                .background(GeometryReader { g in
                    Color.clear.onAppear { visibleHeight = g.size.height }.onChange(of: g.size.height) { visibleHeight = $1 }
                })
                .onPreferenceChange(RecordEndKey.self) { y in belowEnd = y - visibleHeight }
                .onPreferenceChange(RecordHeightKey.self) { height in
                    let grew = height - recordHeight
                    recordHeight = height
                    // Either order of the two reports: the end was on screen before it moved down by `grew`.
                    if grew > 0, belowEnd - grew <= 24 { scroller.scrollTo(Self.bottom, anchor: .bottom) }
                }
                // A new message, answer or task, or the message on its way: follow it down.
                .onChange(of: items.last?.id) { scroller.scrollTo(Self.bottom, anchor: .bottom) }
                .onChange(of: model.outgoing?.id) { scroller.scrollTo(Self.bottom, anchor: .bottom) }
                // The first load: at the end once the rows are laid out.
                .onChange(of: model.loaded, initial: true) {
                    guard model.loaded else { return }
                    DispatchQueue.main.async { scroller.scrollTo(Self.bottom, anchor: .bottom) }
                }
            }
            ComposeBar(model: model)
        }
        .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
            Self.load(providers) { urls in model.attach(urls: urls) }
            return true
        }
        .overlay { if dropping { Rectangle().strokeBorder(Color.signal, lineWidth: 1).allowsHitTesting(false) } }
        .deleteConfirmation($deleting, model: model)
    }

    @ViewBuilder
    private func row(_ item: DispatchConversation.Item, items: [DispatchConversation.Item]) -> some View {
        switch item {
        case .user(let message):
            UserBox(text: DispatchMessageDisplay.readable(message.text),
                    attached: DispatchRecordLookup.attachments(of: message, messages: model.log.messages, tasks: model.tasks))
                .contextMenu {
                    RecordMenu(items: DispatchMenuItem.userMessage) { choice in
                        if case .copy = choice { Clipboard.copy(DispatchMessageDisplay.readable(message.text)) }
                        if case .delete = choice { deleting = .entry(model.log.entry(of: message)) }
                    }
                }
        case .assistant(let message, let created):
            AssistantLineView(line: DispatchAssistantLine(message: message, created: created, tasks: model.tasks, approvals: model.approvals),
                              model: model, open: open, delete: { deleting = $0 })
        case .task(let task):
            VStack(alignment: .leading, spacing: 10) {
                UserBox(text: DispatchMessageDisplay.readable(task.task), attached: task.attachments.count)
                TaskCardView(card: model.card(task), model: model, open: open, delete: { deleting = $0 })
            }
        }
    }

    /// The file URLs of a drop, read from their providers.
    static func load(_ providers: [NSItemProvider], then attach: @escaping @MainActor ([URL]) -> Void) {
        Task { @MainActor in
            var urls: [URL] = []
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? URL {
                    urls.append(url)
                } else if let data = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? Data,
                          let url = URL(dataRepresentation: data, relativeTo: nil) {
                    urls.append(url)
                }
            }
            attach(urls)
        }
    }
}

/// Where the record's end is in the visible part (`.infinity`: not laid out, far below).
private struct RecordEndKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

private struct RecordHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Topics that need a look (assistant-v0 §2; DispatchActiveTopics): one chip each, waiting first; a chip opens the topic,
/// or the task itself when it ended unread.
struct TopicStrip: View {
    let model: DispatchModel
    let open: (DispatchRoute) -> Void

    var body: some View {
        let chips = DispatchActiveTopics.items(tasks: model.tasks, approvals: model.approvals, threads: model.threads,
                                               readMarks: model.readMarks)
        if !chips.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(chips) { chip in
                            TopicChip(chip: chip, lastEventAt: model.lastEventAt[chip.task.id],
                                      asks: Self.asks(model.pending(chip.task.id).first, chip: chip)) {
                                open(chip.opensTask ? .task(chip.task.id) : .topic(chip.threadId))
                            }
                        }
                    }
                }
                DottedRule(color: Look.line)
            }
            .padding(.top, 12)
            .dispatchColumn()
        }
    }

    /// What a waiting chip says it waits for: the question, or the kind of action to allow (`Run Command`).
    static func asks(_ approval: DispatchApproval?, chip: DispatchActiveTopic) -> String? {
        guard chip.waiting else { return nil }
        if let approval, approval.kind == .approval { return DispatchApprovalText(approval).tool }
        return chip.question
    }
}

private struct TopicChip: View {
    let chip: DispatchActiveTopic
    let lastEventAt: Int64?
    let asks: String?
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: 8) {
                TaskMark(level: chip.level, waiting: chip.waiting).frame(width: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(chip.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1)
                    state.font(.system(size: 11, design: .monospaced)).lineLimit(1)
                }
                if chip.unread { UnreadSquare() }
            }
            .padding(EdgeInsets(top: 7, leading: 10, bottom: 8, trailing: 12))
            .frame(maxWidth: 230, alignment: .leading)
            .background(Look.panel)
            .overlay(Rectangle().strokeBorder(chip.waiting ? Color.waiting : hovering ? Look.faint : Look.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(chip.question ?? chip.title)
    }

    /// `Waiting · 要删掉吗？` in amber, or `Busy · Opus 5.5`.
    private var state: Text {
        guard chip.waiting else { return Text(chip.stateLine(lastEventAt: lastEventAt)).foregroundStyle(Look.ink2) }
        let word = Text(chip.stateLine()).foregroundStyle(Color.waiting)
        guard let asks else { return word }
        return word + Text(" · \(asks)").foregroundStyle(Look.ink2)
    }
}

/// Approvals whose task has no card in the record, behind one line (`■ 2 Waiting ›`): one opens its task; several are
/// listed in a menu.
private struct LooseApprovalsLine: View {
    let approvals: [DispatchApproval]
    let model: DispatchModel
    let open: (DispatchRoute) -> Void

    var body: some View {
        if !approvals.isEmpty {
            let label = HStack(spacing: 8) {
                BlinkingSquare()
                Text(DispatchFeed.looseLabel(approvals.count))
                Text("›")
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Color.waiting)
            Group {
                if approvals.count == 1, let first = approvals.first {
                    Button { open(.task(first.taskId)) } label: { label }.buttonStyle(.plain)
                } else {
                    MenuButton(entries: { entries }, help: "Waiting for You") { label }.buttonStyle(.plain)
                }
            }
            .padding(.top, 8)
            .dispatchColumn()
        }
    }

    private var entries: [MenuEntry] {
        approvals.map { approval in
            let title = model.task(approval.taskId).map(model.title(of:)) ?? approval.taskId
            return MenuEntry(title: "\(title) — \(DispatchText.clip(DispatchMessageDisplay.readable(approval.waitingLine), 40))",
                             symbol: "arrow.up.right.square", action: { open(.task(approval.taskId)) })
        }
    }
}

extension View {
    /// The one confirmation every delete goes through; `done` gets what was deleted, after it was.
    func deleteConfirmation(_ request: Binding<DeleteRequest?>, model: DispatchModel,
                            done: @escaping (DeleteRequest) -> Void = { _ in }) -> some View {
        confirmationDialog(request.wrappedValue?.question ?? "", isPresented: Binding(get: { request.wrappedValue != nil },
                                                                                     set: { if !$0 { request.wrappedValue = nil } }),
                           titleVisibility: .visible, presenting: request.wrappedValue) { pending in
            Button(pending.action, role: .destructive) {
                Task {
                    if let problem = await model.delete(pending) { model.banner = problem } else { done(pending) }
                }
            }
        } message: { pending in
            Text(pending.detail)
        }
    }
}
