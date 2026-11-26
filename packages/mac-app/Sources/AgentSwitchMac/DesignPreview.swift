#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir>` (debug builds, docs/ui-v0.md §5): loads DemoData, draws the menu panel, every settings page
/// (`-designPreviewOnly browser` only the main window's Browser page; `-designPreviewOnly window` only the main
/// window's pictures and the Live Activity's; `-designPreviewOnly rail` only the main window with its rail put away; `-designPreviewOnly item` only a terminal's own window; `-designPreviewOnly terminals` only the native Terminals page), a few states of the control-v0 pages (a folder problem, a fresh Mac) and each first-run wizard step
/// into PNG files in light and dark, the menu bar's Live Activity
/// (LivePreview) and the main window's bar over each page and through the refresh between pages (MainWindowPreview:
/// `main-*.png`, `main-refresh-*.png`), then exits. It runs before the single-instance lock and never calls `launch()`:
/// no daemon, no port, no poll. Nothing is put on screen: each view is hosted in a window that is never
/// ordered in and drawn with `cacheDisplay`.
@MainActor
enum DesignPreview {
    static let argument = "designPreview"

    static var directory: URL? {
        UserDefaults.standard.string(forKey: argument).map { URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath) }
    }

    static func run(model: AppModel, into directory: URL) {
        NSApp.setActivationPolicy(.prohibited)
        model.loadDemo()
        Task {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "passwords" {
                    try await MainWindowPreview.renderPasswords(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (Passwords) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "lights" {
                    // One settings window gone through every page, as a person does: where the window's lights and
                    // its content's top are on each (user #401: 红绿灯的位置不一致). The same on all, or it fails.
                    let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
                    let window = SettingsWindowController.makeWindow(model: model, navigation: navigation, windowClass: PreviewWindow.self, appearance: NSAppearance(named: .darkAqua))
                    var seen = Set<String>()
                    for tab in SettingsTab.allCases + SettingsTab.allCases.reversed() {
                        navigation.tab = tab
                        try await settle()
                        let close = window.standardWindowButton(.closeButton)
                        let at = close.map { $0.convert($0.bounds, to: nil) } ?? .zero
                        let line = "lights \(Int(at.minX)),\(Int(window.frame.height - at.maxY)) bar \(Int(window.frame.height - window.contentLayoutRect.maxY)) items \(window.toolbar?.items.count ?? -1)"
                        seen.insert(line.components(separatedBy: " items").first!)
                        FileHandle.standardError.write(Data("\(tab.rawValue): \(line)\n".utf8))
                    }
                    exit(seen.count == 1 ? 0 : 1)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "redaction" {
                    // docs/model-gate-v0.md: Settings › Redaction over sample words and logs.
                    RedactionDemo.current = RedactionDemo.make()
                    for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                        try await renderSettings(.redaction, model: model, appearance: NSAppearance(named: appearance), height: 1500,
                                                 to: directory.appendingPathComponent("settings-redaction\(suffix).png"))
                    }
                    // Switched off: the switch alone (user #343).
                    if let d = RedactionDemo.current {
                        RedactionDemo.current = .init(state: d.state.turnedOff, logs: d.logs, rooms: d.rooms, roomWords: d.roomWords, said: nil)
                        try await renderSettings(.redaction, model: model, appearance: NSAppearance(named: .aqua), to: directory.appendingPathComponent("settings-redaction-off.png"))
                        // A room's words, in the room's own menu (Words…).
                        for (suffix, appearance) in [("", NSAppearance.Name.aqua)] {
                            let rooms = RoomsModel()
                            rooms.show(demoWords: d.roomWords + d.state.words.filter { $0.replace != nil }, said: d.said)
                            let host = NSHostingView(rootView: RoomWordsSheet(model: rooms).padding(24).background(Color(nsColor: .windowBackgroundColor)))
                            host.appearance = NSAppearance(named: appearance)
                            host.frame = NSRect(x: 0, y: 0, width: 648, height: 520)
                            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                            window.contentView = host
                            window.appearance = host.appearance
                            try await settle()
                            try write(host, to: directory.appendingPathComponent("room-words\(suffix).png"))
                            window.close()
                        }
                    }
                    FileHandle.standardError.write(Data("design preview (Redaction) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "browser" {
                    try await MainWindowPreview.renderBrowser(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (Browser) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "browsers" {
                    try await MainWindowPreview.renderBrowsers(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (the browsers) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "files" {
                    // docs/files-v0.md: the Files column over a made-up disk, in the main window on Terminals.
                    model.loadDemoNodes()
                    try await FilesDesignPreview.render(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (files) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "nodes" {
                    // docs/mesh-v0.md: Settings › Nodes with two nodes and a phone, and the link sheet with a link read back.
                    model.loadDemoNodes()
                    let link = try PairingLink.make(PairingPayload(name: "Mac mini", port: 4713, fp: DemoData.nodeList.nodes[0].fingerprint, code: "K7QD-2M9F",
                                                                   lan: ["192.168.1.30"], tailnet: ["mac-mini.tail2c41.ts.net"], bonjour: "AgentSwitch on Mac mini", gate: nil))
                    for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                        let look = NSAppearance(named: appearance)
                        try await renderSettings(.nodes, model: model, appearance: look, to: directory.appendingPathComponent("settings-nodes\(suffix).png"))
                        try await renderSheet(PairWithLinkSheet(link: link), model: model, appearance: look, to: directory.appendingPathComponent("nodes-link\(suffix).png"))
                    }
                    try await MainWindowPreview.renderNodes(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (nodes) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "addons" {
                    // Settings › Add-Ons over DemoData's profiles: every profile at once, each add-on with how many have it.
                    for (name, appearance) in [("settings-addons-dark", NSAppearance(named: .darkAqua)), ("settings-addons", NSAppearance(named: .aqua))] {
                        try await renderSettings(.addons, model: model, appearance: appearance, height: 760, to: directory.appendingPathComponent("\(name).png"))
                    }
                    FileHandle.standardError.write(Data("design preview (Add-Ons) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "profiles" {
                    // A profile's own proxy (docs/profiles-v0.md §4): the sheet once it was applied and checked, and
                    // one whose proxy let nothing out.
                    let dark = NSAppearance(named: .darkAqua)
                    let checked = AgentProfile(id: "abc123def0", name: "cwork1", proxy: BrowserProxy(server: "http://proxy.example:8080", username: "me", sealed: true), exit: ProfileExit(ip: "203.0.113.9", place: "Tokyo"))
                    try await renderSheet(ProfileProxySheet(agent: .claude, profile: checked) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-proxy.png"))
                    let down = AgentProfile(id: "abc123def0", name: "cwork1", proxy: BrowserProxy(server: "socks5://10.0.0.2:1080"))
                    try await renderSheet(ProfileProxySheet(agent: .claude, profile: down, problem: "经这个代理连不出去（the proxy answered 502）。") { _ in }, model: model, appearance: dark,
                                          to: directory.appendingPathComponent("profile-proxy-down.png"))
                    // What a profile takes from `Default` (§3.8): the list, by kind and by item.
                    try await renderSheet(ProfileCopiesDemo(), model: model, appearance: dark, to: directory.appendingPathComponent("profile-copies.png"))
                    try await renderSheet(ProfileCopiesDemo(), model: model, appearance: NSAppearance(named: .aqua), to: directory.appendingPathComponent("profile-copies-light.png"))
                    // The profiles' rows (§3.2): each with its colour before its name, `Default` with none.
                    let list = AgentProfiles(current: "abc123def0", profiles: [
                        AgentProfile(id: "default", name: "Default", account: "me@example.com"),
                        AgentProfile(id: "abc123def0", name: "cwork1", account: "work@example.com", proxy: checked.proxy, exit: checked.exit, color: "violet"),
                        AgentProfile(id: "abc123def1", name: "side", color: "sand"),
                        AgentProfile(id: "abc123def2", name: "lab", account: "lab@example.com", color: "mint"),
                        // A name and an account as long as they come: shown whole (2026-11-22).
                        AgentProfile(id: "abc123def4", name: "cvp_ a.rather.long.account.name@example.com", account: "a.rather.long.account.name@example.com", proxy: checked.proxy, exit: ProfileExit(ip: "198.51.100.23", place: "New York City"), color: "olive"),
                        AgentProfile(id: "abc123def3", name: "relay", kind: "api", color: "orchid", api: ProfileApiInfo(baseUrl: "https://relay.example/api", model: "claude-made-up")),
                    ], creatable: true, kinds: ["subscription", "api"])
                    let healthy = try JSONDecoder().decode(ProfileHealth.self, from: Data(#"{"status":"healthy","checkedAt":1794630000000,"message":"已连接，订阅用量读取成功。","windows":[{"label":"5h","usedPercent":23,"resetsAt":1794640000},{"label":"7d","usedPercent":61,"resetsAt":1794700000}]}"#.utf8))
                    for (name, appearance) in [("profiles-rows", dark), ("profiles-rows-light", NSAppearance(named: .aqua))] {
                        try await renderSheet(Form { ProfilesSection(agent: .claude, profiles: list, error: nil, add: {}, remove: { _ in }, proxy: { _ in }, sessionKey: { _ in }, apiKey: { _ in }, health: ["claude-code.abc123def0": healthy], checkHealth: { _ in }, color: { _, _ in }) }
                            .formStyle(.grouped).frame(width: 900), model: model, appearance: appearance, to: directory.appendingPathComponent("\(name).png"))
                    }
                    // A new profile (§3.6): one that pays by a key, where both ways are offered and where the key is the only one;
                    // and the sheet that changes a kept one.
                    try await renderSheet(ProfileNewSheet(agent: .claude, kinds: ["api", "subscription"]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-new-key.png"))
                    try await renderSheet(ProfileNewSheet(agent: .claude, kinds: ["subscription", "api"]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-new-account.png"))
                    try await renderSheet(ProfileNewSheet(agent: .codex, kinds: ["subscription", "api"]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-new-codex.png"))
                    try await renderSheet(ProfileNewSheet(agent: .codex, kinds: ["api", "subscription"]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-new-codex-key.png"))
                    // Codex's (§6.2): the Mac's own signed in to ChatGPT, an account profile signed in, one not yet, one by a key.
                    let codexList = AgentProfiles(current: "default", profiles: [
                        AgentProfile(id: "default", name: "Default", account: "me@example.com"),
                        AgentProfile(id: "c0dex00001", name: "team", account: "team@example.com", color: "violet"),
                        AgentProfile(id: "c0dex00002", name: "spare", color: "sand"),
                        AgentProfile(id: "c0dex00003", name: "relay", kind: "api", color: "mint", api: ProfileApiInfo(baseUrl: "https://relay.example/v1")),
                    ], creatable: true, kinds: ["subscription", "api"])
                    try await renderSheet(Form { ProfilesSection(agent: .codex, profiles: codexList, error: nil, add: {}, remove: { _ in }, proxy: { _ in }, apiKey: { _ in }, color: { _, _ in }) }
                        .formStyle(.grouped).frame(width: 640), model: model, appearance: dark, to: directory.appendingPathComponent("profiles-rows-codex.png"))
                    try await renderSheet(ProfileKeySheet(agent: .claude, profile: list.profiles[4]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-key.png"))
                    // Grok's (§6.3): the Mac's own signed in to xAI, an account profile signed in and one not yet — and
                    // the sheet that makes one (one way only: Grok pays by no key here).
                    let grokList = AgentProfiles(current: "default", profiles: [
                        AgentProfile(id: "default", name: "Default", account: "me@example.com"),
                        AgentProfile(id: "gr0k000001", name: "work", account: "work@example.com", color: "violet"),
                        AgentProfile(id: "gr0k000002", name: "spare", color: "sand"),
                    ], creatable: true, kinds: ["subscription"])
                    for (name, appearance) in [("profiles-rows-grok", dark), ("profiles-rows-grok-light", NSAppearance(named: .aqua))] {
                        try await renderSheet(Form { ProfilesSection(agent: .grok, profiles: grokList, error: nil, add: {}, remove: { _ in }, proxy: { _ in }, color: { _, _ in }) }
                            .formStyle(.grouped).frame(width: 640), model: model, appearance: appearance, to: directory.appendingPathComponent("\(name).png"))
                    }
                    try await renderSheet(ProfileNewSheet(agent: .grok, kinds: ["subscription"]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-new-grok.png"))
                    try await renderSheet(ProfileRenameSheet(agent: .grok, profile: grokList.profiles[1]) { _ in }, model: model, appearance: dark, to: directory.appendingPathComponent("profile-rename-grok.png"))
                    FileHandle.standardError.write(Data("design preview (a profile's proxy) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "clash" {
                    try await MainWindowPreview.renderClash(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (Clash) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "rooms" {
                    try await MainWindowPreview.renderRooms(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (Chat Room) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "rail" {
                    try await MainWindowPreview.renderRail(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (the rail put away) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "room" {
                    try await RoomPreview.run(into: directory)
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "prose-select" {
                    try await ProseSelectProbe.run(into: directory)
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "record-turn" {
                    try await RecordTurnProbe.run(into: directory)
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "terminals" {
                    try await TerminalsPagePreview.render(into: directory)
                    FileHandle.standardError.write(Data("design preview (the Terminals page) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "item" {
                    try await TerminalWindowPreview.render(into: directory)
                    FileHandle.standardError.write(Data("design preview (a terminal's own window) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "window" {
                    try LivePreview.render(into: directory)
                    try await MainWindowPreview.render(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (main window, Live Activity) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "agents" {
                    for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                        try await renderAgents(model: model, appearance: NSAppearance(named: appearance), suffix: suffix, into: directory)
                    }
                    FileHandle.standardError.write(Data("design preview (Agents) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                    let look = NSAppearance(named: appearance)
                    model.loadDemo()
                    await model.control.loadWorkDir(model.client)
                    try await renderMenu(model: model, appearance: look, to: directory.appendingPathComponent("menu\(suffix).png"))
                    model.pairingSession.reset()
                    try await renderSettings(.pairing, model: model, appearance: look, pressGenerate: false,
                                             to: directory.appendingPathComponent("settings-pairing-idle\(suffix).png"))
                    for tab in SettingsTab.allCases {
                        let file = directory.appendingPathComponent("settings-\(tab.rawValue)\(suffix).png")
                        try await renderSettings(tab, model: model, appearance: look, to: file)
                    }
                    model.errorMessage = "无法打开网页控制台：无法连接服务：127.0.0.1:4711 Could not connect to the server."
                    try await renderSettings(.nodes, model: model, appearance: look,
                                             to: directory.appendingPathComponent("settings-error\(suffix).png"))
                    model.errorMessage = nil
                    try await renderVariants(model: model, appearance: look, suffix: suffix, into: directory)
                    if tall {
                        for tab in SettingsTab.allCases {
                            let file = directory.appendingPathComponent("tall-\(tab.rawValue)\(suffix).png")
                            try await renderSettings(tab, model: model, appearance: look, height: 1500, to: file)
                        }
                    }
                }
                try LivePreview.render(into: directory)
                model.loadDemo()
                try await MainWindowPreview.render(model: model, into: directory)
                FileHandle.standardError.write(Data("design preview written to \(directory.path)\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("design preview failed: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
    }

    /// `-designPreviewOnly agents`: 设置 › Agents as this Mac was when it was drawn, on a Mac with nothing installed, and
    /// with everything there is (docs/design/concepts/agents.html `?s=today|fresh|full`).
    private static func renderAgents(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name)\(suffix).png") }
        model.loadDemo()
        try await renderSettings(.agents, model: model, appearance: appearance, height: 900, to: file("settings-agents"))
        model.loadDemoAgents(fresh: true)
        try await renderSettings(.agents, model: model, appearance: appearance, height: 900, to: file("settings-agents-fresh"))
        // The two that are not installed come at the foot of the page: a taller picture shows them (agents-v0 §13).
        try await renderSettings(.agents, model: model, appearance: appearance, height: 1400, to: file("settings-agents-extras-fresh"))
        // Everything installed; OpenCode's folder is not on the shell's PATH, so the foot of the page says what to add.
        model.loadDemoAgents(full: true)
        let home = model.paths.userHome.path
        model.setDemoShellPath("/opt/homebrew/bin:\(home)/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        try await renderSettings(.agents, model: model, appearance: appearance, height: 1320, to: file("settings-agents-full"))
        try await renderSettings(.agents, model: model, appearance: appearance, height: 1700, to: file("settings-agents-extras"))
        model.setDemoShellPath(DemoData.path(home: home))
        // Jobs on their rows: a beta on its way, a pinned version being checked, a download that did not match.
        model.loadDemoAgents()
        model.agentJobs = [
            "claude-code": AgentJob(agent: .claude, row: "missing:beta", source: .beta, version: "2.1.291", phase: .downloading(received: 112_400_000, total: 233_211_568)),
            "codex": AgentJob(agent: .codex, row: "missing:stable", source: .stable, version: "0.160.1", phase: .installing),
            "opencode": AgentJob(agent: .opencode, row: "missing:beta", source: .beta, version: "0.0.0-beta-19507", phase: .verifying,
                                 error: "下载的文件与官方校验值不符，已丢弃。未做任何更改。"),
            "pi": AgentJob(agent: .pi, row: "stable", source: .stable, version: "1.0.4", phase: .updating),
        ]
        // Grok's own updater at work (agents-v0 §13).
        model.agentExtraJobs = ["grok": AgentExtraJob(id: "grok", phase: .updating)]
        try await renderSettings(.agents, model: model, appearance: appearance, height: 900, to: file("settings-agents-jobs"))
        try await renderSettings(.agents, model: model, appearance: appearance, height: 1700, to: file("settings-agents-extras-jobs"))
        model.agentJobs = [:]
        model.agentExtraJobs = [:]
        // A fresh Mac: the checklist and the wizard's first step offer `Install` on a missing executor's row; here
        // Codex's is on its way (agents-v0 §8).
        model.loadDemo(fresh: true)
        model.agentJobs = [
            "codex": AgentJob(agent: .codex, row: "missing:stable", source: .stable, version: "0.160.1", phase: .installing),
        ]
        try await renderSettings(.environment, model: model, appearance: appearance, to: file("settings-agents-checklist"))
        try await renderWizard(.executors, model: model, appearance: appearance, to: file("settings-agents-wizard"))
        model.agentJobs = [:]
        model.loadDemo()
    }

    /// The control-v0 states: a work dir the daemon cannot use, and a fresh Mac (menu, 环境, the wizard).
    private static func renderVariants(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name)\(suffix).png") }
        guard let backend = model.demoBackend else { return }
        let home = model.paths.userHome.path
        backend.set(workDir: "/Volumes/Archive/tasks", problem: "无法写入（权限不足）")
        await model.control.loadWorkDir(model.client)
        model.control.showDemoWorkDirProblem("无法使用主目录本身，请选择其中的子文件夹")
        try await renderSettings(.general, model: model, appearance: appearance, to: file("settings-general-workdir-problem"))
        model.control.showDemoWorkDirProblem(nil)
        backend.set(workDir: WorkDirSettings.fallbackDefault(home: home), problem: nil)
        await model.control.loadWorkDir(model.client)

        model.loadDemo(fresh: true)
        try await renderMenu(model: model, appearance: appearance, to: file("menu-fresh"))
        try await renderSettings(.environment, model: model, appearance: appearance, to: file("settings-environment-fresh"))
        for step in SetupStep.allCases {
            try await renderWizard(step, model: model, appearance: appearance, to: file("wizard-\(step.rawValue + 1)-\(step)"))
        }
        model.loadDemo()
    }

    /// A sheet's content as it would sit on its window, at its own size.
    static func renderSheet<Content: View>(_ view: Content, model: AppModel, appearance: NSAppearance?, to file: URL) async throws {
        let root = view
            .environment(model)
            .environment(\.interfaceLook, InterfaceLook.current)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: root)
        host.appearance = appearance
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let window = PreviewWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.contentView = host
        try await settle()
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        window.setContentSize(host.frame.size)
        try await settle()
        try write(host, to: file)
        window.close()
    }

    /// A wizard step as the sheet shows it, without the window behind.
    private static func renderWizard(_ step: SetupStep, model: AppModel, appearance: NSAppearance?, to file: URL) async throws {
        let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
        navigation.wizardStep = step
        let root = SetupWizardView()
            .environment(model)
            .environment(navigation)
            .environment(\.interfaceLook, InterfaceLook.current)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: root)
        host.appearance = appearance
        host.frame = NSRect(origin: .zero, size: SetupWizardView.size)
        let window = PreviewWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false   // ARC owns it; close() only stops the view's tasks
        window.appearance = appearance
        window.contentView = host
        try await settle()
        try write(host, to: file)
        window.close()
    }

    private static func renderMenu(model: AppModel, appearance: NSAppearance?, to file: URL) async throws {
        let root = MenuContentView()
            .environment(model)
            .environment(\.interfaceLook, InterfaceLook.current)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: root)
        host.appearance = appearance
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let window = PreviewWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = appearance
        window.contentView = host
        try await settle()
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        window.setContentSize(host.frame.size)
        try await settle()
        try write(host, to: file)
    }

    /// `-designPreviewTall YES`: every page again, 1500 pt high, to see a whole page at once.
    private static var tall: Bool { UserDefaults.standard.bool(forKey: "designPreviewTall") }

    /// One page in the settings window.
    private static func renderSettings(_ tab: SettingsTab, model: AppModel, appearance: NSAppearance?, pressGenerate: Bool = true,
                                       height: CGFloat? = nil, to file: URL) async throws {
        let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
        navigation.tab = tab
        let window = SettingsWindowController.makeWindow(model: model, navigation: navigation, windowClass: PreviewWindow.self,
                                                         appearance: appearance)
        if let height { window.setContentSize(NSSize(width: SettingsWindowController.contentSize.width, height: height)) }
        try await settle()
        try checkSidebar(window)
        if tab == .pairing && pressGenerate && model.pairingSession.pairing == nil {
            await model.pairingSession.start(model: model)
            try await settle()
        }
        // The frame view: the title bar and the traffic lights along with the content.
        try write(window.contentView?.superview ?? window.contentView!, to: file)
        window.close()
    }

    /// Every page's row in the sidebar is one the list will select: asked of the list itself, the way a click asks.
    /// A picture cannot show this — on 2026-10-06 the first group drew as ever and took no click.
    private static func checkSidebar(_ window: NSWindow) throws {
        func outlines(_ view: NSView) -> [NSOutlineView] { (view as? NSOutlineView).map { [$0] } ?? view.subviews.flatMap(outlines) }
        guard let content = window.contentView, let sidebar = outlines(content).first, let delegate = sidebar.delegate,
              delegate.responds(to: #selector(NSOutlineViewDelegate.outlineView(_:shouldSelectItem:))) else {
            throw PreviewError("the settings sidebar could not be asked which rows it selects")
        }
        let selectable = (0..<sidebar.numberOfRows).filter { row in
            sidebar.item(atRow: row).map { delegate.outlineView?(sidebar, shouldSelectItem: $0) ?? false } ?? false
        }.count
        guard selectable == SettingsTab.allCases.count else {
            throw PreviewError("the settings sidebar selects \(selectable) of its \(SettingsTab.allCases.count) rows")
        }
    }

    /// Lets SwiftUI lay out and run the views' `.task`s (they answer from DemoTransport at once).
    static func settle() async throws {
        for _ in 0..<4 {
            try await Task.sleep(for: .milliseconds(150))
            NSApp.windows.forEach { $0.contentView?.layoutSubtreeIfNeeded() }
        }
    }

    static func write(_ view: NSView, to file: URL) throws {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw PreviewError("no bitmap for \(file.lastPathComponent)") }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw PreviewError("no PNG for \(file.lastPathComponent)") }
        try png.write(to: file)
    }
}

/// Draws as the key window would (active controls, accent selection) without ever being ordered in.
final class PreviewWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
    override var canBecomeKey: Bool { true }
}

private struct PreviewError: LocalizedError {
    let errorDescription: String?
    init(_ text: String) { errorDescription = text }
}
#endif
