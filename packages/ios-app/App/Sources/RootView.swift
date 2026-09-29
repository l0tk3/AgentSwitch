import AgentSwitchKit
import SwiftUI

/// Onboarding until a Mac is paired, then the home screen; the Face ID cover sits on top of both when enabled.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock

    var body: some View {
        // Only web links open from model output (Markdown.inline also drops other schemes): an agentswitch:// link
        // in a result must not start pairing with a Mac someone else chose.
        content.environment(\.openURL, OpenURLAction { url in Markdown.isWebLink(url) ? .systemAction : .discarded })
    }

    @ViewBuilder
    private var content: some View {
        // Locked: the app's views are not in the hierarchy at all, so no sheet, dialog or pushed page they presented
        // can stay on top of the lock (a ZStack cover sits below sheets).
        if lock.locked {
            LockView()
        } else {
            Group {
                if model.isPaired {
                    MainTabs()
                } else {
                    OnboardingView()
                }
            }
            .sheet(item: Binding(get: { model.incomingPairingLink.map(PendingLink.init) },
                                 set: { model.incomingPairingLink = $0?.text })) { pending in
                PairConfirmView(link: pending.text)
            }
        }
    }
}

/// The two entries side by side (docs/terminal-v0.md §1): `tasks` (the conversation) and `terminals`; their icons are
/// pixel marks (§7.3: the app's mark for tasks, a framed terminal window for terminals — `>_` alone means Codex).
///
/// No push: while the app is open the terminals are followed from every tab and page (the badge, the waiting cue, the
/// Live Activity), and the tasks from the terminals tab too (their cues); the home screen follows them itself.
struct MainTabs: View {
    @Environment(AppModel.self) private var model

    private struct Watch: Equatable {
        let endpoint: APIEndpoint?
        let tab: MainTab
    }

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            HomeView()
                .tabItem { Label { Text("tasks") } icon: { Image(uiImage: TabIcons.tasks) } }
                .tag(MainTab.tasks)
            TerminalsTab()
                .tabItem { Label { Text("terminals") } icon: { Image(uiImage: TabIcons.terminals) } }
                .badge(model.terminals.waiting)
                .tag(MainTab.terminals)
        }
        .tint(Theme.ink)
        .task(id: model.connection.endpoint) {
            while !Task.isCancelled {
                await model.refreshTerminals()
                try? await Task.sleep(for: TerminalsTab.pollInterval)
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

/// The tab icons: pixel sprites as template images (the tab bar tints them), whole points per cell.
enum TabIcons {
    static let tasks = image(PixelArt.markRows, pixel: 2)
    static let terminals = image(PixelArt.terminalWindow, pixel: 3)

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
            PixelSprite(rows: PixelArt.lock, pixel: 6, color: .secondary)
            Text("AgentSwitch 已锁定").font(.title3.bold())
            Button("[ unlock with \(lock.biometryName) ]") { Task { await lock.unlock() } }
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
