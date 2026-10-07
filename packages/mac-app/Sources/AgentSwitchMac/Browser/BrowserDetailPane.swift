import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The Browser page's right side where the browser's tabs have windows of their own (docs/browser-v0.md §7.2; design
/// page `docs/design/implemented/browser-window.html`): the selected tab — a still picture of it, its title and address,
/// whose it is and what goes on in it, and what AgentSwitch can do with it. The page itself is in the tab's window.
struct BrowserDetailPane: View {
    @Bindable var model: BrowserPageModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if let tab = model.current {
            VStack(alignment: .leading, spacing: 10) {
                preview(tab)
                Text(BrowserTabText.title(tab)).font(.system(size: 15, weight: .semibold)).foregroundStyle(Look.ink)
                    .lineLimit(1).truncationMode(.tail)
                address(tab)
                who(tab)
                buttons(tab)
                let hint = model.note ?? BrowserWindowText.hint(tab)
                if !hint.isEmpty {
                    Text(hint).font(.system(size: 12)).lineSpacing(3)
                        .foregroundStyle(BrowserWindowText.state(tab) == .elsewhere && model.note == nil ? Color.waiting : Look.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// The still picture, in a frame of its own shape (a page's, 16 to 10, until the first one has come).
    private func preview(_ tab: BrowserTab) -> some View {
        let shape = model.preview.map { $0.size.height > 0 ? $0.size.width / $0.size.height : Self.pageShape } ?? Self.pageShape
        return ZStack(alignment: .bottomTrailing) {
            Color(white: 0.04)
            if let image = model.preview {
                Image(nsImage: image).resizable().interpolation(.medium).accessibilityLabel("Preview")
            }
            Text("preview").mono(11).foregroundStyle(Look.faint).padding(.horizontal, 8).padding(.vertical, 6)
        }
        .aspectRatio(min(max(shape, 0.5), 2.4), contentMode: .fit)
        .frame(maxHeight: Self.previewHeight)
        .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0))
        .overlay { RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0).strokeBorder(Look.line, lineWidth: 1) }
    }

    private static let pageShape: CGFloat = 1.6
    private static let previewHeight: CGFloat = 200

    /// `■ github.com/l0tk3/AgentSwitch/pulls`: the place in ink, the rest dimmer.
    private func address(_ tab: BrowserTab) -> some View {
        let place = BrowserTabText.place(tab)
        let rest = tab.url.range(of: place).map { String(tab.url[$0.upperBound...]) } ?? ""
        return (Text(tab.url.hasPrefix("https:") ? "■ " : "□ ").foregroundColor(Look.ink2) + Text(place).foregroundColor(Look.ink) + Text(rest).foregroundColor(Look.ink2))
            .mono(12).lineLimit(1).truncationMode(.middle).help(tab.url)
    }

    private func who(_ tab: BrowserTab) -> some View {
        let state = BrowserWindowText.state(tab)
        return HStack(spacing: 7) {
            BrowserStatusMark(status: state == .steppedIn || state == .elsewhere ? .waiting : tab.status).frame(width: 12)
            Text(BrowserWindowText.who(tab)).foregroundStyle(state == .steppedIn ? Color.signal : Look.ink)
            if let doing = BrowserWindowText.doing(tab) {
                Text(doing).foregroundStyle(state == .elsewhere || tab.status == .waiting ? Color.waiting : Look.ink2).lineLimit(1).truncationMode(.tail)
            }
        }
        .font(.system(size: 12.5))
    }

    private func buttons(_ tab: BrowserTab) -> some View {
        let primary = BrowserWindowText.primary(tab)
        return HStack(spacing: 8) {
            ForEach(BrowserWindowText.buttons(tab), id: \.self) { action in
                Button { model.perform(action) } label: { BracketLabel(word: BrowserWindowText.word(action)) }
                    .buttonStyle(BracketButtonStyle(role: action == primary ? .primary : (action == .close && tab.owner.isAgent ? .destructive : .normal)))
            }
        }
        .padding(.top, 2)
    }
}

extension BrowserWindowText.Action: Hashable {}
