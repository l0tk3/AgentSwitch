#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir>` (debug builds, docs/ui-v0.md §5): loads DemoData, draws the menu panel, every settings page
/// (the Dispatch group's from DispatchSettingsDemo, with a few states and its sheets; `-designPreviewOnly dispatch` draws
/// only those; `-designPreviewOnly browser` only the main window's Browser page), a few states of the control-v0 pages (skip mode, a folder problem, a fresh Mac), each first-run wizard step and the
/// gate service's states and sheets (gate-service-v0) into PNG files in light and dark, the menu bar's Live Activity
/// (LivePreview) and the main window's bar over each page and through the refresh between pages (MainWindowPreview:
/// `main-*.png`, `main-refresh-*.png`), then exits. It runs before the single-instance lock and never calls `launch()`:
/// no gate, no daemon, no port, no poll. Nothing is put on screen: each view is hosted in a window that is never
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
                if UserDefaults.standard.string(forKey: "designPreviewOnly") == "browser" {
                    try await MainWindowPreview.renderBrowser(model: model, into: directory)
                    FileHandle.standardError.write(Data("design preview (Browser) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                if onlyDispatchGroup {
                    for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                        try await renderDispatchGroup(model: model, appearance: NSAppearance(named: appearance), suffix: suffix, into: directory)
                    }
                    FileHandle.standardError.write(Data("design preview (Dispatch group) written to \(directory.path)\n".utf8))
                    exit(0)
                }
                for (suffix, appearance) in [("", NSAppearance.Name.aqua), ("-dark", .darkAqua)] {
                    let look = NSAppearance(named: appearance)
                    model.loadDemo()
                    await model.control.loadWorkDir(model.client)
                    await model.control.loadPolicy(model.client)
                    try await renderMenu(model: model, appearance: look, to: directory.appendingPathComponent("menu\(suffix).png"))
                    model.pairingSession.reset()
                    try await renderSettings(.pairing, model: model, appearance: look, pressGenerate: false,
                                             to: directory.appendingPathComponent("settings-pairing-idle\(suffix).png"))
                    for tab in SettingsTab.allCases {
                        let file = directory.appendingPathComponent("settings-\(tab.rawValue)\(suffix).png")
                        try await renderSettings(tab, model: model, appearance: look, to: file)
                    }
                    model.errorMessage = "无法打开网页控制台：无法连接服务：127.0.0.1:4711 Could not connect to the server."
                    try await renderSettings(.devices, model: model, appearance: look,
                                             to: directory.appendingPathComponent("settings-error\(suffix).png"))
                    model.errorMessage = nil
                    try await renderDispatchVariants(model: model, appearance: look, suffix: suffix, into: directory)
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

    /// `-designPreviewOnly dispatch`: only the settings window's Dispatch group (its pages, states and sheets).
    private static var onlyDispatchGroup: Bool { UserDefaults.standard.string(forKey: "designPreviewOnly") == "dispatch" }

    /// The Dispatch group (docs/dispatch-v0.md §3) from DispatchSettingsDemo: each page, then the states the pages
    /// start in otherwise (`settings-*.png`, as the loop over every page draws them too) and the sheets.
    private static func renderDispatchGroup(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        for tab in SettingsTab.dispatch {
            try await renderSettings(tab, model: model, appearance: appearance,
                                     to: directory.appendingPathComponent("settings-\(tab.rawValue)\(suffix).png"))
            if tall {
                try await renderSettings(tab, model: model, appearance: appearance, height: 1500,
                                         to: directory.appendingPathComponent("tall-\(tab.rawValue)\(suffix).png"))
            }
        }
        try await renderDispatchVariants(model: model, appearance: appearance, suffix: suffix, into: directory)
    }

    /// Context after a save (what was sealed, a line removed), Log with two decisions open, History searching, and the
    /// Extensions sheets.
    private static func renderDispatchVariants(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name)\(suffix).png") }
        let demo = DispatchSettingsDemo.environment
        try await renderSettings(.context, model: model, appearance: appearance, to: file("settings-context-saved")) { navigation in
            let service = DispatchSettingsDemo()
            await navigation.context.load(service)
            navigation.context.contextText += "\n- 测试环境 token ghp_x8Q2"
            await navigation.context.save(service)
        }
        var log = demo
        log.preset.expandedLogRows = [3, 2]
        try await renderSettings(.log, model: model, appearance: appearance, dispatch: log, to: file("settings-log-expanded"))
        var searching = demo
        searching.preset.historyQuery = "AgentSwitch"
        try await renderSettings(.history, model: model, appearance: appearance, dispatch: searching, to: file("settings-history-search"))
        let github = try await DispatchSettingsDemo().mcpServers()[0]
        let sheets: [(String, AnyView)] = [
            ("sheet-mcp-new", AnyView(MCPServerSheet(server: nil, existing: ["github"]) {})),
            ("sheet-mcp-edit", AnyView(MCPServerSheet(server: github, existing: ["github"]) {})),
            ("sheet-skill-edit", AnyView(SkillSheet(name: "release-notes", existing: ["release-notes"]) {})),
            ("sheet-skill-import", AnyView(SkillImportSheet {})),
        ]
        for (name, sheet) in sheets {
            try await renderSheet(sheet.environment(\.dispatchSettings, demo), model: model, appearance: appearance, to: file(name))
        }
    }

    /// The control-v0 states: 跳过权限 on, a work dir the daemon cannot use, and a fresh Mac (menu, 环境, the wizard).
    private static func renderVariants(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name)\(suffix).png") }
        guard let backend = model.demoBackend else { return }
        backend.set(mode: .skip)
        try await renderSettings(.permissions, model: model, appearance: appearance, to: file("settings-permissions-skip"))
        backend.set(mode: .scoped)
        await model.control.loadPolicy(model.client)

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
        try await renderGateVariants(model: model, appearance: appearance, suffix: suffix, into: directory)
        model.loadDemo()
    }

    /// The credential gate as a system service (docs/gate-service-v0.md): the menu and 环境 in each state (环境 drawn tall
    /// enough to show its 凭据网关服务 section), 密钥 before the service, and every sheet.
    private static func renderGateVariants(model: AppModel, appearance: NSAppearance?, suffix: String, into directory: URL) async throws {
        func file(_ name: String) -> URL { directory.appendingPathComponent("\(name)\(suffix).png") }
        let states: [(String, DemoGate)] = [("not-installed", .notInstalled), ("installing", .installing), ("installed", .justInstalled),
                                            ("not-responding", .notResponding), ("update", .updateAvailable)]
        for (name, gate) in states {
            model.loadDemo(gate: gate)
            try await renderMenu(model: model, appearance: appearance, to: file("menu-gate-\(name)"))
            try await renderSettings(.environment, model: model, appearance: appearance, height: 1180,
                                     to: file("settings-environment-gate-\(name)"))
        }
        model.loadDemo(gate: .notInstalled)
        try await renderSettings(.keys, model: model, appearance: appearance, to: file("settings-keys-user-process"))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .install)), model: model,
                              appearance: appearance, to: file("sheet-gate-install"))
        model.gateServiceOperation = .install
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .install)), model: model,
                              appearance: appearance, to: file("sheet-gate-installing"))
        model.gateServiceOperation = nil
        model.gateServiceResult = GateServiceResult(operation: .install, outcome: .succeeded(output: DemoData.installOutput))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .install)), model: model,
                              appearance: appearance, to: file("sheet-gate-installed"))
        model.gateServiceResult = GateServiceResult(operation: .install, outcome: .failed(
            reason: "无法移动 ~/.secret-gate/keys/work：目标位置已存在同名密钥", output: DemoData.installFailedOutput))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .install)), model: model,
                              appearance: appearance, to: file("sheet-gate-install-failed"))
        model.gateServiceResult = GateServiceResult(operation: .install, outcome: .cancelled)
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .install)), model: model,
                              appearance: appearance, to: file("sheet-gate-install-cancelled"))
        model.loadDemo(gate: .updateAvailable)
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .update)), model: model,
                              appearance: appearance, to: file("sheet-gate-update"))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .changePort(8181))), model: model,
                              appearance: appearance, to: file("sheet-gate-port"))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .uninstall(deleteKeys: false))), model: model,
                              appearance: appearance, to: file("sheet-gate-uninstall"))
        try await renderSheet(GateServiceSheet(request: GateServiceRequest(operation: .uninstall(deleteKeys: false)), deleteKeys: true),
                              model: model, appearance: appearance, to: file("sheet-gate-uninstall-delete-keys"))
        try await renderSheet(GateLogSheet(), model: model, appearance: appearance, to: file("sheet-gate-log"))
    }

    /// A sheet's content as it would sit on its window, at its own size (the Browser page's Fill Ciphertext too).
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

    /// One page in the settings window; the Dispatch group's pages read DispatchSettingsDemo (`dispatch`), after
    /// `prepare` has set the window's state.
    private static func renderSettings(_ tab: SettingsTab, model: AppModel, appearance: NSAppearance?, pressGenerate: Bool = true,
                                       height: CGFloat? = nil, dispatch: DispatchSettingsEnvironment = DispatchSettingsDemo.environment,
                                       to file: URL, prepare: (SettingsNavigation) async -> Void = { _ in }) async throws {
        let navigation = SettingsNavigation(wizardStore: SetupWizardStore(defaults: nil))
        navigation.tab = tab
        await prepare(navigation)
        let window = SettingsWindowController.makeWindow(model: model, navigation: navigation, windowClass: PreviewWindow.self,
                                                         appearance: appearance, dispatch: dispatch)
        if let height { window.setContentSize(NSSize(width: SettingsWindowController.contentSize.width, height: height)) }
        try await settle()
        if tab == .pairing && pressGenerate && model.pairingSession.pairing == nil {
            await model.pairingSession.start(model: model)
            try await settle()
        }
        // The frame view: the title bar and the traffic lights along with the content.
        try write(window.contentView?.superview ?? window.contentView!, to: file)
        window.close()
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
