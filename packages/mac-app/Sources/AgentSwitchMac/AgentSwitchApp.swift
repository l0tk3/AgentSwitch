import AgentSwitchMacCore
import AppKit
import SwiftUI

@main
struct AgentSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environment(delegate.model)
                .environment(\.showSettings, ShowSettingsAction { [delegate] tab in delegate.settings.show(tab) })
                .environment(\.quitApp, QuitAction { [delegate] in delegate.quit() })
        } label: {
            MenuBarIcon(level: delegate.model.overallLevel)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Owns the model, stops the children before the app quits, and turns SIGTERM/SIGINT into a normal quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    lazy var settings = SettingsWindowController(model: model)
    private var signalSources: [DispatchSourceSignal] = []
    private var shutdownDone = false
    private var quitting = false
    /// Held until the process exits: this copy is the one that looks after the children of its AGENTSWITCH_HOME.
    private var instanceLock: InstanceLock?
    /// Posted by a second copy that found the lock taken; the object is the lock file's path, so only the copy
    /// holding that lock reacts. It carries no payload, and all it does is bring up the settings window.
    static let anotherCopyOpened = Notification.Name("com.agentswitch.mac.anotherCopyOpened")

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard claimInstance() else { return }
        // The bundle has LSUIElement; `swift run` has no bundle, so decide the Dock presence here in both cases.
        settings.onVisibilityChange = { [weak self] open in self?.updateDockPresence(settingsWindowOpen: open) }
        updateDockPresence(settingsWindowOpen: false)
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.quit() }
            source.resume()
            signalSources.append(source)
        }
        model.launch()
        let defaults = UserDefaults.standard
        if let tab = defaults.string(forKey: "openSettings").flatMap(SettingsTab.init(rawValue:)) {
            settings.show(tab)
        } else if !defaults.bool(forKey: "onboarded") {
            defaults.set(true, forKey: "onboarded")
            settings.show(.environment)
        }
        if let dir = defaults.string(forKey: "snapshotDir") {
            SnapshotRunner(model: model, settings: settings, directory: URL(fileURLWithPath: dir), quit: { [weak self] in self?.quit() }).start()
        }
    }

    /// One copy per AGENTSWITCH_HOME (InstanceLock), taken before any pid file, port or child is touched. A second
    /// copy wakes the first (which opens its settings window and says what happened) and quits.
    private func claimInstance() -> Bool {
        let lockFile = model.paths.appLockFile
        switch InstanceLock.acquire(at: lockFile) {
        case .acquired(let lock):
            instanceLock = lock
            DistributedNotificationCenter.default().addObserver(self, selector: #selector(heardFromAnotherCopy(_:)),
                                                                name: AppDelegate.anotherCopyOpened, object: lockFile.path,
                                                                suspensionBehavior: .deliverImmediately)
            return true
        case .held(let pid):
            handOver(to: pid, lockFile: lockFile)
            return false
        case .failed(let why):
            model.errorMessage = "没能确认只有一个 AgentSwitch 在运行：\(why)。如果同时开着两个 AgentSwitch，请退出其中一个。"
            return true
        }
    }

    private func handOver(to pid: Int32?, lockFile: URL) {
        let holder = pid.map { "pid \($0)" } ?? "pid unknown"
        FileHandle.standardError.write(Data("AgentSwitch is already running for \(model.paths.agentswitchHome.path) (\(holder)); this copy quits.\n".utf8))
        if let pid, let first = NSRunningApplication(processIdentifier: pid) {
            NSApp.yieldActivation(to: first)
            first.activate()
        }
        DistributedNotificationCenter.default().postNotificationName(AppDelegate.anotherCopyOpened, object: lockFile.path,
                                                                     userInfo: nil, deliverImmediately: true)
        shutdownDone = true   // nothing was started
        NSApp.terminate(nil)
    }

    @objc private func heardFromAnotherCopy(_ note: Notification) {
        model.errorMessage = "AgentSwitch 已经在运行（\(Bundle.main.bundlePath)）。刚才又打开了一个 AgentSwitch，它已自动退出：同一个数据目录只能由一个 AgentSwitch 看护服务。要换用另一个，先在菜单栏里退出这一个。"
        settings.show(nil)
    }

    /// Dock icon: while the settings window is open, or always when the user asked for it (DockPresence).
    func updateDockPresence(settingsWindowOpen: Bool) {
        let always = UserDefaults.standard.bool(forKey: DockPresence.alwaysShowKey)
        NSApp.setActivationPolicy(DockPresence.showsInDock(alwaysShow: always, settingsWindowOpen: settingsWindowOpen) ? .regular : .accessory)
    }

    /// Clicking the Dock icon (or opening the app again from Finder) brings up the settings window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        settings.show(nil)
        return true
    }

    /// Our own quit (menu, signals): stop the children first, then terminate with nothing left to wait for.
    /// Calling `terminate` from a main-queue block and answering `.terminateLater` would deadlock: AppKit's
    /// modal wait runs inside that block, so the MainActor task doing the shutdown could never run.
    func quit() {
        guard !quitting else { return }
        quitting = true
        Task {
            await model.shutdown()
            shutdownDone = true
            NSApp.terminate(nil)
        }
    }

    /// Quits AppKit starts itself (logout, restart, Dock): same shutdown, answered later.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shutdownDone { return .terminateNow }
        guard !quitting else { return .terminateCancel }
        quitting = true
        Task {
            await model.shutdown()
            shutdownDone = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

struct MenuBarIcon: View {
    let level: StatusLevel

    var body: some View {
        switch level {
        case .ok: Image(systemName: "antenna.radiowaves.left.and.right")
        case .busy, .off: Image(systemName: "antenna.radiowaves.left.and.right.slash")
        case .warning, .error: Image(systemName: "exclamationmark.triangle")
        }
    }
}
