import AgentSwitchMacCore
import AppKit
import SwiftUI

/// What the bar's controls do (MainWindowController).
struct MainBarActions {
    var switchPage: (MainPage) -> Void = { _ in }
    var back: () -> Void = {}
    var toggleList: () -> Void = {}
    var newTerminal: () -> Void = {}
    var newTab: () -> Void = {}
    var settings: () -> Void = {}
}

/// The window's content: the bar in the title bar's row (32 pt, as iTerm's compact tabs), its dotted edge, then the page
/// container. The ground is the page's: black on Terminals (the terminal window's dark block, ui-v0 §3b) and on Browser
/// (the screen's), the system's light or dark on Dispatch (ui-v0 §7.3).
struct MainWindowRoot: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let content: NSView
    let actions: MainBarActions

    var body: some View {
        VStack(spacing: 0) {
            MainBar(state: state, head: head, model: model, actions: actions)
                .frame(height: state.barHeight)
            // The bar's edge (2026-10-01, user: 顶栏没有分界线): dotted, as the terminal list's edge it meets.
            DottedRule(color: Color(nsColor: .barEdge))
            ContentHost(view: content)
        }
        .background(Color(nsColor: state.page.ground))
        .ignoresSafeArea(.container, edges: .top)
    }
}

/// The bar (docs/dispatch-v0.md §1, demo `mac-window.html`): the traffic lights, then the page switch — monospaced
/// words, the current one in ink over a signal underline, the others followed by a mark when that page has something —
/// in the same place on every page. On Terminals: the list's button after the switch, the terminal on screen centred,
/// new terminal and all the terminals' mark at the end (as the terminal window had them). On Dispatch: a task's or
/// topic's page as `‹` + mark + title in the centre, and at the end the tasks in progress and waiting (`⠙1 ▪1`), with a
/// red `■ Gateway Down` before them while the service or the gateway is down, and the settings. On Browser (demo
/// `implemented/browser.html`): the tab on screen's mark and title in the centre, and at the end the tabs agents are
/// operating and waiting on (`⠙1 ▪1`) and `+`, a new tab. Its empty part moves the window and a double click zooms, as
/// a title bar does. All of it changes with the page, at once; the page under it is then drawn in.
struct MainBar: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let actions: MainBarActions

    var body: some View {
        ZStack {
            WindowDragArea()
            HStack(spacing: 4) {
                HStack(spacing: 2) {
                    ForEach(MainPage.allCases, id: \.self) { page in
                        PageWord(page: page, current: state.page == page, activity: state.activity(of: page)) { actions.switchPage(page) }
                    }
                }
                if state.page == .terminals {
                    ToolbarPixelButton(rows: PixelArt.toolbarList, help: "List ⌘B", action: actions.toggleList)
                }
                Spacer(minLength: 0)
                switch state.page {
                case .terminals:
                    ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Terminal ⌘T", action: actions.newTerminal)
                    TerminalMarkView(head: head)
                case .dispatch:
                    dispatchEnd
                case .browser:
                    browserEnd
                }
            }
            .padding(.leading, state.lightsEnd + 10)
            .padding(.trailing, 8)
            switch state.page {
            case .terminals:
                TerminalTitleView(head: head).allowsHitTesting(false)
            case .dispatch:
                DispatchTitleView(title: state.dispatchTitle, back: state.showsBack, action: actions.back)
            case .browser:
                DispatchTitleView(title: state.browserTitle, back: false, action: {})
            }
        }
    }

    /// `⠙1 ▪1  +`: the tabs agents operate and wait on, and a new tab.
    private var browserEnd: some View {
        HStack(spacing: 10) {
            ActivityCounts(activity: state.browserActivity)
            ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Tab ⌘T", action: actions.newTab)
        }
    }

    /// `■ Gateway Down  ⠙1 ▪1  ⚙`.
    private var dispatchEnd: some View {
        HStack(spacing: 10) {
            if let trouble = ServiceTrouble.word(service: StatusText.service(model.daemonState, ready: model.daemonReady), gateway: model.gateShortLine) {
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: .failed)
                    Text(trouble).mono(11.5).foregroundStyle(Color.failed)
                }
                .help(trouble == "Gateway Down" ? model.gateLine.text : model.daemonLine.text)
            }
            ActivityCounts(activity: state.dispatchActivity)
            // The settings window's Dispatch group (docs/dispatch-v0.md §3); ⌘, opens it on the page it showed last.
            ToolbarPixelButton(rows: PixelArt.toolbarSettings, help: "Settings ⌘,") { SettingsWindowController.request(.context) }
        }
    }
}

/// `⠙1 ▪1`: in progress and waiting for you; nothing for a count of none.
private struct ActivityCounts: View {
    let activity: PageActivity

    var body: some View {
        HStack(spacing: 10) {
            if activity.busy > 0 {
                HStack(spacing: 5) {
                    BrailleSpinner()
                    Text("\(activity.busy)").mono(11.5).foregroundStyle(.secondary)
                }
                .help("\(activity.busy) Busy")
            }
            if activity.waiting > 0 {
                HStack(spacing: 5) {
                    BlinkingSquare()
                    Text("\(activity.waiting)").mono(11.5).foregroundStyle(.secondary)
                }
                .help("\(activity.waiting) Waiting")
            }
        }
    }
}

/// `Dispatch` / `Terminals` / `Browser`: words, not a segmented control (the rest of the row is pixels and monospaced words).
private struct PageWord: View {
    let page: MainPage
    let current: Bool
    let activity: PageActivity
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(page.title)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(current || hovering ? .primary : .secondary)
                    // 1 px of signal, 6 pt under the baseline.
                    .overlay(alignment: .bottom) {
                        if current { Rectangle().fill(Color.signal).frame(height: 1).offset(y: 3) }
                    }
                if !current { ActivityMark(mark: activity.mark) }
            }
            .padding(.horizontal, 8)
            .frame(height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(Self.help(page))
        .accessibilityLabel(page.title)
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    static func help(_ page: MainPage) -> String {
        switch page {
        case .dispatch: "Dispatch ⌘0"
        case .terminals: "Terminals ⌃⇥"
        case .browser: "Browser ⌘⇧B"
        }
    }
}

/// After the other page's word: amber while something there waits for you, the spinner while something is busy.
private struct ActivityMark: View {
    let mark: PageActivity.Mark

    var body: some View {
        switch mark {
        case .waiting: BlinkingSquare().accessibilityLabel("Waiting")
        case .busy: BrailleSpinner()
        case .none: EmptyView()
        }
    }
}

/// Waiting for you, as everywhere: an amber square that blinks in two steps over 1.1 s; still under Reduce Motion.
struct BlinkingSquare: View {
    var color: Color = .waiting
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.55)) { timeline in
            let dim = !reduceMotion && Int(timeline.date.timeIntervalSinceReferenceDate / 0.55) % 2 == 1
            PixelSprite(rows: PixelArt.square, pixel: 2, color: color).opacity(dim ? 0.25 : 1)
        }
        .frame(width: 8, height: 8)
    }
}

/// Dispatch's title: nothing on the conversation; `‹` + mark + title on a task's or topic's page (the arrow goes back,
/// the rest lets the bar move the window). Browser's is the same without the arrow: the tab on screen.
private struct DispatchTitleView: View {
    let title: BarTitle?
    let back: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            if back {
                Button(action: action) {
                    Text("‹").font(.system(size: 15, design: .monospaced))
                        .foregroundStyle(hovering ? .primary : .secondary)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .help("Back esc")
                .accessibilityLabel("Back")
            }
            if let title {
                HStack(spacing: 8) {
                    BarTitleMark(mark: title.mark)
                    Text(title.text).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                }
                .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

private struct BarTitleMark: View {
    let mark: BarTitle.Mark

    var body: some View {
        switch mark {
        case .none: EmptyView()
        case .busy: BrailleSpinner()
        case .waiting: BlinkingSquare()
        case .done: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
        case .failed: PixelSprite(rows: PixelArt.square, pixel: 2, color: .failed)
        case .off: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
        }
    }
}

/// The Terminals title: the folder the terminal's agent works in now and its git, as the agent's own status line says
/// it (2026-10-01, user: 应该和当前 agent 的工作目录保持一致，并显示 git 状态), with the status mark (the spinner while
/// busy, amber while it waits, hollow once ended).
private struct TerminalTitleView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 7) {
            if !head.name.isEmpty {
                switch head.status {
                case "working": BrailleSpinner()
                case "waiting": PixelSprite(rows: PixelArt.square, pixel: 2, color: .waiting)
                case "exited": PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
                default: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
                }
                Text(head.name).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                if !head.git.isEmpty {
                    Text(head.git).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .help(head.help)
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

/// All the terminals' state at the bar's end: the page's word (`1 Waiting`, `Busy`) and the app's mark.
private struct TerminalMarkView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 8) {
            if !head.tag.isEmpty { Text(head.tag).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
            PixelMarkView(state: head.mark, pixel: 1.5, depth: true)
        }
        .padding(.horizontal, 4)
    }
}

/// A bar button as a pixel icon (1 pt cells): secondary ink, brighter with a faint square behind it under the pointer,
/// as the demo page's.
struct ToolbarPixelButton: View {
    let rows: [String]
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            PixelSprite(rows: rows, pixel: 1, color: hovering ? .primary : .secondary)
                .frame(width: 28, height: 24)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color(white: 0.5).opacity(hovering ? 0.16 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

/// The bar's empty part: it moves the window, and a double click does what the system's title bars do (zoom, minimise
/// or nothing, System Settings › Desktop & Dock).
private struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ view: NSView, context: Context) {}

    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            guard event.clickCount == 2 else { window?.performDrag(with: event); return }
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.performMiniaturize(nil)
            case "None": break
            default: window?.performZoom(nil)
            }
        }
    }
}

/// The page container as it is (the window keeps it; SwiftUI only places it).
private struct ContentHost: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ view: NSView, context: Context) {}
}
