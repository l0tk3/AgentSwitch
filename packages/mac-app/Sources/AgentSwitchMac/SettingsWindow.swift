import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The settings window's pages; the raw value is what `-openSettings <page>` takes.
enum SettingsTab: String, CaseIterable, Identifiable {
    case pairing, devices, models, permissions, keys, agents, clash, environment, general
    /// The Dispatch group (docs/dispatch-v0.md §3): what the web console's side column and the phone's settings had.
    case context, extensions, log, history

    var id: String { rawValue }

    /// The sidebar's first block, without a header.
    static let app: [SettingsTab] = [.pairing, .devices, .models, .permissions, .keys, .agents, .clash, .environment, .general]
    /// The sidebar's `Dispatch` group; the main window's settings button opens its first page.
    static let dispatch: [SettingsTab] = [.context, .extensions, .log, .history]

    var title: String {
        switch self {
        case .pairing: return "Pairing"
        case .devices: return "Devices"
        case .models: return "Models"
        case .permissions: return "Permissions"
        case .keys: return "Keys"
        case .agents: return "Agents"
        case .clash: return "Clash Integration"
        case .environment: return "Environment"
        case .general: return "General"
        case .context: return "Context"
        case .extensions: return "Extensions"
        case .log: return "Log"
        case .history: return "History"
        }
    }

    var symbol: String {
        switch self {
        case .pairing: return "qrcode"
        case .devices: return "iphone"
        case .models: return "cpu"
        case .permissions: return "checkmark.shield"
        case .keys: return "key"
        case .agents: return "shippingbox"
        case .clash: return "point.3.connected.trianglepath.dotted"
        case .environment: return "checklist"
        case .general: return "gearshape"
        case .context: return "doc.text"
        case .extensions: return "puzzlepiece.extension"
        case .log: return "list.bullet.rectangle"
        case .history: return "clock.arrow.circlepath"
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
    /// Context's files and edits (ContextSettingsStore): kept while the window is closed.
    @ObservationIgnored let context = ContextSettingsStore()
    /// A page asked for while Context has edits not yet saved: the window asks first (Save, Don't Save, Cancel).
    var pendingTab: SettingsTab?

    init(wizardStore: SetupWizardStore = SetupWizardStore(defaults: .standard)) {
        self.wizardStore = wizardStore
    }

    /// Another page; leaving Context with unsaved edits waits for the answer to `pendingTab`.
    func select(_ next: SettingsTab) {
        guard next != tab else { return }
        if tab == .context && context.dirty { pendingTab = next } else { tab = next }
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
    /// Opens a task's page in the main window (History's hits and topics, Log's and Context's links to a task).
    var openTask: (String) -> Void = { _ in }
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

    /// Opens the settings window on `tab` from a view that has no hold of the controller (the main window's settings
    /// button opens the Dispatch group's first page, docs/dispatch-v0.md §1).
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
                           appearance: NSAppearance? = nil, dispatch: DispatchSettingsEnvironment = DispatchSettingsEnvironment()) -> NSWindow {
        let root = SettingsView().environment(model).environment(navigation).environment(\.dispatchSettings, dispatch).followsWindow()
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
        let window = SettingsWindowController.makeWindow(
            model: model, navigation: navigation,
            dispatch: DispatchSettingsEnvironment(openTask: { [weak self] id in self?.openTask(id) }))
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
    @Environment(\.dispatchSettings) private var dispatch

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(SettingsTab.app) { tab in
                    // Agents: how many installs have an update (docs/agents-v0.md §4). The tag goes on last: with the
                    // badge outside it the list does not take the row for one it may select (macOS 27; the whole
                    // first group could not be clicked, 2026-10-06).
                    Label(tab.title, systemImage: tab.symbol).badge(tab == .agents ? model.agentUpdateCount : 0).tag(tab)
                }
                Section("Dispatch") {
                    ForEach(SettingsTab.dispatch) { tab in
                        Label(tab.title, systemImage: tab.symbol).tag(tab)
                    }
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
        .alert("保存更改？", isPresented: leaving, presenting: navigation.pendingTab) { next in
            // Each button dismisses the alert (which clears `pendingTab`); the page changes once the edits are dealt with.
            Button("Save") {
                Task {
                    if await navigation.context.save(DispatchSettingsSource(model: model, environment: dispatch).service) {
                        navigation.tab = next
                    }
                }
            }
            Button("Don't Save", role: .destructive) {
                navigation.context.revert()
                navigation.tab = next
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("\(navigation.context.dirtyFiles.joined(separator: " 和 ")) 有未保存的更改。")
        }
    }

    private var wizardShown: Binding<Bool> {
        Binding(get: { navigation.wizardStep != nil }, set: { if !$0 { navigation.wizardStep = nil } })
    }

    /// Context's unsaved edits, asked about before another page opens.
    private var leaving: Binding<Bool> {
        Binding(get: { navigation.pendingTab != nil }, set: { if !$0 { navigation.pendingTab = nil } })
    }

    private var selection: Binding<SettingsTab?> {
        Binding(get: { navigation.tab }, set: { if let tab = $0 { navigation.select(tab) } })
    }

    @ViewBuilder
    private func page(_ tab: SettingsTab) -> some View {
        switch tab {
        case .pairing: PairingView()
        case .devices: DevicesView()
        case .models: ModelsView()
        case .permissions: PermissionsView()
        case .keys: KeysView()
        case .agents: AgentsView()
        case .clash: ClashIntegrationView()
        case .environment: EnvironmentView()
        case .general: GeneralView()
        case .context: ContextSettingsPage()
        case .extensions: ExtensionsSettingsPage()
        case .log: RoutingLogSettingsPage()
        case .history: HistorySettingsPage()
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
