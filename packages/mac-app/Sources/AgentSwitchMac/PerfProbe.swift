#if DEBUG
import AgentSwitchMacCore
import AppKit

/// `-perfProbe <dir>` (debug builds; docs/app-v0.md §4 省电, 2026-10-03): what the main window costs on screen and off
/// it, for `ps` / `sample` from outside. The window plays `-perfPhases` (`<phase>:<seconds>,…`, default
/// `terminals:15,dispatch:15,back:15,mini:15,hide:15`), then the app quits:
/// - `dispatch` / `terminals` / `browser`: that page, the window in front of every other window — nearly transparent
///   (`-perfAlpha`, default 0.05) and letting clicks through, so it is on screen without being in anyone's way;
/// - `back`: behind the other windows (covered by them, as a window in the background is);
/// - `mini`: minimised; `hide`: the app hidden. Put these last: the probe does not bring the window back.
/// Each phase's start goes to `<dir>/phases.txt` as `<name> <seconds since 1970>`, its end with whether the window
/// and the terminal screen were seen; `-perfShots YES` also writes the window as the window server has it then.
/// - With `-probeTerminal <id>`, `-localPort` and AGENTSWITCH_HOME of a running service: the real window on that
///   terminal, its size taken as a click on the screen would.
/// - Without: the design preview's window from made-up work (MainWindowPreview), Dispatch's tasks busy and waiting.
@MainActor
enum PerfProbe {
    static var directory: URL? { UserDefaults.standard.string(forKey: "perfProbe").map { URL(fileURLWithPath: $0) } }

    static func run(_ main: MainWindowController, model: AppModel, into dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let log = dir.appendingPathComponent("phases.txt")
        var lines: [String] = []
        func say(_ line: String) {
            lines.append(line)
            try? lines.joined(separator: "\n").write(to: log, atomically: true, encoding: .utf8)
        }
        let phases = (UserDefaults.standard.string(forKey: "perfPhases") ?? "terminals:15,dispatch:15,back:15,mini:15,hide:15")
            .split(separator: ",").compactMap { part -> (String, Double)? in
                let bits = part.split(separator: ":")
                guard bits.count == 2, let seconds = Double(bits[1]) else { return nil }
                return (String(bits[0]), seconds)
            }
        let alpha = UserDefaults.standard.object(forKey: "perfAlpha") as? Double ?? 0.05
        Task {
            var window: NSWindow?
            var screen: TerminalScreenController?
            var show: (MainPage) -> Void = { _ in }
            if let terminal = UserDefaults.standard.string(forKey: "probeTerminal") {
                model.probeServiceUp()
                MainWindowController.probing = true   // opened without making the app active
                main.show(terminal: terminal)
                MainWindowController.probing = false
                for _ in 0..<80 {
                    try? await Task.sleep(for: .milliseconds(250))
                    if let s = main.probeScreen, s.probeShown == terminal, s.probeSeq > 0 { screen = s; break }
                }
                window = main.window
                screen?.claim()
                show = { page in main.switchPage(to: page) }
            } else {
                model.loadDemo()
                let (demo, container, state) = MainWindowPreview.liveWindow(model: model, page: .dispatch)
                window = demo
                show = { page in
                    state.show(page)
                    MainWindowController.dress(demo, for: page)
                    container.show(page)
                }
            }
            guard let window else { say("no window"); exit(1) }
            window.setFrame(NSRect(x: 80, y: 80, width: 1280, height: 820), display: true)
            window.ignoresMouseEvents = true
            window.alphaValue = alpha
            try? await Task.sleep(for: .seconds(1))
            for (name, seconds) in phases {
                say("\(name) \(String(format: "%.3f", Date().timeIntervalSince1970))")
                switch name {
                case "back":
                    window.level = .normal
                    window.orderBack(nil)
                case "mini":
                    window.miniaturize(nil)
                case "hide":
                    NSApp.hide(nil)
                default:
                    window.level = .floating
                    window.orderFrontRegardless()
                    if let page = MainPage(rawValue: name) { show(page) }
                }
                try? await Task.sleep(for: .seconds(seconds))
                say("  seen \(window.occlusionState.contains(.visible)) visible \(window.isVisible) screen seen \(screen.map { "\($0.view.seen)" } ?? "-")")
                // `-perfShots YES`: the window as the window server has it at the end of each phase (with `-perfAlpha 1`).
                if UserDefaults.standard.bool(forKey: "perfShots"),
                   let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming]) {
                    try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?
                        .write(to: dir.appendingPathComponent("\(lines.count)-\(name).png"))
                }
            }
            say("end \(String(format: "%.3f", Date().timeIntervalSince1970))")
            exit(0)
        }
    }
}
#endif
