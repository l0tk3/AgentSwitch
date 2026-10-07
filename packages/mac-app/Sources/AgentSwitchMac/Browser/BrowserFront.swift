import AgentSwitchMacCore
import AppKit
import OSLog

private let frontLog = Logger(subsystem: "com.agentswitch.mac", category: "browser-front")

/// The browser's own app among the Mac's apps (docs/browser-v0.md §7.3 窗口): the service brings a tab's window before
/// the browser's other windows; before the other apps is this app's to do, as the person asked for it here.
@MainActor
enum BrowserFront {
    /// The running Camoufox that was started from the engine's folder, if any.
    static func running(agentswitchHome: URL) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { isBrowser($0, agentswitchHome: agentswitchHome) }
    }

    static func isBrowser(_ app: NSRunningApplication, agentswitchHome: URL) -> Bool {
        let engine = BrowserEngineLocation.camoufoxApp(agentswitchHome: agentswitchHome).resolvingSymlinksInPath().standardizedFileURL
        if app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == engine { return true }
        // Started as a program, not through LaunchServices: known by where its program is.
        return app.executableURL?.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(engine.path + "/") ?? false
    }

    /// The browser before the other apps, asked for from this app while it is the one in front: the system lets the
    /// app in front hand its place over.
    static func activate(agentswitchHome: URL) {
        guard let browser = running(agentswitchHome: agentswitchHome) else { return }
        NSApp.yieldActivation(to: browser)
        browser.activate(from: .current, options: [])
    }
}

/// Keeps the browser from taking the front when the service starts it (BrowserFrontPolicy): it remembers which app was
/// in front, and when the browser comes forward just after it was started — and nobody asked for its window here — it
/// puts that app back. The browser's windows stay where they are, behind.
@MainActor
final class BrowserFrontKeeper {
    private let home: URL
    private var previous: NSRunningApplication?
    /// When each browser process was first seen, and how often it was sent back.
    private var started: [pid_t: (at: Date, done: Int)] = [:]
    private var askedAt: Date?
    private var observers: [NSObjectProtocol] = []
    /// What was done, in words (the probe's log).
    var onNote: (String) -> Void = { _ in }

    init(agentswitchHome: URL) {
        home = agentswitchHome
    }

    func start() {
        guard observers.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        if let front = NSWorkspace.shared.frontmostApplication, !BrowserFront.isBrowser(front, agentswitchHome: home) { previous = front }
        // The process's number crosses to the main actor; the running app is looked up there.
        func observe(_ name: Notification.Name, _ body: @escaping @MainActor (BrowserFrontKeeper, pid_t) -> Void) {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier else { return }
                MainActor.assumeIsolated { if let self { body(self, pid) } }
            })
        }
        observe(NSWorkspace.didLaunchApplicationNotification) { keeper, pid in
            if let app = NSRunningApplication(processIdentifier: pid), BrowserFront.isBrowser(app, agentswitchHome: keeper.home) { keeper.seen(app) }
        }
        observe(NSWorkspace.didTerminateApplicationNotification) { keeper, pid in keeper.started[pid] = nil }
        observe(NSWorkspace.didActivateApplicationNotification) { keeper, pid in
            if let app = NSRunningApplication(processIdentifier: pid) { keeper.activated(app) }
        }
    }

    /// The person asked for the browser's window here (`Show Window`, a tab opened on the Browser page).
    func asked() { askedAt = Date() }

    @discardableResult
    private func seen(_ app: NSRunningApplication) -> (at: Date, done: Int) {
        if let known = started[app.processIdentifier] { return known }
        let entry = (at: Date(), done: 0)
        started[app.processIdentifier] = entry
        return entry
    }

    private func activated(_ app: NSRunningApplication) {
        guard BrowserFront.isBrowser(app, agentswitchHome: home) else { previous = app; return }
        let entry = seen(app), now = Date()
        let target = previous.flatMap { $0.isTerminated ? nil : $0 }
        let sinceStarted = now.timeIntervalSince(entry.at), sinceAsked = askedAt.map { now.timeIntervalSince($0) }
        let sinceClick = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .leftMouseDown)
        let gives = BrowserFrontPolicy.givesBack(sinceStarted: sinceStarted, sinceAsked: sinceAsked, sinceClick: sinceClick, hasPrevious: target != nil, done: entry.done)
        note(String(format: "the browser came forward %.1f s after it was first seen (asked here %@, last click %.1f s ago, sent back %d): %@",
                    sinceStarted, sinceAsked.map { String(format: "%.1f s ago", $0) } ?? "never", sinceClick, entry.done,
                    gives ? "gives the front back to \(target?.localizedName ?? "?")" : "stays"))
        guard gives, let target else { return }
        started[app.processIdentifier] = (entry.at, entry.done + 1)
        giveBack(to: target, from: app)
    }

    /// The app that was in front, in front again. Asking it to come forward is refused by the system at times (this app
    /// is not the one in front); hiding the browser and showing it again hands the front back without asking.
    private func giveBack(to target: NSRunningApplication, from browser: NSRunningApplication) {
        let name = target.localizedName ?? "?"
        let asked = target == NSRunningApplication.current ? { NSApp.activate(ignoringOtherApps: true); return true }() : target.activate()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != browser.processIdentifier {
                note("front given back to \(name) (asked: \(asked))")
                return
            }
            browser.hide()
            try? await Task.sleep(for: .milliseconds(350))
            browser.unhide()
            try? await Task.sleep(for: .milliseconds(350))
            let front = NSWorkspace.shared.frontmostApplication
            note("front after hiding and showing the browser: \(front?.localizedName ?? "?") (wanted \(name))")
        }
    }

    private func note(_ text: String) {
        frontLog.info("\(text, privacy: .public)")
        onNote(text)
    }
}
