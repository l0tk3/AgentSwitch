import AgentSwitchMacCore
import AppKit
import SwiftUI

// A terminal's own window, drawn (docs/dispatch-v0.md §1 单独的窗口; demo `docs/design/implemented/item-window.html`):
// the main window with everything put away — one surface in the terminal's ground, no line anywhere. A row of bar (the
// traffic lights, the title), the screen, a row of status. Over the screen, natively, what the main window's page draws
// there: the requests' cards at its top right, the sealed reply's box at its foot, the placeholder while the terminal is
// in use elsewhere, a sentence when something went wrong.

struct TerminalWindowRoot: View {
    let model: TerminalWindowModel
    /// The native screen (and its refresh) in a view of their own.
    let stage: NSView
    let barHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            TerminalWindowBar(model: model).frame(height: barHeight)
            ZStack {
                ItemStageHost(view: stage)
                TerminalWindowOverlays(model: model)
            }
            TerminalWindowStatusBar(model: model).frame(height: MainStatusBar.height)
        }
        .background(Color(nsColor: model.ground))
        .ignoresSafeArea()
        .tint(.brand)
        .followsWindow()
    }
}

/// The bar: the title in its middle, the rest of it moves the window (a double click zooms, as a title bar's).
private struct TerminalWindowBar: View {
    let model: TerminalWindowModel

    var body: some View {
        ZStack {
            WindowDragArea()
            TerminalTitle(name: model.folder, git: model.gitWords, status: model.info?.status, help: model.help)
                .allowsHitTesting(false)
        }
    }
}

/// The status line: the terminal's name in the list on the left (there is no list here), on the right what the main
/// window's says of the terminal on screen — agent and model, mode, where its size is, the lock.
private struct TerminalWindowStatusBar: View {
    let model: TerminalWindowModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 14) {
            // Named after its folder, the title has said it already.
            if let name = model.info?.name, name != model.folder { Text(name).truncationMode(.tail) }
            Spacer(minLength: 12)
            if let context = model.context {
                TerminalStatusItems(context: context, seal: model.toggleSeal).fixedSize()
            }
        }
        .mono(12)
        .foregroundStyle(Look.ink2)
        .lineLimit(1)
        .padding(.leading, 12)
        .padding(.trailing, look.isClassic ? 6 : 8)
    }
}

/// The stage in SwiftUI: as large as it is given.
private struct ItemStageHost: NSViewRepresentable {
    let view: NSView

    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ view: NSView, context: Context) {}
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

// MARK: - over the screen

struct TerminalWindowOverlays: View {
    let model: TerminalWindowModel
    /// The requests' cards and the sealed reply show here (a pane of the main window out of focus shows only the
    /// placeholder; its header says a request waits).
    var cards = true

    var body: some View {
        ZStack {
            if let place = model.away {
                AwayCover(place: place, use: model.useHere)
            }
            if cards {
                VStack(alignment: .trailing, spacing: 7) {
                    ForEach(model.requests) { request in
                        Group {
                            if request.isQuestion {
                                TerminalQuestionCard(request: request, model: model, keys: request.id == model.first?.id)
                            } else {
                                TerminalApprovalCard(request: request, model: model, keys: request.id == model.first?.id)
                            }
                        }
                        .glitch(on: request.id, onAppear: { true })
                    }
                }
                .frame(maxWidth: 467)
                .padding(.top, 12)
                .padding(.leading, 20)
                .padding(.trailing, 13)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
            VStack(spacing: 8) {
                if let notice = model.notice { NoticeLine(text: notice) }
                if cards, model.composing { SealBox(model: model) }
            }
            .padding(.leading, 20)
            .padding(.trailing, 19)
            .padding(.bottom, 7)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
    }
}

/// Leave to use a tool: what in plain words, on what, where; `[ Deny ⌘⌫ ]` `[ Allow ⌘↩ ]`.
struct TerminalApprovalCard: View {
    let request: TerminalRequest
    let model: TerminalWindowModel
    /// The first card: the keys are its, and it says so.
    let keys: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let text = TerminalRequestText(request, cwd: model.info?.cwd, home: NSHomeDirectory())
        FloatingBox(title: "[!] Approval", trailing: text.tool) {
            VStack(alignment: .leading, spacing: 3) {
                Text(text.detail)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(Look.ink)
                    .lineLimit(4)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: look.isClassic ? .infinity : nil, alignment: .leading)
                    .padding(.horizontal, look.isClassic ? 9 : 0)
                    .padding(.vertical, look.isClassic ? 6 : 0)
                    .grounded(look.isClassic ? Look.ink.opacity(0.07) : Color.clear, radius: 7)
                if let folder = text.folder {
                    Text(folder).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.faint).lineLimit(1).truncationMode(.head)
                        .padding(.top, look.isClassic ? 2 : 0)
                }
            }
            .padding(EdgeInsets(top: look.isClassic ? 6 : 10, leading: 12, bottom: 4, trailing: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(request.summary)
            CardFoot(busy: model.busy.contains(request.id)) {
                Button { model.decide(request, allow: false) } label: { BracketLabel(word: "Deny", key: keys ? "⌘⌫" : nil) }
                    .buttonStyle(BracketButtonStyle(role: .destructive, size: 12.5))
                Button { model.decide(request, allow: true) } label: { BracketLabel(word: "Allow", key: keys ? "⌘↩" : nil) }
                    .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
            }
        }
    }
}

/// The agent's own question: each with its options to pick — one or several — and Other to write in; `[ Submit ⌘↩ ]`
/// once each has an answer. A click into the card gives it the keyboard: numbers pick in the question in focus (the
/// number after its last option is Other), ⇥ goes to the next question, ↩ submits, esc gives the keyboard back.
struct TerminalQuestionCard: View {
    let request: TerminalRequest
    let model: TerminalWindowModel
    let keys: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let form = model.form(for: request)
        FloatingBox(title: look.isClassic ? "? Question" : "[?] Question", symbol: "questionmark.circle") {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
                        QuestionPart(request: request, index: index, question: question, form: form, model: model,
                                     focused: keys && model.cardHasKeys && model.focus(in: request) == index)
                    }
                }
                .padding(EdgeInsets(top: 10, leading: 12, bottom: 4, trailing: 12))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 420)
            .fixedSize(horizontal: false, vertical: true)
            CardFoot(busy: model.busy.contains(request.id)) {
                Button { model.submit(request) } label: { BracketLabel(word: "Submit", key: keys ? "⌘↩" : nil) }
                    .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                    .disabled(!form.complete)
            }
        }
        // A click anywhere in the card: the numbers are its.
        .simultaneousGesture(TapGesture().onEnded { if keys { model.takeKeys() } })
    }
}

private struct QuestionPart: View {
    let request: TerminalRequest
    let index: Int
    let question: TerminalRequest.Question
    let form: TerminalAnswers
    let model: TerminalWindowModel
    /// The numbers pick here.
    let focused: Bool
    @State private var writing = false
    @State private var height = ComposeField.minHeight
    /// Each change asks the Other's field for the keyboard.
    @State private var asks = 0
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !question.header.isEmpty { PartLabel(question.header) }
            Text(question.question)
                .font(.system(size: 13)).foregroundStyle(Look.ink)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 2)
            ForEach(Array(question.options.enumerated()), id: \.offset) { n, option in
                Button { model.pick(request, question: index, option.label) } label: {
                    row(number: n + 1, on: form.isOn(index, option.label)) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                            if !option.description.isEmpty {
                                Text(option.description).font(.system(size: 11.5)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            row(number: question.options.count + 1, on: form.otherOn(index)) {
                // Clicked into or asked for by its number, the field takes the keyboard and the card its keys with it.
                ComposeField(text: Binding(get: { form.picks[index].other }, set: { model.write(request, question: index, $0) }),
                             height: $height, focusRequests: asks, takesFocusAtFirst: false, label: "Other",
                             onSubmit: { model.submit(request) }, onFiles: { _ in }, onPasteAttachments: {},
                             onFocus: { writing = $0; if $0 { model.takeKeys() } })
                    .frame(height: height)
                    .overlay(alignment: .topLeading) {
                        if form.picks[index].other.isEmpty {
                            Text(question.options.isEmpty ? "Answer" : "Other").font(.system(size: 14)).foregroundStyle(Look.faint).allowsHitTesting(false)
                        }
                    }
                    .padding(.bottom, 3)
                    .overlay(alignment: .bottom) { Rectangle().fill(writing ? Color.signal : Look.faint).frame(height: 1) }
                    // An AppKit view has no baseline of its own: its first line's, for the row's number and mark.
                    .alignmentGuide(.firstTextBaseline) { $0[.top] + ceil(ComposeField.font.ascender) }
            }
        }
        .padding(.leading, 8)
        // The question the numbers pick in: a bar in the signal colour at its side.
        .overlay(alignment: .leading) { Rectangle().fill(focused ? Color.signal : Color.clear).frame(width: 2) }
        .padding(.leading, -8)
        .onChange(of: model.otherFocus) { if focused { asks += 1 } }
    }

    /// A choice's row: its number, its mark (`< >` `<x>` one of several, `[ ]` `[x]` several; the system's ring and box
    /// in the classic look), and what it says.
    private func row<Content: View>(number: Int, on: Bool, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(number < 10 ? String(number) : "").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.faint).frame(width: 10)
            LookChoice(on: on, multi: question.multiSelect, size: 12.5).foregroundStyle(on ? Color.signal : Look.ink2)
            content().foregroundStyle(on ? Look.ink : Look.ink2)
            Spacer(minLength: 0)
        }
        .padding(.vertical, look.isClassic ? 2 : 1)
        .contentShape(Rectangle())
    }
}

/// A card's foot: its buttons on the right, dimmed while an answer is on its way.
private struct CardFoot<Buttons: View>: View {
    let busy: Bool
    @ViewBuilder let buttons: Buttons

    var body: some View {
        HStack(spacing: 14) {
            Spacer(minLength: 8)
            buttons
        }
        .disabled(busy)
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 10, trailing: 12))
    }
}

/// The sealed reply's box at the screen's foot (the page's composer): `Encrypt & Send → folder`, what you write — it may
/// hold a password, which reaches the agent as ciphertext —, `[ Cancel esc ]` `[ Send ↩ ]`. ⇧↩ is a new line.
struct SealBox: View {
    let model: TerminalWindowModel
    @State private var height = ComposeField.minHeight
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var model = model
        FloatingBox(title: "Encrypt & Send", trailing: "→ \(model.folder)", waiting: false, symbol: "lock", tint: .signal) {
            // The Dispatch input's field: ↩ sends, ⇧↩ is a new line, an input method's ↩ only ends its composition; it
            // takes the keyboard as the box opens.
            ComposeField(text: $model.draft, height: $height, focusRequests: model.sealFocus, label: "Encrypt & Send",
                         onSubmit: model.send, onFiles: { _ in }, onPasteAttachments: {}, onFocus: { model.sealFocused = $0 })
                .frame(height: max(height, 2 * ComposeField.lineHeight))
                .overlay(alignment: .topLeading) {
                    if model.draft.isEmpty { Text("Reply").font(.system(size: 14)).foregroundStyle(Look.faint).allowsHitTesting(false) }
                }
                .padding(EdgeInsets(top: 10, leading: 12, bottom: 4, trailing: 12))
            HStack(spacing: 14) {
                Text("密码与令牌在发送前加密，agent 仅接收密文。").font(.system(size: 12)).foregroundStyle(Look.faint).lineLimit(1)
                Spacer(minLength: 8)
                Button { model.closeSeal() } label: { BracketLabel(word: "Cancel", key: "esc") }
                    .buttonStyle(BracketButtonStyle(size: 12.5))
                Button { model.send() } label: { BracketLabel(word: model.sending ? "Sending" : "Send", key: "↩") }
                    .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                    .disabled(model.sending || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 10, trailing: 12))
        }
        .glitch(on: model.id, onAppear: { true })
    }
}

/// The terminal is in use elsewhere: the screen dimmed, and where; a click anywhere takes its size back.
private struct AwayCover: View {
    let place: String
    let use: () -> Void
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let words = TerminalWindowText.away(place)
        ZStack {
            // The dimmed screen is a button: it answers the first click also in a window that is not in front.
            Button(action: use) { Color.black.opacity(0.72) }
                .buttonStyle(.plain)
                .accessibilityLabel("Use Here")
            FloatingBox(title: words.head, waiting: false, symbol: place == "iphone" ? "iphone" : "macwindow") {
                Text(words.line).font(.system(size: 13)).foregroundStyle(Look.ink2).lineSpacing(3)
                    .padding(EdgeInsets(top: 10, leading: 12, bottom: 4, trailing: 12))
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Spacer()
                    Button(action: use) { BracketLabel(word: "Use Here") }
                        .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                }
                .padding(EdgeInsets(top: 8, leading: 12, bottom: 10, trailing: 12))
            }
            .frame(width: 347)
            .glitch(on: place, onAppear: { true })
            .offset(y: -24)
        }
    }
}

/// Something went wrong, in a sentence, for a few seconds.
struct NoticeLine: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Text(text)
            .font(.system(size: 12.5))
            .foregroundStyle(Look.ink)
            .lineLimit(2)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .grounded(Look.raised, radius: 8)
            .framed(Color.failed, radius: 8)
            .glitch(on: text, onAppear: { true })
            .frame(maxWidth: .infinity, alignment: .center)
    }
}
