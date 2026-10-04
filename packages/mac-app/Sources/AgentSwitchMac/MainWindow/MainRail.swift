import AgentSwitchMacCore
import SwiftUI

/// The rail (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo `implemented/window-bars.html`, proposal B,
/// 2026-10-03): the window's pages down its left edge, 44 pt wide and the same on every page — Dispatch (the app's mark),
/// Terminals (a terminal window), Browser (a globe) — and the settings at its foot. Fine pixel icons (1 pt cells, as the
/// bar's buttons) in one ink: secondary, ink under the pointer and for the page on screen, which also has a 2 pt signal
/// bar at the rail's edge. What a page has going on is a mark off its icon's top right corner, ringed in the ground so it
/// never touches the icon — amber while something there waits for you, the spinner while something is busy —, the page
/// on screen too. No names under the icons: the help says them, with their keys.
struct MainRail: View {
    let state: MainWindowState
    let switchPage: (MainPage) -> Void
    let settings: () -> Void

    static let width: CGFloat = 44

    var body: some View {
        VStack(spacing: 2) {
            ForEach(MainPage.allCases, id: \.self) { page in
                RailButton(rows: page.railIcon, help: page.railHelp, current: state.page == page,
                           mark: state.activity(of: page).mark) { switchPage(page) }
                    .accessibilityLabel(page.title)
            }
            Spacer(minLength: 0)
            RailButton(rows: PixelArt.toolbarSettings, help: "Settings ⌘,", current: false, mark: .none, action: settings)
                .accessibilityLabel("Settings")
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .frame(width: Self.width)
    }
}

extension MainPage {
    /// The page's icon in the rail.
    var railIcon: [String] {
        switch self {
        case .dispatch: PixelArt.railDispatch
        case .terminals: PixelArt.railTerminals
        case .browser: PixelArt.railBrowser
        }
    }
}

/// One of the rail's icons: 36 pt tall across the rail, the faint hover ground behind it under the pointer; the page on
/// screen with the signal bar at the rail's edge (4 pt to its left, 18 pt tall); its mark off the icon's corner.
private struct RailButton: View {
    let rows: [String]
    let help: String
    let current: Bool
    let mark: PageActivity.Mark
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            if look.isClassic { classic } else { pixel }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if current, !look.isClassic { Rectangle().fill(Color.signal).frame(width: 2, height: 18).offset(x: -4) }
        }
        .onHover { hovering = $0 }
        .help(ClassicWords.help(help, in: look))
        .accessibilityAddTraits(current ? .isSelected : [])
        .accessibilityValue(mark == .waiting ? "Waiting" : mark == .busy ? "Busy" : "")
    }
}

private extension RailButton {
    var pixel: some View {
        // The page's shaded picture (docs/ui-v0.md §9): whole for the page on screen or under the pointer, fainter
        // for the others.
        PixelSprite(rows: rows, pixel: 1, color: current || hovering ? Look.ink : Look.ink2, strength: current || hovering ? 1 : 0.7)
            .overlay(alignment: .topTrailing) { RailMark(mark: mark).offset(x: 6, y: -4) }
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .background(hovering ? Look.hover : Color.clear)
            .contentShape(Rectangle())
    }

    /// The classic look (docs/ui-v0.md §8): the page on screen has a round highlight and its icon the accent's colour,
    /// in place of the signal bar at the rail's edge.
    var classic: some View {
        PixelSprite(rows: rows, pixel: 1, color: current ? Color.signal : hovering ? Look.ink : Look.ink2)
            .overlay(alignment: .topTrailing) { RailMark(mark: mark).offset(x: 8, y: -5) }
            .frame(maxWidth: .infinity)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(current ? Look.raised : hovering ? Look.hover : Color.clear))
            .padding(.vertical, 3)
            .contentShape(Rectangle())
    }
}

/// The mark off an icon's corner: an 8 pt square of the ground (the ring that keeps it off the icon) holding a 4 pt amber
/// square that blinks as everything waiting for you does, or a small spinner; nothing for a page with nothing going on.
private struct RailMark: View {
    let mark: PageActivity.Mark
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch mark {
        case .none:
            EmptyView()
        case .waiting:
            ring { BlinkingSquare(pixel: look.isClassic ? 1.5 : 1) }
        case .busy:
            ring { BrailleSpinner(size: 9) }
        }
    }

    /// The ring: a square of the ground in the pixel look; a disc of the rail's own grey in the classic one.
    @ViewBuilder
    private func ring(@ViewBuilder _ content: () -> some View) -> some View {
        if look.isClassic {
            content().frame(width: 10, height: 10).background(Circle().fill(Look.sidebar))
        } else {
            content().frame(width: 8, height: 8).background(Look.ground)
        }
    }
}
