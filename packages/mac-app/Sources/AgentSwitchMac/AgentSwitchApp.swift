import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftUI

private let presentationLog = Logger(subsystem: "com.agentswitch.mac", category: "presentation")

@main
struct AgentSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() { SoftType.apply() }

    var body: some Scene {
        // Hidden while this copy only waits on a newly installed one (AppModel.installUpdate).
        MenuBarExtra(isInserted: Binding(get: { !delegate.model.updating && !AppDelegate.previewOnly && !AppDelegate.liveDemoOnly && !AppDelegate.probeOnly }, set: { _ in })) {
            MenuContentView()
                .environment(delegate.model)
                .environment(\.showSettings, ShowSettingsAction { [delegate] tab in delegate.settings.show(tab) })
                .environment(\.showMainWindow, ShowMainWindowAction { [delegate] page in delegate.main.show(page) })
                .environment(\.quitApp, QuitAction { [delegate] in delegate.quit() })
                // The mark stops while the panel is closed (ui-v0 §7.4).
                .followsWindow()
        } label: {
            MenuBarIcon(level: delegate.model.overallLevel, waiting: delegate.model.waitingCount)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The app's text is drawn without the system's font smoothing — the thickening of strokes macOS adds to text —, as
/// a browser's `antialiased` text is, which is how both agents' own desktop apps (Electron) look: lighter, softer
/// (docs/ui-v0.md §8, 2026-10-07; user, of Codex's conversation: 字体看上去比我们的app柔和). Measured on a specimen of
/// the same paragraph: the size and the leading are a small part of it, this is most of it. The system reads the
/// setting (`AppleFontSmoothing`, this app's own) once, when it first draws text: it is written as the app starts,
/// before anything is drawn. A value someone set by hand (`defaults write`) is left as it is.
enum SoftType {
    static let key = "AppleFontSmoothing"

    static func apply(_ defaults: UserDefaults = .standard) {
        if defaults.object(forKey: key) == nil { defaults.set(0, forKey: key) }
    }
}

/// Owns the model, stops the children before the app quits, and turns SIGTERM/SIGINT into a normal quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    lazy var settings = SettingsWindowController(model: model)
    /// The main window, Dispatch and Terminals (docs/dispatch-v0.md §1).
    lazy var main = MainWindowController(model: model)
    /// Terminals in windows of their own, beside the main window (docs/dispatch-v0.md §1 单独的窗口).
    lazy var windows = TerminalWindows(client: { [model] in model.client })
    /// The menu bar's Live Activity (assistant-v0 §4): its own status item, left of the app's. A task opens on the main
    /// window's Dispatch page, a terminal on its Terminals page; what is open there in the window in use needs no telling.
    lazy var live = LiveActivity(model: model, openTerminal: { [weak self] id in self?.main.show(terminal: id) },
                                 openTask: { [weak self] id in self?.main.show(task: id) },
                                 watching: { [weak self] in (self?.main.watchingTerminals ?? []).union(self?.windows.watching ?? []) },
                                 watchingTask: { [weak self] in self?.main.watchingTask })
    /// Which of our windows are open: the Dock icon shows while any is.
    private var openWindows: Set<String> = []
    private var signalSources: [DispatchSourceSignal] = []
    private var lookObserver: NSObjectProtocol?
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

    /// `-terminalProbe <dir>` / `-dispatchProbe <dir>` / `-browserProbe <dir>`: the main window on one page alone against
    /// a running service (TerminalProbe.swift, DispatchProbe.swift, BrowserProbe.swift).
    static var probeOnly: Bool {
        #if DEBUG
        return TerminalProbe.directory != nil || DispatchProbe.directory != nil || BrowserProbe.directory != nil || PerfProbe.directory != nil
        #else
        return false
        #endif
    }

    /// `-liveDemo YES`: the menu bar's Live Activity alone, from made-up work (LiveDemo.swift); nothing else starts.
    static var liveDemoOnly: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "liveDemo")
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
        if Self.liveDemoOnly {
            NSApp.setActivationPolicy(.accessory)
            live.startDemo()
            return
        }
        if let dir = TerminalProbe.directory {
            NSApp.setActivationPolicy(.accessory)
            wireWindows()
            TerminalProbe.run(main, into: dir)
            return
        }
        if let dir = DispatchProbe.directory {
            NSApp.setActivationPolicy(.accessory)
            DispatchProbe.run(main, model: model, into: dir)
            return
        }
        if let dir = BrowserProbe.directory {
            NSApp.setActivationPolicy(.accessory)
            BrowserProbe.run(main, model: model, into: dir)
            return
        }
        if let dir = PerfProbe.directory {
            NSApp.setActivationPolicy(.accessory)
            PerfProbe.run(main, model: model, into: dir)
            return
        }
        #endif
        guard claimInstance() else { return }
        running = true
        model.browserFront.start()
        // The app has a main window (Dispatch, Terminals): the Dock icon is there by default (settings can take it away).
        UserDefaults.standard.register(defaults: [DockPresence.alwaysShowKey: true])
        let atLogin = Self.launchedAtLogin
        // The bundle has LSUIElement; `swift run` has no bundle, so decide the Dock presence here in both cases.
        settings.onVisibilityChange = { [weak self] open in self?.windowVisibility("settings", open) }
        main.onVisibilityChange = { [weak self] open in self?.windowVisibility("main", open) }
        main.openSettings = { [weak self] in self?.settings.show(nil) }
        wireWindows()
        windows.onVisibilityChange = { [weak self] open in self?.windowVisibility("terminal-windows", open) }
        settings.openTask = { [weak self] id in self?.main.show(task: id) }
        live.onSnapshot = { [weak self] snapshot in self?.main.liveChanged(snapshot) }
        updateDockPresence(settingsWindowOpen: false)
        // The Dock's icon is the look's (DockIcon): now, and whenever the setting changes.
        DockIcon.follow()
        lookObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { DockIcon.follow() }
        }
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
        live.start()
        let defaults = UserDefaults.standard
        if let tab = defaults.string(forKey: "openSettings").flatMap(SettingsTab.init(rawValue:)) {
            settings.show(tab)
        } else if !SetupWizardLaunch.truthy(defaults.volatileDomain(forName: UserDefaults.argumentDomain)["onboarded"]) {
            offerSetupWizard()
        }
        if let dir = defaults.string(forKey: "snapshotDir") {
            SnapshotRunner(model: model, settings: settings, directory: URL(fileURLWithPath: dir), quit: { [weak self] in self?.quit() }).start()
        }
        // Opened by the user, the app opens its main window; not at login, and not over a settings tab asked for,
        // the first-run wizard (until it has been through) or a snapshot run.
        if !atLogin, defaults.string(forKey: "openSettings") == nil, defaults.string(forKey: "snapshotDir") == nil,
           settings.navigation.wizardStore.load()?.isClosed == true {
            showMainWhenReady()
        }
    }

    /// Started by macOS at login (the open-application event says so), not by the user.
    private static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == AEEventID(kAEOpenApplication) else { return false }
        return event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    /// The main window once the service answers (its Terminals page signs in to it); a minute at most.
    private func showMainWhenReady() {
        Task { [weak self] in
            for _ in 0..<120 {
                guard let self else { return }
                if self.model.daemonReady { self.main.show(); return }
                try? await Task.sleep(for: .milliseconds(500))
            }
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

    /// The look at the app's presentation options under way (watchPresentation).
    private var presentationTask: Task<Void, Never>?

    /// Back from Terminal after 登录, or from installing something: check the environment again (AppModel).
    func applicationDidBecomeActive(_ notification: Notification) {
        guard running else { return }
        model.appBecameActive()
        watchPresentation()
    }

    /// A request to hide the menu bar that outlived full screen is taken back (StalePresentation): looked at twice, a
    /// moment apart, each time the app comes to the front.
    private func watchPresentation() {
        presentationTask?.cancel()
        presentationTask = Task { @MainActor in
            var watch = StalePresentation.Watch()
            for _ in 0..<2 {
                try? await Task.sleep(for: .seconds(StalePresentation.interval))
                guard !Task.isCancelled, NSApp.isActive else { return }
                let options = NSApp.presentationOptions
                let fullScreen = NSApp.windows.contains { $0.styleMask.contains(.fullScreen) }
                if watch.shouldReset(options: options.rawValue, anyWindowFullScreen: fullScreen) {
                    presentationLog.error("presentation options \(options.rawValue, privacy: .public) with no window full screen (system: \(NSApp.currentSystemPresentationOptions.rawValue, privacy: .public)); taken back")
                    NSApp.presentationOptions = []
                }
            }
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

    /// The main window and the terminals' own windows, each told of the other (docs/dispatch-v0.md §1 单独的窗口).
    private func wireWindows() {
        main.windows = windows
        windows.onChange = { [weak self] ids in self?.main.detachedChanged(ids) }
        windows.mainFrame = { [weak self] in self?.main.window?.frame }
        windows.newTerminal = { [weak self] in self?.main.newTerminal() }
        windows.onError = { [weak self] message in self?.model.errorMessage = message }
    }

    private func windowVisibility(_ name: String, _ open: Bool) {
        if open { openWindows.insert(name) } else { openWindows.remove(name) }
        updateDockPresence(settingsWindowOpen: !openWindows.isEmpty)
    }

    /// Dock icon: while the settings or main window is open, or always when the user asked for it (DockPresence).
    func updateDockPresence(settingsWindowOpen: Bool) {
        let always = UserDefaults.standard.bool(forKey: DockPresence.alwaysShowKey)
        NSApp.setActivationPolicy(DockPresence.showsInDock(alwaysShow: always, settingsWindowOpen: settingsWindowOpen) ? .regular : .accessory)
    }

    /// Clicking the Dock icon (or opening the app again from Finder) brings up the main window on the page it showed
    /// last (Dispatch the first time); the settings window while the service is not up.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if model.daemonReady { main.show() } else { settings.show(nil) }
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
        if Self.userAskedToQuit && !confirmQuit() { return .terminateCancel }
        quitting = true
        Task {
            await model.shutdown()
            shutdownDone = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

extension AppDelegate {
    /// ⌘Q or the Dock's Quit: no reason comes with it, unlike logout, restart or shutdown (which are not asked about).
    static var userAskedToQuit: Bool {
        NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason)) == nil
    }

    static let quitWithoutAskingKey = "quitWithoutAsking"

    /// The app is also the service: say what stops before it does (a Dock app is quit out of habit to close a window).
    func confirmQuit() -> Bool {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Self.quitWithoutAskingKey) { return true }
        let alert = NSAlert()
        alert.messageText = "退出 AgentSwitch？"
        alert.informativeText = "退出后服务停止：正在运行的终端和任务将中断，手机也无法连接。只关闭窗口时，请点窗口左上角的关闭按钮。"
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "不再询问"
        NSApp.activate(ignoringOtherApps: true)
        let quit = alert.runModal() == .alertFirstButtonReturn
        if quit, alert.suppressionButton?.state == .on { defaults.set(true, forKey: Self.quitWithoutAskingKey) }
        return quit
    }
}

struct MenuBarIcon: View {
    let level: StatusLevel
    /// Things waiting for the user: the mark shows it, as the menu's header does.
    var waiting = 0
    /// The look kept in the settings: the mark is drawn smooth in the classic one, and again when the look changes.
    @AppStorage(InterfaceLook.key) private var appearance = InterfaceLook.pixel.rawValue

    var body: some View {
        Image(nsImage: MenuBarGlyph.image(level, waiting: waiting, look: InterfaceLook.load(appearance)))
    }
}
