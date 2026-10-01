import AgentSwitchMacCore
import AppKit
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case pairing, devices, models, permissions, keys, environment, general

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pairing: return "Pairing"
        case .devices: return "Devices"
        case .models: return "Models"
        case .permissions: return "Permissions"
        case .keys: return "Keys"
        case .environment: return "Environment"
        case .general: return "General"
        }
    }

    var symbol: String {
        switch self {
        case .pairing: return "qrcode"
        case .devices: return "iphone"
        case .models: return "cpu"
        case .permissions: return "checkmark.shield"
        case .keys: return "key"
        case .environment: return "checklist"
        case .general: return "gearshape"
        }
    }
}

/// Opens the settings window from a view (the window is AppKit-owned, not a SwiftUI scene).
struct ShowSettingsAction {
    let action: @MainActor (SettingsTab?) -> Void

    @MainActor func callAsFunction(_ tab: SettingsTab?) { action(tab) }
}

/// Opens the terminal window (docs/terminal-v0.md §1).
struct ShowTerminalsAction {
    let action: @MainActor () -> Void

    @MainActor func callAsFunction() { action() }
}

struct QuitAction {
    let action: @MainActor () -> Void

    @MainActor func callAsFunction() { action() }
}

extension EnvironmentValues {
    @Entry var showSettings = ShowSettingsAction { _ in }
    @Entry var showTerminals = ShowTerminalsAction {}
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

    init(model: AppModel) {
        self.model = model
    }

    func show(_ tab: SettingsTab? = nil) {
        if let tab { navigation.tab = tab }
        let window = self.window ?? makeWindow()
        self.window = window
        onVisibilityChange(true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// The first-run wizard over the window (docs/control-v0.md §6), on 环境 so the checklist is behind it.
    func showWizard(at step: SetupStep) {
        show(.environment)
        navigation.openWizard(at: step)
    }

    /// The window, not yet on screen; `-designPreview` draws the same one off-screen. System Settings style: a sidebar
    /// under a unified toolbar that carries the page title and the page's own actions (SwiftUI bridges both).
    static func makeWindow(model: AppModel, navigation: SettingsNavigation, windowClass: NSWindow.Type = NSWindow.self,
                           appearance: NSAppearance? = nil) -> NSWindow {
        let root = SettingsView().environment(model).environment(navigation)
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
        return window
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(SettingsTab.allCases) { tab in
                    Label(tab.title, systemImage: tab.symbol).tag(tab)
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
            // The wizard shows it itself while it is up: one sheet at a time.
            .gateServiceSheet(model, active: navigation.wizardStep == nil)
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
        Binding(get: { navigation.tab }, set: { if let tab = $0 { navigation.tab = tab } })
    }

    @ViewBuilder
    private func page(_ tab: SettingsTab) -> some View {
        switch tab {
        case .pairing: PairingView()
        case .devices: DevicesView()
        case .models: ModelsView()
        case .permissions: PermissionsView()
        case .keys: KeysView()
        case .environment: EnvironmentView()
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
