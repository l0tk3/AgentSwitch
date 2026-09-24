import AgentSwitchMacCore
import AppKit
import SwiftUI

/// Debug aid for smoke tests: `-snapshotDir <dir>` renders the menu panel and every settings tab to PNG once the
/// runtime is up (no screen-recording permission needed: views draw into their own bitmaps), then quits.
@MainActor
struct SnapshotRunner {
    let model: AppModel
    let settings: SettingsWindowController
    let directory: URL
    let quit: @MainActor () -> Void
    static let startupWait: TimeInterval = 40

    func start() {
        Task {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let deadline = Date().addingTimeInterval(SnapshotRunner.startupWait)
            while Date() < deadline && !(model.daemonReady && model.remote != nil && !model.harnesses.isEmpty) {
                try? await Task.sleep(for: .milliseconds(500))
            }
            try? await Task.sleep(for: .seconds(2))
            renderMenu()
            for tab in SettingsTab.allCases {
                settings.show(tab)
                try? await Task.sleep(for: .seconds(tab == .pairing ? 1 : 2))
                if tab == .pairing { await pressGenerate() }
                if let view = settings.window?.contentView { write(view, name: "settings-\(tab.rawValue)") }
            }
            quit()
        }
    }

    /// The menu panel is only on screen after a click; host the same view in an off-screen window instead.
    private func renderMenu() {
        let host = NSHostingView(rootView: MenuContentView().environment(model))
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        write(host, name: "menu")
    }

    /// Pairing needs a code on screen: the same call the button makes.
    private func pressGenerate() async {
        await model.pairingSession.start(model: model)
        try? await Task.sleep(for: .seconds(1))
    }

    private func write(_ view: NSView, name: String) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }
}
