import AgentSwitchMacCore
import AppKit
import SwiftUI

@main
struct AgentSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // Hidden while this copy only waits on a newly installed one (AppModel.installUpdate).
        MenuBarExtra(isInserted: Binding(get: { !delegate.model.updating && !AppDelegate.previewOnly }, set: { _ in })) {
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
    /// This copy holds the lock and started the runtime (a second copy that hands over never does).
    private var running = false
    /// Held until the process exits: this copy is the one that looks after the children of its AGENTSWITCH_HOME.
    private var instanceLock: InstanceLock?
    /// Posted by a second copy that found the lock taken; the object is the lock file's path, so only the copy
    /// holding that lock reacts. It carries no payload, and all it does is bring up the settings window.
    static let anotherCopyOpened = Notification.Name("com.agentswitch.mac.anotherCopyOpened")

    /// `-designPreview <dir>`: draw the UI with sample data and quit (DesignPreview); no menu bar item, nothing started.
    static var previewOnly: Bool {
        #if DEBUG
        return DesignPreview.directory != nil
        #else
        return false
        #endif
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let directory = DesignPreview.directory {
            DesignPreview.run(model: model, into: directory)
            return
        }
        #endif
        guard claimInstance() else { return }
        running = true
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
        model.releaseInstance = { [weak self] in
            self?.instanceLock?.release()
            self?.instanceLock = nil
        }
        model.exitApp = { [weak self] in
            self?.shutdownDone = true   // the children were stopped before the switch
            NSApp.terminate(nil)
        }
        model.launch()
        let defaults = UserDefaults.standard
        if let tab = defaults.string(forKey: "openSettings").flatMap(SettingsTab.init(rawValue:)) {
            settings.show(tab)
        } else if !SetupWizardLaunch.truthy(defaults.volatileDomain(forName: UserDefaults.argumentDomain)["onboarded"]) {
            offerSetupWizard()
        }
        if let dir = defaults.string(forKey: "snapshotDir") {
            SnapshotRunner(model: model, settings: settings, directory: URL(fileURLWithPath: dir), quit: { [weak self] in self?.quit() }).start()
        }
    }

    /// The first-run wizard (docs/control-v0.md §6), once: shown to someone without a paired phone, recorded as done
    /// without showing for someone who has one. Waits for the daemon's device list, at most SetupWizardLaunch.deviceWait.
    /// `-onboarded YES` on the command line skips it for that launch.
    private func offerSetupWizard() {
        let store = settings.navigation.wizardStore
        let started = Date()
        Task { [weak self] in
            while let self {
                let known = self.model.devicesKnown ? self.model.activeDevices.count : nil
                let waited = Date().timeIntervalSince(started) > SetupWizardLaunch.deviceWait
                switch SetupWizardLaunch.decide(state: store.load(), pairedDevices: known, gaveUpWaiting: waited) {
                case .wait:
                    try? await Task.sleep(for: .seconds(1))
                    continue
                case .show(let step):
                    self.settings.showWizard(at: step)
                case .markAlreadySetUp:
                    store.save((store.load() ?? .fresh).closing(.alreadySetUp, at: Date()))
                case .nothing:
                    break
                }
                return
            }
        }
    }

    /// Back from Terminal after 登录, or from installing something: check the environment again (AppModel).
    func applicationDidBecomeActive(_ notification: Notification) {
        guard running else { return }
        model.appBecameActive()
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
            model.errorMessage = "无法确认是否只有一个 AgentSwitch 在运行：\(why)。如有两个 AgentSwitch 同时运行，请退出其中一个。"
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
        model.errorMessage = "AgentSwitch 已在运行（\(DisplayPath.short(Bundle.main.bundlePath, home: NSHomeDirectory()))），新打开的副本已自动退出：每个数据目录只能由一个 AgentSwitch 管理。如需改用另一个副本，请从菜单栏退出当前副本后再打开。"
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
        Image(nsImage: MenuBarGlyph.image(level))
    }
}
