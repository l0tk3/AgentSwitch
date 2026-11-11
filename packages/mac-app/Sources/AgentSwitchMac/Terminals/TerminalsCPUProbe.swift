#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly terminals-cpu` (debug builds; no service): what the Terminals page costs on
/// screen while nothing is asked of it (2026-11-10, user: 优化它的性能 — the installed app stood at 20–45 % of a core
/// with one Claude Code terminal at work). The page from made-up work, a few seconds a scene; a line a scene in
/// `cpu.txt`: the app's own time and the window server's in percent of one core, and how many times a second the
/// page's SwiftUI was laid out again (a count, where the percentages move with whatever else the Mac is doing):
/// - `still`: every terminal at rest — nothing on the page moves;
/// - `one waiting`: one terminal waiting for you (its square and its folder's count blink);
/// - `one at work`: one terminal at work with two sub-agents (three spinners, its row's flicker), one waiting;
/// - `one at work, list away`: the same with the list put away — what is left is the panes';
/// - `three at work`: three terminals at work;
/// - with `-probeFeed <file>`, `one at work, its screen fed` (and `…, list away`): the terminal's screen also takes a
///   stream as a service sent it — `[ms, event, data]` a line, the stream's own `snapshot` and `output` events with the
///   moment each came — at the pace it came, again and again. An agent at work writes to its screen about eleven times
///   a second; this is the scene the installed app's figure is of.
/// `-appearance classic` for the other look, `-probeSeconds <s>` for longer scenes, `-probeCPUScene <name>` for one
/// scene alone (to sample or trace it from outside), `-probeShots YES` for the page as each scene left it. The window
/// is in front of every other window, nearly transparent (`-perfAlpha`, default 0.05) and letting clicks through, as
/// `PerfProbe`'s is: seen, so that what moves moves, and in nobody's way.
@MainActor
enum TerminalsCPUProbe {
    static func run(into directory: URL) async throws {
        let log = RecordTurnProbe.Log()
        try await TerminalsPagePreview.shot(to: directory.appendingPathComponent("terminals-cpu.png"), onScreen: true, stage: { _ in },
                                            then: { model, host in try await play(model: model, host: host, directory: directory, log: log) })
        try log.lines.joined(separator: "\n").appending("\n").write(to: directory.appendingPathComponent("cpu.txt"), atomically: true, encoding: .utf8)
    }

    private static func play(model: TerminalsModel, host: NSView, directory: URL, log: RecordTurnProbe.Log) async throws {
        guard let window = host.window else { return }
        window.level = .floating
        window.alphaValue = UserDefaults.standard.object(forKey: "perfAlpha") as? Double ?? 0.05
        window.ignoresMouseEvents = true
        window.orderFrontRegardless()
        let look = InterfaceLook.current.rawValue
        let only = UserDefaults.standard.string(forKey: "probeCPUScene")
        let demo = model.terminals
        /// The terminals as the list would say them: `working` of them at work (the first with its sub-agents), the
        /// rest at rest, none waiting unless `waiting`.
        func stage(working: Int, waiting: Bool) {
            var left = working
            let terminals = demo.map { terminal -> TerminalInfo in
                guard terminal.running else { return terminal }
                if terminal.status == "waiting", waiting { return terminal }
                let at = left > 0
                if at { left -= 1 }
                return TerminalInfo(id: terminal.id, harness: terminal.harness, cwd: terminal.cwd, workdir: terminal.workdir, model: terminal.model, mode: terminal.mode,
                                    name: terminal.name, status: at ? "working" : "idle", cols: terminal.cols, rows: terminal.rows, createdAt: terminal.createdAt,
                                    agentSessionId: terminal.agentSessionId, subagents: at ? terminal.subagents : [])
            }
            model.take(TerminalList(terminals: terminals, agents: model.agents, models: model.models, efforts: model.efforts))
        }
        func scene(_ name: String, _ set: () -> Void) async throws {
            guard only == nil || only == name else { return }
            set()
            try await DesignPreview.settle()
            let seen = window.occlusionState.contains(.visible)
            log.say("\(look), \(name): \(try await RecordCPUProbe.measure(host) {})\(seen ? "" : " (the window is not seen: nothing moves)")")
            // `-probeShots YES`: the page as each scene left it.
            if UserDefaults.standard.bool(forKey: "probeShots") {
                try DesignPreview.write(host, to: directory.appendingPathComponent("cpu-\(name.replacingOccurrences(of: ", ", with: "-").replacingOccurrences(of: " ", with: "-")).png"))
            }
        }
        try await scene("still") { stage(working: 0, waiting: false) }
        try await scene("one waiting") { stage(working: 0, waiting: true) }
        try await scene("one at work") { stage(working: 1, waiting: true) }
        try await scene("one at work, list away") { stage(working: 1, waiting: true); model.sideClosed = true }
        model.sideClosed = false
        try await scene("three at work") { stage(working: 3, waiting: true) }

        // An agent's own writing, as a service sent it.
        guard let path = UserDefaults.standard.string(forKey: "probeFeed") else { return }
        guard let stream = Recorded(file: path), let screen = model.panes.values.first(where: { $0.session?.id == "t1" })?.screen.view else {
            return log.say("\(look): nothing to play in \(path)")
        }
        // The screen it was drawn on: the buffer takes its size, the view stays (as a screen following another's does).
        if let first = stream.snapshot {
            screen.getTerminal().resize(cols: first.cols, rows: first.rows)
            screen.feed(text: "\u{1b}[2J\u{1b}[H" + first.data)
        }
        let playing = stream.play(into: screen)
        try await scene("one at work, its screen fed") { stage(working: 1, waiting: true) }
        try await scene("one at work, its screen fed, list away") { stage(working: 1, waiting: true); model.sideClosed = true }
        model.sideClosed = false
        playing.cancel()
    }

    /// A terminal's stream as it was recorded: the screen it began with, then what was written to it and when.
    private struct Recorded {
        var snapshot: (cols: Int, rows: Int, data: String)?
        var outputs: [(at: Int, text: String)] = []

        init?(file: String) {
            struct Event: Decodable { let cols: Int?; let rows: Int?; let data: String? }
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return nil }
            for line in text.split(separator: "\n") {
                guard let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [Any], row.count == 3,
                      let at = row[0] as? Int, let name = row[1] as? String, let body = row[2] as? String,
                      let event = try? JSONDecoder().decode(Event.self, from: Data(body.utf8)), let data = event.data else { continue }
                if name == "snapshot", let cols = event.cols, let rows = event.rows { snapshot = (cols, rows, data) }
                if name == "output" { outputs.append((at, data)) }
            }
            guard outputs.count > 1 else { return nil }
        }

        /// Into the screen at the pace it came, from the start again once it is through, until cancelled.
        @MainActor
        func play(into screen: NativeTerminalView) -> Task<Void, Never> {
            let outputs = outputs
            return Task { @MainActor in
                let first = outputs[0].at
                while !Task.isCancelled {
                    let start = ContinuousClock.now
                    for output in outputs {
                        try? await Task.sleep(until: start + .milliseconds(output.at - first), clock: .continuous)
                        if Task.isCancelled { return }
                        screen.feed(text: output.text)
                    }
                }
            }
        }
    }
}
#endif
