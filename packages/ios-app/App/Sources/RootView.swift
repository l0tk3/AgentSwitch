import AgentSwitchKit
import SwiftUI

/// Onboarding until a Mac is paired, then the home screen; the Face ID cover sits on top of both when enabled.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock

    var body: some View {
        // Only web links open from model output (Markdown.inline also drops other schemes): an agentswitch:// link
        // in a result must not start pairing with a Mac someone else chose. They open in the Mac's shared browser, the
        // page over where the link was (browser-v0 §1 入口, 2026-10-03; LinkOpener); without it, in Safari as before,
        // with why.
        content.environment(\.openURL, OpenURLAction { url in
            guard Markdown.isWebLink(url) else { return .discarded }
            Task { if let said = await model.open(.web(url.absoluteString)) { model.banner = said } }
            return .handled
        })
    }

    @ViewBuilder
    private var content: some View {
        @Bindable var model = model
        // Locked: the app's views are not in the hierarchy at all, so no sheet, dialog or pushed page they presented
        // can stay on top of the lock (a ZStack cover sits below sheets).
        if lock.locked {
            LockView().followsLook()
        } else {
            Group {
                if model.isPaired {
                    MainTabs()
                } else {
                    OnboardingView()
                }
            }
            // Drawn in the look kept in the settings (docs/ui-v0.md §8), and built again when it changes. The sheets
            // hang outside that, so Settings — where the look is changed — stays open across the change; each sheet's
            // content follows the look itself.
            .followsLook()
            .sheet(item: Binding(get: { model.incomingPairingLink.map(PendingLink.init) },
                                 set: { model.incomingPairingLink = $0?.text })) { pending in
                PairConfirmView(link: pending.text).followsLook()
            }
            .sheet(item: $model.sheet) { sheet in
                HomeSheetContent(sheet: sheet).followsLook().linkedPageCover(model, inSheet: true)
            }
            // A tapped link's page, over where the link was (LinkOpener).
            .linkedPageCover(model, inSheet: false)
        }
    }
}

/// Settings, ciphertexts, the loose approvals and adding a Mac, opened as sheets from the home screen.
private struct HomeSheetContent: View {
    let sheet: HomeSheet
    @Environment(AppModel.self) private var model

    var body: some View {
        switch sheet {
        case .pickCiphertext:
            CiphertextPicker { token in model.insertIntoCompose(token) }
        case .makeCiphertext:
            NavigationStack {
                CiphertextsView()
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { model.sheet = nil } } }
            }
        case .approvals:
            ApprovalsView()
        case .addMac:
            AddMacSheet()
        }
    }
}

/// The entries side by side (docs/terminal-v0.md §1, browser-v0 §1): `Dispatch` (the conversation), `Terminals` and
/// `Browser`; their icons are pixel marks (§7.3: the app's mark for tasks, a framed terminal window for terminals — `>_`
/// alone means Codex — and a globe for the browser).
///
/// No push: while the app is open the terminals are followed from every tab and page (the badge, the waiting cue, the
/// Live Activity), and the tasks from the terminals tab too (their cues); the home screen follows them itself. The
/// browser's tabs are read from every tab too (the badge counts the agents waiting for you), more often on its own.
struct MainTabs: View {
    @Environment(AppModel.self) private var model
    /// The classic look's tabs: line icons (the system's; the app's mark drawn as lines), the one in use in the accent.
    @Environment(\.interfaceLook) private var look
    @Environment(\.colorScheme) private var scheme

    private struct Watch: Equatable {
        let endpoint: APIEndpoint?
        let tab: MainTab
    }

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            // The pixel look's tabs are the shaded pictures (docs/ui-v0.md §9: tones of the ink, no hue), whole for the
            // tab in use, fainter for the others.
            HomeView()
                .tabItem { Label { Text("Dispatch") } icon: { look.isClassic ? Image(uiImage: TabIcons.classicTasks) : Image(uiImage: TabIcons.shaded(.dispatch, on: model.tab == .tasks, dark: scheme == .dark)) } }
                .tag(MainTab.tasks)
            TerminalsTab()
                .tabItem { Label { Text("Terminals") } icon: { look.isClassic ? Image(systemName: "terminal") : Image(uiImage: TabIcons.shaded(.terminals, on: model.tab == .terminals, dark: scheme == .dark)) } }
                .badge(model.terminals.waiting)
                .tag(MainTab.terminals)
            BrowserTab()
                .tabItem { Label { Text("Browser") } icon: { look.isClassic ? Image(systemName: "globe") : Image(uiImage: TabIcons.shaded(.browser, on: model.tab == .browser, dark: scheme == .dark)) } }
                .badge(model.browser.waiting)
                .tag(MainTab.browser)
            // Settings is a place of the app like the other three, in the bar with them (2026-10-07, user: 设置也放到下面的
            // 液态玻璃面板里): it was a sheet behind a gear on the Dispatch page only.
            SettingsView()
                .tabItem { Label { Text("Settings") } icon: { look.isClassic ? Image(systemName: "gearshape") : Image(uiImage: TabIcons.shaded(.settings, on: model.tab == .settings, dark: scheme == .dark)) } }
                .tag(MainTab.settings)
        }
        .tint(look.isClassic ? Theme.signal : Theme.ink)
        .minimizesTabBarOnScroll()
        .task(id: model.connection.endpoint) {
            while !Task.isCancelled {
                await model.refreshTerminals()
                try? await Task.sleep(for: TerminalsTab.pollInterval)
            }
        }
        // Where the Mac is now, asked again now and then for as long as this connection lasts (the connection itself
        // asked once when it was made).
        .task(id: model.connection.endpoint) {
            guard model.connection.endpoint != nil else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: AppModel.addressRefreshInterval)
                guard !Task.isCancelled else { break }
                await model.refreshAddresses()
            }
        }
        .task(id: Watch(endpoint: model.connection.endpoint, tab: model.tab)) {
            while !Task.isCancelled {
                await model.browser.refreshList(model.api)
                let every = model.browser.unsupported ? BrowserStore.unsupportedInterval
                    : model.tab == .browser ? BrowserStore.pollInterval : BrowserStore.backgroundInterval
                try? await Task.sleep(for: every)
            }
        }
        .task(id: Watch(endpoint: model.connection.endpoint, tab: model.tab)) {
            guard model.tab != .tasks else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: HomeView.pollInterval)
                guard !Task.isCancelled else { break }
                await model.refreshAll()
            }
        }
    }
}

extension View {
    /// The tab bar gets out of the way of a list being read (2026-10-07, user: 是不是应该弄一个自动隐藏？你找一下 Apple 的自动
    /// 隐藏逻辑规范). Apple's own behaviour for it, not one of ours:
    /// - `tabBarMinimizeBehavior(.onScrollDown)` (iOS 26): "Minimize the tab bar when downwards scrolling starts", on
    ///   iPhone only; it "becomes smaller so that the content behind it has more room" and is restored on scrolling back
    ///   up. The default (`automatic`) on iOS is that it "does not minimize".
    /// - Human Interface Guidelines, Tab bars: "A person can exit the minimized state by tapping a tab or scrolling to
    ///   the top of the view", and "Make sure the tab bar is visible when people navigate to different sections of your
    ///   app. If you hide the tab bar, people can forget which area of the app they're in" — so it is made smaller, never
    ///   taken away, and a page of one thing (a terminal, a task) still hides it as before.
    /// Before iOS 26 the bar has no such state and stays as it is.
    @ViewBuilder func minimizesTabBarOnScroll() -> some View {
        if #available(iOS 26.0, *) { tabBarMinimizeBehavior(.onScrollDown) } else { self }
    }
}

/// The tab icons: pixel sprites as template images (the tab bar tints them), whole points per cell.
enum TabIcons {
    static let tasks = image(PixelArt.markRows, pixel: 2)
    static let terminals = image(PixelArt.terminalWindow, pixel: 3)
    static let browser = image(PixelArt.globe, pixel: 2)
    /// The Dispatch tab's lanes as lines, for the classic look's tab bar.
    @MainActor static let classicTasks = ClassicLanes.image(height: 22)

    /// A shaded picture in its own tones (not tinted), for a dark or a light tab bar: each cell a whole number of
    /// pixels (5 on a 3× screen), fainter when its tab is not the one in use.
    @MainActor static func shaded(_ sprite: ShadedSprite, on: Bool, dark: Bool) -> UIImage {
        let key = "\(sprite.rows.joined())|\(on)|\(dark)"
        if let made = shadedMade[key] { return made }
        let scale = UITraitCollection.current.displayScale
        let cell = max(1, (1.6 * scale).rounded()) / scale
        let size = CGSize(width: (CGFloat(sprite.width) * cell).rounded(.up), height: (CGFloat(sprite.height) * cell).rounded(.up))
        let image = UIGraphicsImageRenderer(size: size).image { context in
            for c in sprite.cells(dark: dark) {
                UIColor(rgb: c.rgb).withAlphaComponent(on ? 1 : 0.55).setFill()
                context.fill(CGRect(x: CGFloat(c.x) * cell, y: CGFloat(c.y) * cell, width: cell, height: cell))
            }
        }
        .withRenderingMode(.alwaysOriginal)
        shadedMade[key] = image
        return image
    }

    @MainActor private static var shadedMade: [String: UIImage] = [:]

    static func image(_ rows: [String], pixel: CGFloat) -> UIImage {
        let lit = PixelArt.sprite(rows.map { row in String(row.map { $0 == "." ? Character(".") : Character("#") }) })
        let size = CGSize(width: CGFloat(rows.first?.count ?? 0) * pixel, height: CGFloat(rows.count) * pixel)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor.black.setFill()
            for cell in lit { context.fill(CGRect(x: CGFloat(cell.x) * pixel, y: CGFloat(cell.y) * pixel, width: pixel, height: pixel)) }
        }
        .withRenderingMode(.alwaysTemplate)
    }
}

private struct PendingLink: Identifiable {
    let text: String
    var id: String { text }
}

/// Full-screen cover while the app is locked.
struct LockView: View {
    @Environment(AppLock.self) private var lock

    var body: some View {
        VStack(spacing: 20) {
            PixelSprite(rows: PixelArt.lock, pixel: 6, color: .secondary, strength: 0.9, cell: 7.0 / 3)
            Text("AgentSwitch 已锁定").font(.title3.bold())
            Button { Task { await lock.unlock() } } label: { ButtonWord("Unlock with \(lock.biometryName)") }
                .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
            if let error = lock.lastError {
                Text(error).font(.footnote).foregroundStyle(Theme.failed).multilineTextAlignment(.center)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .task { await lock.unlock() }
    }
}

#Preview("Home") {
    RootView().environment(AppModel.preview()).environment(AppLock())
}
