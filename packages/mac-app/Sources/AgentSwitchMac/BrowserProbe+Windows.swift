#if DEBUG
import AgentSwitchMacCore
import AppKit

/// The Browser probe's two walks for the browser with windows of its own (docs/browser-v0.md §7.2; the service is a
/// throw-away one with Camoufox installed and windows on):
///
/// - a service that says `windows`: a tab opened by the service while another app is in front (the browser is started
///   and comes forward: does the front go back, BrowserFrontKeeper), the detail pane with its preview (`window.png`),
///   `Show Window`, the identity box (`identity.png`), a proxy applied (`-browserProbeProxy <scheme://host:port>`, a
///   stand-in on this Mac that answers every outside name and the exit lookup; `identity-proxy.png`), a tab through it,
///   `Restart Browser` for the exit's time zone, `Direct`, `New Fingerprint`, the tabs closed.
/// - `-browserProbeMode engine` on a service without Camoufox: the engine's box (`engine-missing.png`), `Download`, its
///   progress for a few seconds (`engine-progress.png`), `Cancel` (`engine-cancelled.png`).
extension BrowserProbe {
    static var mode: String? { UserDefaults.standard.string(forKey: "browserProbeMode") }
    static var proxy: String? { UserDefaults.standard.string(forKey: "browserProbeProxy") }

    private static func front() -> String { NSWorkspace.shared.frontmostApplication?.localizedName ?? "?" }
    private static func pause(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }
    /// Until the box's work under way is over.
    private static func settle(_ identity: BrowserIdentityModel, upTo seconds: Double = 40) async {
        await pause(0.3)
        for _ in 0..<Int(seconds * 4) where identity.working != nil { await pause(0.25) }
    }

    static func windowsWalk(_ browser: BrowserPageModel, _ window: NSWindow, model: AppModel, file: URL, dir: URL, say: @escaping (String) -> Void) async {
        let identity = browser.identity
        model.browserFront.onNote = { say("  keeper: \($0)") }
        model.browserFront.start()
        say("engine \(browser.list.engine), windows \(browser.list.windows)")

        // 1. The service starts the browser for a tab nobody asked for here: the app in front keeps its place.
        let before = front()
        do {
            let tab = try await model.client.openTab(.path(file.path))
            say("ok   a tab opened by the service: \(tab.id) \(tab.url)")
        } catch { say("FAIL a tab opened by the service: \(BrowserPageModel.describe(error))"); return }
        for wait in [1.0, 1.5, 2.5] {
            await pause(wait)
            say("     front \(before) before; now \(front())")
        }
        say("\(front().localizedCaseInsensitiveContains("camoufox") ? "FAIL" : "ok  ") the browser did not keep the front (\(before) before, \(front()) now)")

        // 2. The page: the list, the detail pane, the still picture.
        await browser.refresh()
        if let id = browser.list.tabs.first?.id { browser.select(id) }
        for _ in 0..<40 where browser.preview == nil { await pause(0.25) }
        if let tab = browser.current {
            say("\(browser.preview != nil ? "ok  " : "FAIL") preview \(browser.preview.map { NSStringFromSize($0.size) } ?? "none"); \(BrowserTabText.title(tab)) · \(BrowserWindowText.who(tab)) · buttons \(BrowserWindowText.buttons(tab).map(BrowserWindowText.word))")
        } else { say("FAIL no tab on the page") }
        await pause(0.5)
        shot(window, dir.appendingPathComponent("window.png"))

        // 3. Show Window: the browser before the other apps, because it was asked for.
        await browser.showWindow()
        await pause(1.5)
        // Handing the front over works from the app in front; this probe's window is behind on purpose, so this only notes it.
        say("note after Show Window the app in front is \(front())")

        // 4. The identity box.
        identity.open = true
        await pause(2.5)
        say("\(identity.identity != nil ? "ok  " : "FAIL") identity: \(identity.statusWord); engine: \(identity.engine.map(BrowserEngineText.camoufox) ?? "-") / \(identity.engineWord ?? "nothing to say")")
        if let fingerprint = identity.identity?.fingerprint { say("     \(BrowserIdentityText.rows(fingerprint).map { "\($0.0) \($0.1)" }.joined(separator: " · "))") }
        shot(window, dir.appendingPathComponent("identity.png"))

        // 5. A proxy, at once; its exit looked up; a tab through it; the time zone after a restart.
        if let proxy {
            identity.draft = BrowserProxyDraft(server: proxy)
            identity.applyProxy()
            await settle(identity)
            say("\(identity.identity?.proxy?.server == proxy ? "ok  " : "FAIL") Apply: \(identity.statusWord); exit \(BrowserIdentityText.exit(identity.identity?.exit)); restart needed \(identity.identity?.restartNeeded ?? false); \(identity.problem ?? "no problem")")
            shot(window, dir.appendingPathComponent("identity-proxy.png"))
            identity.open = false
            let opened = await browser.open(.typed("http://outside.test/hello"))
            for _ in 0..<24 where browser.current?.title != "via upstream" { await pause(0.25); await browser.refresh() }
            say("\(opened && browser.current?.title == "via upstream" ? "ok  " : "FAIL") a tab opened here goes through the proxy: \(browser.current?.title ?? "-") \(browser.openError ?? ""); front \(front())")
            identity.open = true
            await pause(0.5)
            if identity.identity?.restartNeeded == true {
                // The tab above was asked for here; past that, the browser starting again is nobody's wish to see it.
                await pause(BrowserFrontPolicy.askedWindow)
                let tabs = browser.list.tabs.count, was = front()
                identity.restartBrowser()
                await settle(identity)
                await pause(3)
                await browser.refresh()
                say("\(identity.identity?.restartNeeded == false && browser.list.tabs.count == tabs ? "ok  " : "FAIL") Restart Browser: restart needed \(identity.identity?.restartNeeded ?? true), tabs \(browser.list.tabs.count) of \(tabs), time zone \(identity.identity?.fingerprint.timezone ?? "System"); front \(was) before, \(front()) after; \(identity.problem ?? "no problem")")
            }
            identity.direct()
            await settle(identity)
            say("\(identity.identity?.proxy == nil ? "ok  " : "FAIL") Direct: \(identity.statusWord); \(identity.problem ?? "no problem")")
        }

        // 6. A new fingerprint: the browser again, its tabs back.
        let tabs = browser.list.tabs.count, since = identity.identity?.fingerprint.since, cores = identity.identity?.fingerprint.cores
        let was = front()
        await pause(1.1)
        identity.newFingerprint()
        await settle(identity)
        await pause(3)
        await browser.refresh()
        say("\(identity.identity?.fingerprint.since != since && browser.list.tabs.count == tabs ? "ok  " : "FAIL") New Fingerprint: cores \(cores.map(String.init) ?? "-") → \(identity.identity?.fingerprint.cores.map(String.init) ?? "-"), tabs \(browser.list.tabs.count) of \(tabs); front \(was) before, \(front()) after; \(identity.problem ?? "no problem")")
        shot(window, dir.appendingPathComponent("identity-after.png"))
        identity.open = false

        for tab in browser.list.tabs { await browser.close(tab.id) }
        await browser.refresh()
        say("\(browser.list.tabs.isEmpty ? "ok  " : "FAIL") the tabs are closed: \(browser.list.tabs.count) left")
        say("done")
    }

    static func engineWalk(_ browser: BrowserPageModel, _ window: NSWindow, dir: URL, say: @escaping (String) -> Void) async {
        let identity = browser.identity
        identity.open = true
        for _ in 0..<40 where identity.engine?.available == nil && identity.engine?.problem == nil { await pause(0.25) }
        await pause(0.5)
        say("\(identity.engine?.camoufox == nil ? "ok  " : "FAIL") not installed: status bar \"\(identity.engineWord ?? "-")\" · \"\(identity.statusWord)\"; to download \(identity.engine.flatMap(BrowserEngineText.offer) ?? "unknown") \(identity.engine?.problem ?? "")")
        shot(window, dir.appendingPathComponent("engine-missing.png"))
        identity.updateEngine()
        var seen: [String] = []
        for _ in 0..<5 {
            await pause(2)
            if let word = identity.engineWord { seen.append(word) }
        }
        say("\(identity.updating ? "ok  " : "FAIL") Download: \(seen.joined(separator: " → ")); \(identity.problem ?? "no problem")")
        shot(window, dir.appendingPathComponent("engine-progress.png"))
        identity.cancelUpdate()
        for _ in 0..<40 where identity.updating { await pause(0.25) }
        await pause(1)
        say("\(!identity.updating && identity.engine?.camoufox == nil ? "ok  " : "FAIL") Cancel: updating \(identity.updating), status bar \"\(identity.engineWord ?? "-")\", last \(identity.engine?.update.error ?? "no error"); \(identity.problem ?? "no problem")")
        shot(window, dir.appendingPathComponent("engine-cancelled.png"))
        say("done")
    }
}
#endif
