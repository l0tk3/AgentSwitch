import AgentSwitchMacCore
import AppKit
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case pairing, devices, models, keys, environment, general

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pairing: return "配对"
        case .devices: return "设备"
        case .models: return "模型"
        case .keys: return "密钥"
        case .environment: return "环境"
        case .general: return "通用"
        }
    }

    var symbol: String {
        switch self {
        case .pairing: return "qrcode"
        case .devices: return "iphone"
        case .models: return "cpu"
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

struct QuitAction {
    let action: @MainActor () -> Void

    @MainActor func callAsFunction() { action() }
}

extension EnvironmentValues {
    @Entry var showSettings = ShowSettingsAction { _ in }
    @Entry var quitApp = QuitAction { NSApp.terminate(nil) }
}

@MainActor
@Observable
final class SettingsNavigation {
    var tab: SettingsTab = .pairing
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

    private func makeWindow() -> NSWindow {
        let root = SettingsView().environment(model).environment(navigation)
        let window = NSWindow(contentViewController: NSHostingController(rootView: root))
        window.title = "AgentSwitch 设置"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 720, height: 560))
        window.isReleasedWhenClosed = false
        window.center()
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onVisibilityChange(false) }
        }
        return window
    }
}

struct SettingsView: View {
    @Environment(SettingsNavigation.self) private var navigation

    var body: some View {
        @Bindable var navigation = navigation
        TabView(selection: $navigation.tab) {
            ForEach(SettingsTab.allCases) { tab in
                content(tab)
                    .tabItem { Label(tab.title, systemImage: tab.symbol) }
                    .tag(tab)
            }
        }
        .padding(16)
        .frame(minWidth: 680, minHeight: 520)
        .overlay(alignment: .bottom) { ErrorBanner() }
    }

    @ViewBuilder
    private func content(_ tab: SettingsTab) -> some View {
        switch tab {
        case .pairing: PairingView()
        case .devices: DevicesView()
        case .models: ModelsView()
        case .keys: KeysView()
        case .environment: EnvironmentView()
        case .general: GeneralView()
        }
    }
}

/// The model's last error, dismissible, shown over any tab.
struct ErrorBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let message = model.errorMessage {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(message).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                Button { model.errorMessage = nil } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain)
            }
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .padding(8)
        }
    }
}
