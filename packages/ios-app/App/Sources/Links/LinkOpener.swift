import AgentSwitchKit
import SwiftUI
import UIKit

// A link on the phone opens in the Mac's shared browser (docs/browser-v0.md §1 入口, terminal-v0 §1 iPhone 链接;
// 2026-10-03, user: 手机上现在点击和复制链接还是费劲，修复一下交互；修复好之后想办法让手机可以方便的点击链接，点击之后直接在
// agent switch浏览器中打开): a tap opens it there, a long press offers that, copying it, and Safari. What a link is, its
// menu and what happens without the Mac's browser are the Kit's (`TappedLink`, `LinkAction`, `LinkOpening`); here they
// are carried out.

extension AppModel {
    /// Opens `link` in the Mac's browser — a new tab of yours — and shows it: the Browser tab, on that tab's page (the
    /// page left behind stays where it was on its own tab). `alternates`: other readings of a path that may run over a
    /// line's end, tried in turn while the Mac says the one before is not there. Returns what to say when it did not
    /// open there (nil: it did): without the Mac's browser a web address the phone can reach opens in Safari.
    @discardableResult
    func open(_ link: TappedLink, alternates: [TappedLink] = []) async -> String? {
        var failure = LinkOpening.Failure.notConnected
        if let api, !browser.unsupported {
            var first: LinkOpening.Failure?
            for candidate in [link] + alternates {
                do {
                    let tab = try await api.openBrowserTab(candidate.target)
                    browser.add(tab)
                    openBrowserRequest = tab.id
                    self.tab = .browser
                    return nil
                } catch {
                    first = first ?? LinkOpening.failure(error, for: candidate)
                    // Another reading only of a path that is not there; any other answer is the answer.
                    guard case .file = candidate, case .http(status: 404, message: _)? = error as? APIError else { break }
                }
            }
            failure = first ?? .noBrowser
        } else if api != nil {
            failure = .noBrowser
        }
        let fallback = LinkOpening.fallback(link, failure)
        if let url = fallback.safari { await UIApplication.shared.open(url) }
        return fallback.said
    }

    /// One of a link's actions (its menu): what to say afterwards, if anything — a failure's reason, or that it was
    /// copied.
    func perform(_ action: LinkAction, on link: TappedLink, alternates: [TappedLink] = []) async -> String? {
        switch action {
        case .openInBrowser:
            return await open(link, alternates: alternates)
        case .copy:
            UIPasteboard.general.string = link.text
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return LinkAction.copied(link)
        case .openInSafari:
            if let url = link.safari { await UIApplication.shared.open(url) }
            return nil
        }
    }
}

/// A text's links in a long press's menu (Dispatch's record, a task's result, a session's transcript): each link's
/// actions under its address — one link as a section, several as a submenu each.
struct LinkMenuItems: View {
    let links: [TappedLink]
    @Environment(AppModel.self) private var model

    init(text: String) { links = Markdown.links(in: text) }

    var body: some View {
        if links.count == 1, let link = links.first {
            Section(link.display) { actions(link) }
        } else {
            ForEach(links, id: \.self) { link in
                Menu(link.display) { actions(link) }
            }
        }
    }

    @ViewBuilder
    private func actions(_ link: TappedLink) -> some View {
        ForEach(link.actions, id: \.self) { action in
            Button(action.label(for: link), systemImage: Self.symbol(action)) {
                Task {
                    // Copying needs no word here (the menu closing is the answer); a failure is said on the home screen.
                    if let said = await model.perform(action, on: link), action != .copy { model.banner = said }
                }
            }
        }
    }

    private static func symbol(_ action: LinkAction) -> String {
        switch action {
        case .openInBrowser: "globe"
        case .copy: "doc.on.doc"
        case .openInSafari: "safari"
        }
    }
}

extension View {
    /// A long press on a text with links offers them (a text without any keeps its own long press: selecting).
    @ViewBuilder
    func linkMenu(for text: String) -> some View {
        if Markdown.links(in: text).isEmpty {
            self
        } else {
            contextMenu {
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = MessageDisplay.readable(text) }
                LinkMenuItems(text: text)
            }
        }
    }
}
