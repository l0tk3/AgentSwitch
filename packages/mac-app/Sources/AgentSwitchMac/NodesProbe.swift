#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-nodesProbe <dir>` (debug builds, with `-localPort` and AGENTSWITCH_HOME of a running service that is paired with
/// another node — two throw-away `AGENTSWITCH_ROUTER=echo` daemons, as packages/daemon/scripts/mesh_smoke.sh starts
/// them): the main window behind every other window (the app is not made active), first on this node's own pages
/// (`own.png`; `page-change.png` a tenth of a second into a change of page, with a line in `calls.txt` saying whether
/// it was being drawn in — the pixel look — or there at once — the classic one), then on the other node's by the call the bar's node menu makes (`node-dispatch.png`,
/// `node-terminals.png`), then back (`back.png`); Settings › Nodes from the service's own answers
/// (`settings-nodes.png`); and what the calls through the other node returned (`calls.txt`), so the client's decoding
/// is checked against a real service on the far side of a real connection. Then the other node in a window of its own
/// (`window-node.png`), asked for again from the main window (the other comes forward, the main one stays), and its
/// strip put away by a click on its `×` (`window-node-strip-hidden.png`). Nothing else of the app starts.
@MainActor
enum NodesProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "nodesProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ windows: MainWindows, model: AppModel, into dir: URL) {
        let main = windows.main
        model.probeServiceUp()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        MainWindowController.probing = true
        Task {
            let ok = await go(windows, model: model, into: dir)
            exit(ok ? 0 : 1)
        }
    }

    private static func go(_ windows: MainWindows, model: AppModel, into dir: URL) async -> Bool {
        let main = windows.main
        var lines: [String] = []
        func step(_ name: String, _ body: () async throws -> String) async {
            do { lines.append("ok   \(name): \(try await body())") } catch { lines.append("FAIL \(name): \(error)") }
        }
        func write() { try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("calls.txt"), atomically: true, encoding: .utf8) }
        await model.refreshDevices()
        await model.nodes.refresh(model)
        await model.nodes.loadMesh(model)
        await step("nodes") { try await model.client.nodes().nodes.map { "\($0.name)=\($0.state.rawValue)@\($0.address ?? "-") inbound=\($0.inbound != nil)" }.joined(separator: " ") }
        await step("mesh settings") { "keyboard=\(try await model.client.meshSettings().keyboard)" }
        main.show(.dispatch)
        try? await Task.sleep(for: .seconds(4))
        shot(main.window?.contentView, dir.appendingPathComponent("own.png"))
        // A page change as a click on the rail makes it, a tenth of a second in: the page being drawn in from the top
        // in the pixel look, simply there in the classic one (`ScanRefresh.plays`).
        main.switchPage(to: .terminals)
        try? await Task.sleep(for: .milliseconds(100))
        lines.append("ok   page change, 0.1 s in (\(InterfaceLook.current.rawValue)): \(main.probeRefreshing ? "being drawn in" : "there at once")")
        shot(main.window?.contentView, dir.appendingPathComponent("page-change.png"))
        try? await Task.sleep(for: .seconds(1))
        main.switchPage(to: .dispatch)
        try? await Task.sleep(for: .seconds(1))
        guard let node = model.nodes.nodes.first(where: { $0.state == .online }) else {
            lines.append("FAIL no node of this service answers")
            write()
            return false
        }
        // The call the bar's node menu makes.
        main.use(node: node)
        try? await Task.sleep(for: .seconds(5))
        shot(main.window?.contentView, dir.appendingPathComponent("node-dispatch.png"))
        let there = main.probeClient
        await step("there: is another node's") { "remote=\(there.isRemote) prefix=\(there.nodePrefix) screens=\(TerminalSizeHolder.screen(onNodeAs: there.screenOwner, unique: "x"))" }
        await step("there: node") { let i = try await there.nodeInfo(); return "\(i.name) kind=\(i.kind) has=\(i.has.joined(separator: ","))" }
        await step("there: live") { let l = try await there.live(); return "rows=\(l.rows.count)" }
        await step("there: terminals") { "\(try await there.terminals().terminals.count) terminal(s)" }
        await step("there: what a paired node may not reach (a FAIL is right)") { _ = try await there.devices(); return "REACHED the device list" }
        main.show(.terminals)
        try? await Task.sleep(for: .seconds(4))
        shot(main.window?.contentView, dir.appendingPathComponent("node-terminals.png"))
        // The strip's way back.
        main.use(node: nil)
        try? await Task.sleep(for: .seconds(3))
        main.show(.dispatch)
        try? await Task.sleep(for: .seconds(2))
        shot(main.window?.contentView, dir.appendingPathComponent("back.png"))
        await own(node, windows: windows, into: dir) { lines.append($0) }
        let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
        navigation.tab = .nodes
        let settings = SettingsWindowController.makeWindow(model: model, navigation: navigation, appearance: NSAppearance(named: .darkAqua))
        try? await Task.sleep(for: .seconds(3))
        shot(settings.contentView?.superview ?? settings.contentView, dir.appendingPathComponent("settings-nodes.png"))
        write()
        return true
    }

    /// The node menu's `Open in New Window`, its `Use AgentSwitch On` for a node in another window, the strip's `×`.
    private static func own(_ node: NodeStatus, windows: MainWindows, into dir: URL, say: (String) -> Void) async {
        let main = windows.main
        UserDefaults.standard.set(false, forKey: NodeStrip.hiddenKey)
        windows.open(node, beside: main)
        try? await Task.sleep(for: .seconds(5))
        guard let other = windows.on(node.id), other !== main, let window = other.window else { return say("FAIL own window: none opened") }
        say("ok   own window: \(windows.all.count) windows; main on \(main.state.nodeId ?? "this Mac"), the other on \(other.state.nodeId ?? "this Mac"); titles “\(main.window?.title ?? "-")” and “\(window.title)”; the other \(Int(window.frame.minX - (main.window?.frame.minX ?? 0))) pt right of the main one")
        shot(window.contentView, dir.appendingPathComponent("window-node.png"))
        // The main window's menu asks for that node, as its item does: the other window comes forward, this one stays.
        main.probeUseNode(node)
        try? await Task.sleep(for: .seconds(1))
        say("\(main.state.nodeId == nil && windows.all.count == 2 ? "ok  " : "FAIL") the node asked for again from the main window: main on \(main.state.nodeId ?? "this Mac"), \(windows.all.count) windows")
        windows.open(node, beside: main)
        try? await Task.sleep(for: .seconds(1))
        say("\(windows.all.count == 2 ? "ok  " : "FAIL") Open in New Window again: \(windows.all.count) windows")
        // The strip's `×`, clicked as the pointer would: at the strip's right end, under the bar.
        if let content = window.contentView {
            let top = other.state.barHeight + 1 + NodeStrip.height / 2
            let at = NSPoint(x: content.bounds.width - 19, y: content.bounds.height - top)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                 context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { continue }
                NSApp.postEvent(e, atStart: false)
            }
        }
        try? await Task.sleep(for: .seconds(1))
        say("\(UserDefaults.standard.bool(forKey: NodeStrip.hiddenKey) ? "ok  " : "FAIL") the strip's × clicked: hidden=\(UserDefaults.standard.bool(forKey: NodeStrip.hiddenKey))")
        shot(window.contentView, dir.appendingPathComponent("window-node-strip-hidden.png"))
        UserDefaults.standard.set(false, forKey: NodeStrip.hiddenKey)
        window.performClose(nil)
        try? await Task.sleep(for: .seconds(1))
        say("\(windows.all.count == 1 ? "ok  " : "FAIL") the node's window closed: \(windows.all.count) window(s)")
    }

    private static func shot(_ view: NSView?, _ file: URL) {
        guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: file)
    }
}
#endif
