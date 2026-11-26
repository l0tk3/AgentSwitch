#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly room -roomData <data dir>` (debug builds; no service): a room's two
/// terminals (docs/talk-v0.md) on the Terminals page, drawn by the app from what a real trial left
/// (packages/daemon/scripts/room_trial.ts, 2026-10-15) — each terminal's screen as its stream's snapshot gave it, fed
/// to the native screen, and each session's record as the service reads it. `<data dir>/room.json`:
/// `{ "name": "…", "terminals": [{ "id", "harness", "name", "snapshot": "<file>", "record": "<file>" }, …two] }`.
/// Writes `<name>-split.png` (the first as its terminal, the second as its record), `<name>-records.png`,
/// `<name>-terminals.png`. The list holds the two terminals alone: none of the person's other sessions. A
/// `style.json` beside `room.json` (the service's `GET /terminals/style`) gives the screens the user's colours.
@MainActor
enum RoomPreview {
    private struct Room: Decodable {
        let name: String
        let terminals: [Member]
        struct Member: Decodable { let id: String; let harness: String; let name: String; let snapshot: String; let record: String }
    }
    private struct Snapshot: Decodable { let cols: Int; let rows: Int; let data: String }
    private struct Record: Decodable { let items: [RecordItem] }
    private enum RoomError: LocalizedError {
        case missing(String)
        var errorDescription: String? { if case .missing(let s) = self { return s }; return nil }
    }

    static func run(into directory: URL) async throws {
        guard let data = UserDefaults.standard.string(forKey: "roomData").map({ URL(fileURLWithPath: $0) }) else { throw RoomError.missing("give -roomData <dir>") }
        let room = try JSONDecoder().decode(Room.self, from: Data(contentsOf: data.appendingPathComponent("room.json")))
        guard room.terminals.count == 2 else { throw RoomError.missing("a room of two terminals") }
        for (shot, views) in [("split", [false, true]), ("records", [true, true]), ("terminals", [false, false])] {
            try await draw(room, from: data, simple: views, light: views[0], to: directory.appendingPathComponent("\(room.name)-\(shot).png"))
        }
    }

    private static func draw(_ room: Room, from data: URL, simple: [Bool], light: Bool, to file: URL) async throws {
        let size = NSSize(width: 1440, height: 900)
        let cwd = "\(NSHomeDirectory())/Desktop/Code/Projects/AgentSwitch"
        let model = TerminalsModel(client: { DaemonClient(port: 1) }, defaults: nil)
        let ids = ["t1", "t2"]
        let infos = room.terminals.enumerated().map { n, m in
            TerminalInfo(id: ids[n], harness: m.harness, cwd: cwd, mode: "manual", name: m.name, status: "idle", cols: 120, rows: 40, createdAt: Int64(10 + n))
        }
        model.stage(terminals: infos, sessions: [], gits: [cwd: FolderGit(branch: "main", changed: 8)], agents: ["claude-code", "codex"], models: [:], efforts: [:])
        model.area = CGSize(width: size.width - 291, height: size.height)
        let host = NSHostingView(rootView: TerminalsPageView(model: model))
        host.sizingOptions = []
        let window = PreviewWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
        window.backgroundColor = light ? .dispatchGround : .black
        window.isReleasedWhenClosed = false
        window.contentView = host
        try await DesignPreview.settle()
        model.select("t1")
        model.setLayout(.split(id: 3, dir: .row, ratio: 0.5, a: .pane(TerminalPane(id: 1, term: "t1")), b: .pane(TerminalPane(id: 2, term: "t2"))))
        model.syncPanes()
        try await DesignPreview.settle()
        for (n, member) in room.terminals.enumerated() {
            let paneID = n + 1
            model.setSimple(simple[n], pane: paneID)
            guard let pane = model.panes[paneID], let info = pane.session?.info else { continue }
            if simple[n] {
                let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: data.appendingPathComponent(member.record)))
                pane.record.stage(terminal: info, items: record.items, plan: [], usage: nil, mode: nil, activity: nil, since: nil)
            } else {
                let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: data.appendingPathComponent(member.snapshot)))
                if let style = try? JSONDecoder().decode(TerminalStyle.self, from: Data(contentsOf: data.appendingPathComponent("style.json"))) {
                    pane.screen.probeStyle(style)
                }
                pane.screen.view.feed(text: snapshot.data)
            }
        }
        model.focus(pane: 1, force: true)
        try await DesignPreview.settle()
        try await Task.sleep(for: .seconds(1))
        try DesignPreview.write(host, to: file)
        model.stop()
        window.close()
    }
}
#endif
