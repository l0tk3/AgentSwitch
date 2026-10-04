import AgentSwitchMacCore
import SwiftUI

/// The page's zoom at the far right of the status bar on Browser (docs/browser-v0.md §1 页面缩放, 2026-10-03, user: 然后
/// 我发现agentswitch的浏览器页没有放大缩小的选项，加上 用来调节大小): `−` `100%` `+` in the bar's font, right of the tab's
/// hold (BrowserHoldItems), so they stay where they are whatever the hold says. `−` and `+` go a step (also ⌘− and ⌘+);
/// the percent goes back to 100 % — in the text's ink while the page is zoomed, dim at 100 %, where there is nothing to
/// go back to. A step that is not there is dim. Where this Mac does not size the tab (an agent's before
/// `[ Take Over ]`, one another screen holds) all three are dim and say why under the pointer. Nothing without a tab.
struct BrowserZoomItems: View {
    let model: BrowserPageModel

    var body: some View {
        if let zoom = model.zoom {
            let sized = model.canZoom
            HStack(spacing: 0) {
                ZoomItem(word: BrowserZoomText.zoomOut, help: sized ? BrowserZoomText.zoomOutHelp : BrowserZoomText.notSized, name: "Zoom Out",
                         acts: zoom.smaller != nil) { model.zoomOut() }
                ZoomItem(word: BrowserZoomText.percent(zoom), widest: BrowserZoomText.widest,
                         help: sized ? BrowserZoomText.resetHelp : BrowserZoomText.notSized, name: BrowserZoomText.resetHelp,
                         acts: !zoom.isStandard, strong: true) { model.zoomReset() }
                    .accessibilityValue(BrowserZoomText.percent(zoom))
                ZoomItem(word: BrowserZoomText.zoomIn, help: sized ? BrowserZoomText.zoomInHelp : BrowserZoomText.notSized, name: "Zoom In",
                         acts: zoom.larger != nil) { model.zoomIn() }
            }
            .mono(11.5)
            // A long line beside it (a note, what an agent waits for) gives way; these keep their place.
            .fixedSize()
        }
    }
}

/// One word of the zoom, as the demo page's `.zoom button` (docs/design/implemented/browser.html): secondary ink,
/// brighter with a faint square behind it under the pointer (as the bar's lock); dim where it does nothing, still with
/// its help.
private struct ZoomItem: View {
    let word: String
    /// The widest word it may write, which keeps its width.
    var widest: String?
    let help: String
    let name: String
    let acts: Bool
    /// In the text's ink while it acts (the percent away from 100 %).
    var strong = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(widest ?? word).hidden()
                .overlay { Text(word) }
                .foregroundStyle(!acts ? Look.faint : strong || hovering ? Look.ink : Look.ink2)
                .padding(.horizontal, 5)
                .frame(minWidth: 20, minHeight: 20)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color(white: 0.5).opacity(acts && hovering ? 0.16 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!acts)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(name)
    }
}
