import AgentSwitchKit
import SwiftUI

// What floats over a terminal's screen on the phone (docs/terminal-v0.md §1, §3), and the key bar's caps: a permission
// request, a question the agent asks, the placeholder while the terminal is in use elsewhere. Each is drawn by the look
// (docs/ui-v0.md §8): the pixel look's framed box with its dithered hard shadow, glitching in; the classic look's round
// card with a soft shadow, standard buttons and line icons. What they say and do is the same in both.

/// A floating card's ground and edge: an ink frame over a dithered shadow, glitching as it comes; round with a soft
/// shadow in the classic look.
private struct FloatingCard<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            content
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .floatingShadow()
        } else {
            content
                .background(Theme.base)
                .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
                // The floating layer's hard, dithered shadow (§7.3), not a blur.
                .background(DitherShadow().offset(x: 6, y: 6))
                .glitch(on: trigger, onAppear: true)
        }
    }
}

/// A permission request: what the agent wants to run, `Deny` and `Allow`.
struct TerminalPermissionCard: View {
    let page: TerminalPageModel
    let permission: TerminalPermission
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let p = permission
        VStack(alignment: .leading, spacing: 10) {
            if look.isClassic {
                HStack(spacing: 7) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 14)).foregroundStyle(Theme.waiting)
                    LookWord("[!] Approval").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 6)
                    Text(p.tool).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                }
                // The command, as code, in a field of its own.
                Text(p.detail).font(.callout.monospaced()).foregroundStyle(Theme.ink).lineLimit(6).textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.code, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting)
                    Text("Permission · \(p.tool)").mono(12, weight: .semibold).foregroundStyle(Theme.waiting)
                }
                Text(p.detail).font(.callout.monospaced()).foregroundStyle(Theme.ink).lineLimit(6).textSelection(.enabled)
            }
            HStack(spacing: Theme.Space.m) {
                Button { Task { await page.decide(p, allow: false) } } label: { ButtonWord("Deny") }.buttonStyle(SquareButtonStyle(destructive: true))
                Button { Task { await page.decide(p, allow: true) } } label: { ButtonWord("Allow") }.buttonStyle(SquareButtonStyle(prominent: true))
            }
        }
        .padding(14)
        .modifier(FloatingCard(trigger: p.id))
    }
}

/// A question the agent asks (Claude Code's AskUserQuestion; docs/terminal-v0.md §3 "选择题", phone.html?ask;
/// 2026-10-01, user: 能不能hook的更精细，直接用这个框来选agent给的选项): no allow / deny — each question with its options
/// to tap, one (`< >` / `<x>`) or several (`[ ]` / `[x]`), and Other to write in; `[ Submit ]` once every question
/// has an answer. The agent gets them as its own dialog would give them, and that dialog closes. In the classic look
/// the marks are a ring and a box.
struct TerminalQuestionCard: View {
    let page: TerminalPageModel
    let permission: TerminalPermission
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let p = permission
        let picks = page.picks(p)
        VStack(alignment: .leading, spacing: 0) {
            head
            // Four questions of four options each may not fit over the screen: then they scroll.
            ViewThatFits(in: .vertical) {
                questions(picks)
                ScrollView { questions(picks) }.frame(maxHeight: 420)
            }
            HStack {
                Spacer()
                Button { Task { await page.answer(p) } } label: { ButtonWord("Submit") }
                    .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                    .disabled(!picks.isComplete || page.answering.contains(p.id))
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 12)
        }
        .modifier(FloatingCard(trigger: p.id))
    }

    @ViewBuilder private var head: some View {
        if look.isClassic {
            HStack(spacing: 7) {
                Image(systemName: "questionmark.circle.fill").font(.system(size: 15)).foregroundStyle(Theme.signal)
                Text("Question").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
        } else {
            HStack(spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: .black)
                Text("Question").mono(12, weight: .semibold)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color.black)
            .padding(.horizontal, 8)
            .frame(minHeight: 24)
            .background(Theme.waiting)
        }
    }

    private func questions(_ picks: QuestionPicks) -> some View {
        let p = permission
        return VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(p.questions.enumerated()), id: \.offset) { i, q in
                VStack(alignment: .leading, spacing: 0) {
                    if !q.header.isEmpty { Text(ClassicWords.label(q.header, in: look)).mono(11, weight: look.isClassic ? .semibold : .regular).foregroundStyle(.secondary) }
                    Text(q.question).font(.callout).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2).padding(.bottom, 4)
                    ForEach(q.options, id: \.label) { o in
                        let on = picks.isPicked(o.label, in: i)
                        Button { page.updatePicks(p) { $0.pick(o.label, in: i) } } label: {
                            choice(q, on: on) {
                                Text(o.label).mono(look.isClassic ? 15 : 13)
                                if !o.description.isEmpty { Text(o.description).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    // Writing in Other picks it: in place of the option picked (one), or beside them (several).
                    choice(q, on: picks.hasOther(in: i)) {
                        TextField(q.options.isEmpty ? "Answer" : "Other",
                                  text: Binding(get: { page.picks(p).other(in: i) }, set: { text in page.updatePicks(p) { $0.write(text, in: i) } }))
                            .mono(look.isClassic ? 15 : 13)
                            .foregroundStyle(Theme.ink)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        HairRule()
                    }
                }
            }
        }
        .padding(.horizontal, look.isClassic ? 14 : 12)
        .padding(.top, 10)
    }

    /// One option's row: its mark — `< >` / `<x>` for one, `[ ]` / `[x]` for several (ui-v0 §7.2.6), a ring or a box in
    /// the classic look — and what it says, in ink once picked.
    private func choice<Content: View>(_ q: TerminalQuestion, on: Bool, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if look.isClassic {
                Image(systemName: q.multiSelect ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .font(.system(size: 17)).foregroundStyle(on ? Theme.signal : Color.secondary)
            } else {
                Text(q.multiSelect ? (on ? "[x]" : "[ ]") : (on ? "<x>" : "< >")).mono(13)
            }
            VStack(alignment: .leading, spacing: 2) { content() }
            Spacer(minLength: 0)
        }
        .foregroundStyle(on ? Theme.ink : Color.secondary)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

/// The terminal is in use on another screen (terminal-v0 §1 "不在用的一端显示占位", phone.html?away): the frame as it
/// was behind a 50 % dither, a box saying where, glitching in; a tap anywhere takes the size back here. In the classic
/// look a quiet veil and a round card.
struct TerminalAwayCover: View {
    let page: TerminalPageModel
    let place: String
    @Environment(\.interfaceLook) private var look

    private static let copy: [String: (String, String)] = [
        "mac": ("On Mac", "这个终端正在 Mac 上使用。"),
        "iphone": ("On iPhone", "这个终端正在另一台 iPhone 上使用。"),
        "web": ("On Web", "这个终端正在浏览器中使用。"),
    ]

    var body: some View {
        let (head, line) = Self.copy[place] ?? ("On Web", "这个终端正在浏览器中使用。")
        ZStack {
            page.ground.opacity(look.isClassic ? 0.62 : 0.45)
            if !look.isClassic { CheckerTile(color: page.screen.view.nativeBackgroundColor) }
            VStack(alignment: .leading, spacing: 0) {
                if look.isClassic {
                    LookWord(head).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
                        .padding(.horizontal, 16).padding(.top, 16)
                } else {
                    HStack(spacing: 6) {
                        PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.base)
                        Text(head).mono(12, weight: .semibold)
                    }
                    .foregroundStyle(Theme.base)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                    .background(Theme.ink)
                }
                Text(line).font(.callout).foregroundStyle(look.isClassic ? Theme.secondaryInk : Theme.ink)
                    .padding(.horizontal, look.isClassic ? 16 : 12).padding(.top, look.isClassic ? 6 : 12)
                HStack {
                    Spacer()
                    Button { page.claim() } label: { ButtonWord("Take Over") }.buttonStyle(SquareButtonStyle(prominent: true))
                }
                .padding(look.isClassic ? 16 : 12)
            }
            .modifier(FloatingCard(trigger: place))
            .padding(.horizontal, 28)
        }
        .contentShape(Rectangle())
        .onTapGesture { page.claim() }
    }
}

/// A key on the bar: a small square cap with a 3 pt base; pressed, it sinks 2 pt onto a 1 pt base (the demo page's
/// key caps). The browser page's key bar uses the same caps. In the classic look a round key as the system keyboard's,
/// the one that stands out in the accent.
struct KeyCapStyle: ButtonStyle {
    /// The one key that stands out (⏎): ink ground, the base colour's letters, a wider cap.
    var solid = false
    /// Narrower caps, for a bar that holds a long key too (the browser page's).
    var compact = false
    @Environment(\.interfaceLook) private var look
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        if look.isClassic {
            configuration.label
                .foregroundStyle(solid ? Theme.onFill : Theme.ink)
                .frame(minWidth: compact ? (solid ? 36 : 26) : (solid ? 46 : 34))
                .padding(.horizontal, compact ? 5 : 6)
                .padding(.vertical, 7)
                .background(solid ? Theme.fill : scheme == .dark ? Color(white: 0.23) : Theme.raised, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .opacity(pressed ? 0.6 : 1)
        } else {
            configuration.label
                .foregroundStyle(solid ? Theme.base : Theme.ink)
                .frame(minWidth: compact ? (solid ? 36 : 26) : (solid ? 46 : 34))
                .padding(.horizontal, compact ? 5 : 6)
                .padding(.top, 6)
                .padding(.bottom, pressed ? 6 : 8)
                .background(solid ? (pressed ? Theme.secondaryInk : Theme.ink) : (pressed ? Theme.line : Theme.raised))
                .overlay(Rectangle().strokeBorder(solid ? Theme.ink : Theme.line, lineWidth: 1))
                .overlay(alignment: .bottom) { (solid ? Theme.secondaryInk : Theme.inkDim).frame(height: pressed ? 1 : 3) }
                .offset(y: pressed ? 2 : 0)
                .padding(.bottom, pressed ? 2 : 0)
        }
    }
}

/// A 1 pt checker in `color`, tiled from one small image (a Canvas over the whole screen would draw a cell at a time).
private struct CheckerTile: View {
    let color: UIColor

    var body: some View {
        Image(uiImage: Self.tile(color)).resizable(resizingMode: .tile).allowsHitTesting(false).accessibilityHidden(true)
    }

    static func tile(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
            context.fill(CGRect(x: 1, y: 1, width: 1, height: 1))
        }
    }
}
