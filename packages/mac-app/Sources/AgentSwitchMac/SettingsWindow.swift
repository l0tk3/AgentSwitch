import AgentSwitchMacCore
import AppKit
import SwiftUI

/// Opens the settings window on a page, from anywhere in the app.
@MainActor enum SettingsOpener {
    static var show: (SettingsTab) -> Void = { _ in }
}

/// The settings window's pages; the raw value is what `-openSettings <page>` takes.
enum SettingsTab: String, CaseIterable, Identifiable {
    case pairing, nodes, models, redaction, agents, profiles, addons, environment, general
    /// The dispatch (2026-11-24): a session at the 调度台 room (DispatchDeskView).
    case desk

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pairing: return "Pairing"
        case .nodes: return "Nodes"
        case .models: return "Models"
        case .redaction: return "Redaction"
        case .agents: return "Agents"
        case .profiles: return "Profiles"
        case .addons: return "Add-Ons"
        case .environment: return "Environment"
        case .general: return "General"
        case .desk: return "Dispatch"
        }
    }

    var symbol: String {
        switch self {
        case .pairing: return "qrcode"
        case .nodes: return "point.3.connected.trianglepath.dotted"
        case .models: return "cpu"
        case .redaction: return "eye.slash"
        case .agents: return "shippingbox"
        case .profiles: return "person.crop.rectangle.stack"
        case .addons: return "square.stack.3d.up"
        case .environment: return "checklist"
        case .general: return "gearshape"
        case .desk: return "person.crop.circle.badge.checkmark"
        }
    }
}

/// Opens the settings window from a view (the window is AppKit-owned, not a SwiftUI scene).
struct ShowSettingsAction {
    let action: @MainActor (SettingsTab?) -> Void

    @MainActor func callAsFunction(_ tab: SettingsTab?) { action(tab) }
}

/// Opens the main window (docs/dispatch-v0.md §1), on a page or on the one it showed last.
struct ShowMainWindowAction {
    let action: @MainActor (MainPage?) -> Void

    @MainActor func callAsFunction(_ page: MainPage? = nil) { action(page) }
}

struct QuitAction {
    let action: @MainActor () -> Void

    @MainActor func callAsFunction() { action() }
}

extension EnvironmentValues {
    @Entry var showSettings = ShowSettingsAction { _ in }
    @Entry var showMainWindow = ShowMainWindowAction { _ in }
    @Entry var quitApp = QuitAction { NSApp.terminate(nil) }
}

@MainActor
@Observable
final class SettingsNavigation {
    var tab: SettingsTab = .pairing
    /// The first-run wizard's current step while it is open over the window (docs/control-v0.md §6).
    var wizardStep: SetupStep?
    @ObservationIgnored let wizardStore: SetupWizardStore

    init(wizardStore: SetupWizardStore = SetupWizardStore(defaults: .standard)) {
        self.wizardStore = wizardStore
    }

    func select(_ next: SettingsTab) {
        if next != tab { tab = next }
    }

    func openWizard(at step: SetupStep = .executors) { wizardStep = step }

    /// 继续 / 跳过此步: the step counts as passed either way, and the progress is saved before the next one shows.
    func advanceWizard(from step: SetupStep) {
        wizardStore.save((wizardStore.load() ?? .fresh).completing(step))
        wizardStep = step.next
    }

    func backWizard(from step: SetupStep) { wizardStep = step.previous ?? step }

    /// 完成 or 跳过引导: recorded, never opened by itself again.
    func closeWizard(_ outcome: SetupWizardState.Outcome, at step: SetupStep) {
        let state = wizardStore.load() ?? .fresh
        let passed = outcome == .completed ? state.completing(step) : state
        wizardStore.save(passed.closing(outcome, at: Date()))
        wizardStep = nil
    }
}

/// The settings window, hosted in AppKit so it can be opened from anywhere (menu, first run, launch arguments)
/// and brought to the front of an LSUIElement app.
@MainActor
final class SettingsWindowController {
    let navigation = SettingsNavigation()
    private let model: AppModel
    private(set) var window: NSWindow?
    /// Told when the window opens (true) or closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    private var closeObserver: NSObjectProtocol?
    private var pageObserver: NSObjectProtocol?
    private var keyMonitor: Any?

    init(model: AppModel) {
        self.model = model
        pageObserver = NotificationCenter.default.addObserver(forName: Self.pageRequest, object: nil, queue: .main) { [weak self] note in
            let tab = (note.userInfo?["tab"] as? String).flatMap(SettingsTab.init(rawValue:))
            MainActor.assumeIsolated { self?.show(tab) }
        }
    }

    func show(_ tab: SettingsTab? = nil) {
        if let tab { navigation.select(tab) }
        let window = self.window ?? makeWindow()
        self.window = window
        onVisibilityChange(true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Opens the settings window on `tab` from a view that has no hold of the controller.
    nonisolated static func request(_ tab: SettingsTab) {
        NotificationCenter.default.post(name: pageRequest, object: nil, userInfo: ["tab": tab.rawValue])
    }

    private nonisolated static let pageRequest = Notification.Name("AgentSwitchShowSettingsPage")

    /// The first-run wizard over the window (docs/control-v0.md §6), on 环境 so the checklist is behind it.
    func showWizard(at step: SetupStep) {
        show(.environment)
        navigation.openWizard(at: step)
    }

    /// The window, not yet on screen; `-designPreview` draws the same one off-screen. System Settings style: a sidebar
    /// under a unified toolbar that carries the page title and the page's own actions (SwiftUI bridges both).
    static func makeWindow(model: AppModel, navigation: SettingsNavigation, windowClass: NSWindow.Type = NSWindow.self,
                           appearance: NSAppearance? = nil) -> NSWindow {
        let root = SettingsView().environment(model).environment(navigation).followsWindow()
        let window = windowClass.init(contentRect: NSRect(origin: .zero, size: contentSize),
                                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                      backing: .buffered, defer: false)
        window.appearance = appearance
        let controller = NSHostingController(rootView: root)
        controller.sceneBridgingOptions = [.title, .toolbars]
        window.toolbar = NSToolbar(identifier: "settings")
        window.contentViewController = controller
        window.title = "AgentSwitch Settings"
        window.toolbarStyle = .unified
        window.setContentSize(contentSize)
        window.isReleasedWhenClosed = false
        return window
    }

    static let contentSize = NSSize(width: 780, height: 560)

    private func makeWindow() -> NSWindow {
        let window = SettingsWindowController.makeWindow(model: model, navigation: navigation)
        window.center()
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onVisibilityChange(false) }
        }
        watchEditKeys()
        return window
    }

    /// ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z in the window's fields and editors and in its sheets: a menu bar app has no Edit menu to send
    /// them (the main window does the same, MainWindowController.edit).
    private func watchEditKeys() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            nonisolated(unsafe) let key = event
            let taken = MainActor.assumeIsolated { self?.edit(key) ?? false }
            return taken ? nil : event
        }
    }

    private func edit(_ event: NSEvent) -> Bool {
        guard let window, let target = event.window, target === window || target.sheetParent === window,
              target.firstResponder is NSText else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), !flags.contains(.control), !flags.contains(.option) else { return false }
        let action: Selector? = switch (event.charactersIgnoringModifiers?.lowercased() ?? "", flags.contains(.shift)) {
        case ("c", false): #selector(NSText.copy(_:))
        case ("v", false): #selector(NSText.paste(_:))
        case ("x", false): #selector(NSText.cut(_:))
        case ("a", false): #selector(NSText.selectAll(_:))
        case ("z", false): Selector(("undo:"))
        case ("z", true): Selector(("redo:"))
        default: nil
        }
        guard let action else { return false }
        return NSApp.sendAction(action, to: nil, from: target)
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(SettingsTab.allCases) { tab in
                    // Agents: how many installs have an update (docs/agents-v0.md §4). The tag goes on last: with the
                    // badge outside it the list does not take the row for one it may select (macOS 27; the whole
                    // first group could not be clicked, 2026-10-06).
                    Label(tab.title, systemImage: tab.symbol).badge(tab == .agents ? model.agentUpdateCount : 0).tag(tab)
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            VStack(spacing: 0) {
                ErrorBanner()
                page(navigation.tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(navigation.tab.title)
        .background(WindowTitle(title: navigation.tab.title))
        .frame(minWidth: 720, minHeight: 480)
        .tint(.brand)
        .sheet(isPresented: wizardShown) {
            SetupWizardView().environment(model).environment(navigation)
        }
    }

    private var wizardShown: Binding<Bool> {
        Binding(get: { navigation.wizardStep != nil }, set: { if !$0 { navigation.wizardStep = nil } })
    }

    private var selection: Binding<SettingsTab?> {
        Binding(get: { navigation.tab }, set: { if let tab = $0 { navigation.select(tab) } })
    }

    @ViewBuilder
    private func page(_ tab: SettingsTab) -> some View {
        switch tab {
        case .pairing: PairingView()
        case .nodes: NodesView()
        case .models: ModelsView()
        case .redaction: RedactionView()
        case .agents: AgentsSettingsView()
        case .profiles: ProfilesSettingsView()
        case .addons: AddonsView()
        case .environment: EnvironmentView()
        case .desk: DispatchDeskView()
        case .general: GeneralView()
        }
    }
}

/// The page title in the toolbar, as System Settings does (the hosting controller does not bridge a split view's title).
private struct WindowTitle: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        let title = title
        DispatchQueue.main.async { view.window?.title = title }
    }
}

/// The model's last error, above any page until dismissed.
struct ErrorBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let message = model.errorMessage {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.attention)
                    Text(message).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Close") { model.errorMessage = nil }.controlSize(.small)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                Divider()
            }
        }
    }
}
