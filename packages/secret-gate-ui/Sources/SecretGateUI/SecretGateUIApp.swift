import AppKit
import SwiftUI

@main
struct SecretGateUIApp: App {
    @StateObject private var state = AppState()

    init() {
        // Running from `swift run` has no app bundle; ask AppKit to behave like a normal windowed app.
        NSApplication.shared.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApplication.shared.activate(ignoringOtherApps: true) }
    }

    var body: some Scene {
        WindowGroup("secret-gate") {
            ContentView()
                .environmentObject(state)
                .frame(minWidth: 900, minHeight: 560)
                .onAppear { state.refreshKeys() }
        }
        .defaultSize(width: 1040, height: 640)

        Settings {
            SettingsView().environmentObject(state)
        }
    }
}
