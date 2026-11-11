import AgentSwitchMacCore
import AppKit
import SwiftUI

// The sub-agent card (docs/simple-view-v0.md §5.22, 2026-11-10; user: 当产生子代理的时候点击相关的条目，我看不到子代理的
// 对话内容，我希望也能查看，不过它可以用小视图而不是完整视图): a small view by the edge of a terminal's pane — over its screen
// or its record alike — with what one of the session's sub-agents is doing: what it was sent to do, its answers, each
// run of work on a line (the run still going with its latest steps under it), and at its end what it handed back.
// Read only: nothing is said to a sub-agent from here. A floating box as the page's other ones are (ui-v0 §7.3): a
// 1 px ink frame and the dithered hard shadow in the pixel look, a round card with a soft shadow in the classic one;
// its head reads as a pane's does — the state's mark, the name, its kind, how long.

struct SubagentCard: View {
    let card: SubagentCardModel
    /// The terminal's sub-agents at work now, as its list or its record's stream says.
    let live: [TerminalSubagent]
    /// The terminal's program runs.
    let terminalRuns: Bool
    let close: () -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.onScreen) private var onScreen
    /// The reader is at the record's end: `↓ Latest` is away, and the record is followed.
    @State private var atEnd = true
    @State private var place = SubagentCardPlace()

    private static let end = "end"
    private static let space = "subagent-card"
    private static let inside = "subagent-card-record"

    /// What the record is read for: another sub-agent, or the card seen again, starts the reading over.
    private struct Following: Hashable {
        let target: SubagentTarget
        let seen: Bool
    }

    var body: some View {
        // The clock in the head, and whether it still counts as at work, by the second — while it is seen.
        Stepped(every: onScreen ? 1 : 3600) { at in
            let mine = live.first { $0.id == card.target.agent }
            let state = SubagentDisplay.state(done: card.agent?.done ?? false, live: mine != nil, terminalRuns: terminalRuns, updatedAt: card.agent?.updatedAt, now: at)
            VStack(spacing: 0) {
                head(state, now: at)
                HairRule(color: Look.line)
                record(state, doing: mine?.doing ?? "")
            }
        }
        .background(look.isClassic ? Look.panel : Look.ground)
        .modifier(SubagentCardChrome())
        // Opened by the reader's own click, and again for each sub-agent they choose: one burst, as the page's other
        // boxes answer (ui-v0 §7.2.9; none in the classic look). The reading is outside it: a burst draws its box twice.
        .glitch(on: card.target, onAppear: { true })
        .task(id: Following(target: card.target, seen: onScreen)) { if onScreen { await card.follow() } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sub-Agent \(card.title)")
    }

    // MARK: the head

    private func head(_ state: SubagentDisplay.State, now: Date) -> some View {
        HStack(spacing: 8) {
            mark(state)
            Text(card.title)
                .font(look.isClassic ? .system(size: 12.5, weight: .semibold) : .system(size: 12.5, weight: .bold, design: .monospaced))
                .foregroundStyle(Look.ink).lineLimit(1).truncationMode(.tail)
                .help(card.title)
            if let kind = card.kind {
                Text(kind).mono(11).foregroundStyle(Look.faint).lineLimit(1).layoutPriority(-1)
            }
            Spacer(minLength: 4)
            Text(words(state, now: now)).mono(11).foregroundStyle(Look.ink2).monospacedDigit().lineLimit(1).fixedSize()
            choices
            HStack(spacing: 0) {
                HeadButton(help: card.tall ? "Small View" : "Tall View") { card.tall.toggle() } label: {
                    if look.isClassic { Image(systemName: card.tall ? "rectangle.compress.vertical" : "rectangle.expand.vertical").font(.system(size: 11, weight: .medium)) }
                    else { Text(card.tall ? "Small" : "Tall").font(.system(size: 11, design: .monospaced)).padding(.horizontal, 4) }
                }
                HeadButton(help: "Close", action: close) {
                    LookGlyph(glyph: "×", symbol: "xmark", size: look.isClassic ? 11.5 : 13)
                }
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 3)
        .frame(height: look.isClassic ? 30 : 26)
        .contentShape(Rectangle())
        // As a pane's header: a double click makes it the other size.
        .onTapGesture(count: 2) { card.tall.toggle() }
    }

    @ViewBuilder
    private func mark(_ state: SubagentDisplay.State) -> some View {
        switch state {
        case .working: BrailleSpinner(size: 12)
        case .done: StatusMark(level: .ok)
        case .quiet: StatusMark(level: .off)
        }
    }

    /// `0:41` while it works (the spinner says that it does), `Done · 2m 05s`, or when it last wrote.
    private func words(_ state: SubagentDisplay.State, now: Date) -> String {
        switch state {
        case .working:
            guard let began = card.agent?.startedAt, began > 0 else { return "" }
            return RecordDisplay.clock(Int(now.timeIntervalSince1970 - Double(began) / 1000))
        case .done:
            return SubagentDisplay.doneWords(card.agent)
        case .quiet:
            guard let wrote = card.agent?.updatedAt, wrote > 0 else { return "" }
            return TerminalListText.age(since: wrote, now: now, classic: look.isClassic)
        }
    }

    /// The session's other sub-agents: `2/5 ▾`, a menu of them — the one shown checked.
    @ViewBuilder
    private var choices: some View {
        let all = SubagentDisplay.choices(kept: card.others, live: live)
        if all.count > 1 {
            // Its place among them; one that is not listed (older than the menu goes back) has none to say.
            let at = all.firstIndex { $0.id == card.target.agent }.map { "\($0 + 1)/\(all.count)" } ?? "\(all.count)"
            MenuButton(entries: {
                all.map { choice in
                    MenuEntry(title: choice.words, checked: choice.id == card.target.agent, action: { card.show(agent: choice.id, name: choice.name, type: choice.type) })
                }
            }, help: "Sub-Agents of This Session") {
                HStack(spacing: 3) {
                    Text(at).mono(11).monospacedDigit()
                    LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                }
                .foregroundStyle(Look.ink2)
                .padding(.horizontal, 4)
                .frame(height: 20)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: the record

    private func record(_ state: SubagentDisplay.State, doing: String) -> some View {
        let working = state == .working
        let source = card.source
        return GeometryReader { box in ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 11) {
                    if card.more {
                        Button { card.earlier() } label: {
                            HStack(spacing: 6) {
                                if card.loadingEarlier { BrailleSpinner() }
                                Text("Earlier").mono(Look.size(11.5, look), weight: .medium)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain).foregroundStyle(Color.signal)
                    }
                    if let problem = card.problem {
                        Text(problem).font(.system(size: Look.size(12, look))).foregroundStyle(Look.ink2).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    } else if !card.loaded {
                        BrailleSpinner().frame(maxWidth: .infinity).padding(.top, 14)
                    } else if card.items.isEmpty {
                        Text(SubagentDisplay.empty).font(.system(size: Look.size(12, look))).foregroundStyle(Look.faint)
                    }
                    ForEach(card.items) { item in
                        SubagentCardRow(item: item, running: working && item.id == card.items.last?.id && item.kind == .work, card: card, source: source,
                                        own: { place.own = Date() })
                    }
                    // At work on something the record does not hold yet (it is thinking, or its step is being written).
                    if working, card.problem == nil, card.loaded, card.items.last?.kind != .work {
                        Text(doing.isEmpty ? "Working" : doing).mono(Look.size(11.5, look), weight: .medium).foregroundStyle(Look.ink2).lineLimit(1).shimmer()
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                        .background(GeometryReader { g in
                            Color.clear.preference(key: SubagentCardEndEdge.self, value: [g.frame(in: .named(Self.space)).maxY, g.frame(in: .named(Self.inside)).maxY])
                        })
                }
                .coordinateSpace(name: Self.inside)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)
                // A record shorter than the card begins at the card's top (anchored at its end alone, it stood at
                // the foot of an empty card).
                .frame(maxWidth: .infinity, minHeight: box.size.height, alignment: .topLeading)
            }
            // The end is what matters: there when it opens, and followed while the reader is there.
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: Self.space)
            .background(GeometryReader { g in Color.clear.preference(key: SubagentCardFootEdge.self, value: g.size.height) })
            .onChange(of: card.target) { place = SubagentCardPlace(); atEnd = true }
            .onChange(of: card.loaded) { scroller.scrollTo(Self.end, anchor: .bottom) }
            .onPreferenceChange(SubagentCardEndEdge.self) { edge in
                guard edge.count == 2 else { return }
                if laidOut(end: edge[0], length: edge[1]) { scroller.scrollTo(Self.end, anchor: .bottom) }
            }
            .onPreferenceChange(SubagentCardFootEdge.self) { if laidOut(foot: $0) { scroller.scrollTo(Self.end, anchor: .bottom) } }
            .overlay(alignment: .bottom) {
                if !atEnd {
                    Button { withAnimation(.snappy(duration: 0.2)) { scroller.scrollTo(Self.end, anchor: .bottom) } } label: {
                        Text("↓ Latest").mono(Look.size(11, look), weight: .medium).foregroundStyle(Look.ink)
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .grounded(look.isClassic ? Look.raised : Look.panel, radius: look.isClassic ? 12 : 0)
                            .framed(Look.line, radius: look.isClassic ? 12 : 0)
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .padding(.bottom, 7)
                }
            }
        } }
    }

    /// The end or the card's foot laid out anew: whether the reader is at the end now, and (true) whether the record
    /// is to be put at its end — as a pane's record follows its own (`RecordEnd`).
    private func laidOut(end: CGFloat? = nil, length: CGFloat? = nil, foot: CGFloat? = nil) -> Bool {
        // A part the reader opened a moment ago is their own doing: once.
        let own = place.own.map { Date().timeIntervalSince($0) < 0.5 } ?? false
        if own, length != nil { place.own = nil }
        let follow = place.end.laidOut(end: end.map(Double.init), length: length.map(Double.init), foot: foot.map(Double.init), own: own)
        if atEnd != place.end.atEnd { atEnd = place.end.atEnd }
        return follow
    }
}

/// Where a card's record is as last laid out; out of the view's state, which a scroll would otherwise change on
/// every frame.
private final class SubagentCardPlace {
    var end = RecordEnd()
    /// When the reader last opened or closed a part of the record.
    var own: Date?
}

/// The record's end: its place in the card, and in the record (how long the record is). Empty: not laid out.
private struct SubagentCardEndEdge: PreferenceKey {
    static let defaultValue: [CGFloat] = []
    static func reduce(value: inout [CGFloat], nextValue: () -> [CGFloat]) { if value.isEmpty { value = nextValue() } }
}

/// How high the card's record is drawn: its end is on screen above this (`.infinity`: not laid out).
private struct SubagentCardFootEdge: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = min(value, nextValue()) }
}

/// A floating box's frame and shadow by the look (ui-v0 §7.3, §8).
private struct SubagentCardChrome: ViewModifier {
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            let shape = RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous)
            content.clipShape(shape).overlay(shape.strokeBorder(Look.line, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.22), radius: 12, y: 5)
        } else {
            content.overlay(Rectangle().strokeBorder(Look.ink, lineWidth: 1))
                .background(Checker().offset(x: 6, y: 6))
        }
    }
}

/// One of the head's buttons: quiet, lit under the pointer.
private struct HeadButton<Label: View>: View {
    let help: String
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(hovering ? Look.ink : Look.ink2)
                .frame(minWidth: 22, minHeight: 20)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0).fill(hovering ? Look.ink.opacity(look.isClassic ? 0.08 : 0.14) : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

/// One item of a sub-agent's record, small: what it was sent to do, an answer, a run of work, a note.
private struct SubagentCardRow: View {
    let item: RecordItem
    /// The run of work still going.
    let running: Bool
    let card: SubagentCardModel
    let source: RecordSource
    /// The reader is opening or closing a part of it: the record's length changes by their doing.
    let own: () -> Void
    @State private var whole = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch item.kind {
        case .user: task
        case .answer: answer
        case .work: work
        case .note: Text(item.text).mono(Look.size(10.5, look)).foregroundStyle(Look.faint).frame(maxWidth: .infinity)
        }
    }

    /// What it was sent to do (and anything said to it since): the agent's words to it, not yours — on the left, under
    /// its label.
    private var task: some View {
        let head = whole ? nil : SubagentDisplay.taskPreview(item.text)
        return VStack(alignment: .leading, spacing: 4) {
            PartLabel("Task")
            TypedText(text: head ?? item.text, size: Look.size(12.5, look), lineSpacing: 4)
                .foregroundStyle(Look.ink.opacity(0.85))
                .frame(maxWidth: .infinity, alignment: .leading)
            if head != nil { more }
        }
    }

    private var answer: some View {
        let head = whole ? nil : SubagentDisplay.answerPreview(item.text)
        return VStack(alignment: .leading, spacing: 5) {
            // What it thought on the way reads quieter than what it has to say.
            MarkdownBlocks(text: head ?? item.text, size: Look.size(12.5, look), color: item.thinking ? Look.ink2 : Look.ink, lineSpacing: 4, blockSpacing: 7)
            if head != nil { more }
            else if item.clipped { Text("这条回答很长，只读入了开头。").font(.system(size: Look.size(11, look))).foregroundStyle(Look.faint) }
        }
    }

    private var more: some View {
        Button { own(); whole = true } label: { Text("Show More").mono(Look.size(11.5, look), weight: .medium) }
            .buttonStyle(.plain).foregroundStyle(Color.signal)
    }

    /// A run of work: one line (`Worked 52s · Web 12 · Read 1`); the one still going with its latest steps under it,
    /// any of them opened with all of its steps.
    private var work: some View {
        let fold = SubagentDisplay.fold(chosen: card.folds[item.id], running: running)
        let steps = SubagentDisplay.steps(item.steps, fold: fold)
        return VStack(alignment: .leading, spacing: 5) {
            Button { own(); card.folds[item.id] = fold == .closed } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    RecordFold(open: fold != .closed)
                    // In a small view a run of many kinds takes a second line rather than losing its end.
                    Text(SubagentDisplay.summaryLine(RecordDisplay.summary(item, running: running))).mono(Look.size(11.5, look)).foregroundStyle(Look.ink2).lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .shimmer(running)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if fold == .tail, steps.hidden > 0 {
                Text(steps.hidden == 1 ? "1 Earlier Step" : "\(steps.hidden) Earlier Steps").mono(Look.size(10.5, look)).foregroundStyle(Look.faint).padding(.leading, 17)
            }
            ForEach(steps.shown, id: \.index) { index, step in
                RecordStepLine(step: step, verbose: false, source: source, work: item.id, index: index, own: own,
                               openAgent: { id, name in card.show(agent: id, name: name, type: "") })
            }
        }
    }
}
