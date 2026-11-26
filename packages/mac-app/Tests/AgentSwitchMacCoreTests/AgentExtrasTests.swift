import XCTest
@testable import AgentSwitchMacCore

/// Grok and Antigravity in 设置 › Agents (docs/agents-v0.md §13): where their own programs are, what they say, and their
/// own updaters — with make-believe programs, never a real one.
final class AgentExtrasTests: XCTestCase {
    private var root: URL!
    private var bin: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("agentswitch-extras-\(UUID().uuidString)")
        bin = root.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    /// A program that answers `--version`, `update --check --json` (Grok) and `update`; `exit` is what `update` ends with.
    @discardableResult
    private func program(_ name: String, version: String, latest: String? = nil, exit: Int = 0, command: String) throws -> String {
        var body = "#!/bin/sh\ncase \"$1\" in\n--version) echo \"\(version)\";;\n"
        if let latest {
            body += "update)\n  if [ \"$2\" = \"--check\" ]; then echo '{\"currentVersion\":\"\(version)\",\"latestVersion\":\"\(latest)\",\"updateAvailable\":true}'; exit 0; fi\n"
            body += "  echo \"\(command)\" >> \"$FAKE_LOG\"; echo \"\(command) done\"; exit \(exit);;\n"
        } else {
            body += "update) echo \"\(command)\" >> \"$FAKE_LOG\"; echo \"\(command) done\"; exit \(exit);;\n"
        }
        body += "esac\n"
        let path = bin.appendingPathComponent(name)
        try body.write(to: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
        return path.path
    }

    private func environment(log: String = "") -> [String: String] {
        var env = ["HOME": root.path, "PATH": bin.path]
        if !log.isEmpty { env["FAKE_LOG"] = log }
        return env
    }

    func testItFindsTheProgramsOnThePathAndSaysWhatTheyAre() async throws {
        let grok = try program("grok", version: "grok 1.0.92 (abcdef)", latest: "1.0.93", command: "grok-updated")
        let agy = try program("agy", version: "1.5.17", command: "agy-updated")
        let extras = await AgentExtras.scan(home: root.path, path: bin.path, environment: environment())
        XCTAssertEqual(extras.map(\.id), ["grok", "agy"])
        XCTAssertEqual(extras.map(\.binary), [grok, agy])
        XCTAssertEqual(extras.map(\.version), ["1.0.92", "1.5.17"])
        XCTAssertEqual(extras.map(\.canCheck), [true, false])
        XCTAssertTrue(extras.allSatisfy(\.installed))
    }

    func testTheVariableNamesItsProgramAndItsOwnFolderIsTheLastPlace() async throws {
        let elsewhere = root.appendingPathComponent("elsewhere/grok")
        try FileManager.default.createDirectory(at: elsewhere.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho 'grok 1.0.80'\n".write(to: elsewhere, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: elsewhere.path)
        var env = environment()
        env["GROK_BIN"] = elsewhere.path
        let named = await AgentExtras.scan(home: root.path, path: "/nothing", environment: env)
        XCTAssertEqual(named.first { $0.id == "grok" }?.binary, elsewhere.path)
        XCTAssertEqual(named.first { $0.id == "grok" }?.version, "1.0.80")
        // Its installer's own place, when the PATH does not have it.
        let own = root.appendingPathComponent(".local/bin/agy")
        try FileManager.default.createDirectory(at: own.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho '1.5.10'\n".write(to: own, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: own.path)
        let ownFolder = await AgentExtras.scan(home: root.path, path: "/nothing", environment: ["HOME": root.path, "PATH": "/nothing"])
        XCTAssertEqual(ownFolder.first { $0.id == "agy" }?.binary, own.path)
        XCTAssertEqual(ownFolder.first { $0.id == "agy" }?.version, "1.5.10")
    }

    func testGrokSaysWhatTheNewestIsAndAntigravityDoesNot() async throws {
        try program("grok", version: "grok 1.0.92", latest: "1.0.93", command: "grok-updated")
        try program("agy", version: "1.5.17", command: "agy-updated")
        let scanned = await AgentExtras.scan(home: root.path, path: bin.path, environment: environment())
        let grok = await AgentExtras.check(try XCTUnwrap(scanned.first { $0.id == "grok" }), environment: environment(), path: bin.path)
        XCTAssertEqual(grok.latest, "1.0.93")
        XCTAssertEqual(grok.newer, "1.0.93")
        XCTAssertNil(grok.problem)
        let agy = await AgentExtras.check(try XCTUnwrap(scanned.first { $0.id == "agy" }), environment: environment(), path: bin.path)
        XCTAssertNil(agy.latest)
        XCTAssertNil(agy.newer, "Antigravity does not say what the newest is")
    }

    func testAProgramThatDoesNotAnswerKeepsWhatItHadAndSaysWhy() async throws {
        let path = try program("grok", version: "grok 1.0.92", latest: nil, command: "grok-updated")
        var extra = AgentExtra(id: "grok", title: "Grok", command: "grok", binary: path, version: "1.0.92", latest: "1.0.93", canCheck: true)
        extra = await AgentExtras.check(extra, environment: environment(), path: bin.path)
        XCTAssertEqual(extra.latest, "1.0.93", "the answer it had stays")
        XCTAssertNotNil(extra.problem)
    }

    func testItsOwnUpdaterIsRunAndWhatItSaidIsKept() async throws {
        let log = root.appendingPathComponent("fake.log").path
        let path = try program("grok", version: "grok 1.0.92", latest: "1.0.93", command: "grok-updated")
        let extra = AgentExtra(id: "grok", title: "Grok", command: "grok", binary: path, version: "1.0.92", latest: "1.0.93", canCheck: true)
        let lines = Lines()
        let phases = Phases()
        try await AgentExtras.update(extra, environment: environment(log: log), path: bin.path, log: { lines.add($0) }, report: { phases.add($0) })
        XCTAssertEqual(try String(contentsOfFile: log, encoding: .utf8), "grok-updated\n")
        XCTAssertTrue(lines.all.contains { $0.contains("$ \(path) update") })
        XCTAssertTrue(lines.all.contains { $0.contains("grok-updated done") })
        XCTAssertEqual(phases.all, [.updating])
    }

    func testAnUpdaterThatFailsIsSaidSoAndThrown() async throws {
        let log = root.appendingPathComponent("fake.log").path
        let path = try program("agy", version: "1.5.17", exit: 3, command: "agy-updated")
        let extra = AgentExtra(id: "agy", title: "Antigravity", command: "agy", binary: path, version: "1.5.17", canCheck: false)
        let lines = Lines()
        do {
            try await AgentExtras.update(extra, environment: environment(log: log), path: bin.path, log: { lines.add($0) })
            XCTFail("an updater that exits 3 throws")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("3"), error.localizedDescription)
        }
        XCTAssertTrue(lines.all.contains { $0.contains("exit 3") })
    }

    func testNothingInstalledIsNothingInstalled() async throws {
        let extras = await AgentExtras.scan(home: root.path, path: "/nothing", environment: ["HOME": root.path, "PATH": "/nothing"])
        XCTAssertEqual(extras.map(\.installed), [false, false])
        XCTAssertNil(extras[0].binary)
        do {
            try await AgentExtras.update(extras[0], environment: ["PATH": "/nothing"], path: "/nothing")
            XCTFail("nothing installed, nothing to update")
        } catch { XCTAssertTrue(error.localizedDescription.contains("没有安装")) }
    }

    func testABoardCarriesThemAndTheirJobs() throws {
        let extras = [AgentExtra(id: "grok", title: "Grok", command: "grok", binary: "/Users/x/.grok/bin/grok", version: "1.0.92", latest: "1.0.93", canCheck: true),
                      AgentExtra(id: "agy", title: "Antigravity", command: "agy", binary: "/Users/x/.local/bin/agy", version: "1.5.17", canCheck: false)]
        let board = AgentsBoard(home: "/Users/x", store: "/Users/x/.local/share/agentswitch/cli", storeExists: false, agents: [], releases: nil, checking: false,
                                use: [:], applied: [:], running: false, jobs: [:], pathNotes: [], uninstallPaths: [:],
                                extras: extras, extraJobs: ["grok": AgentExtraJob(id: "grok", phase: .updating, error: "更新失败（退出码 3）。")])
        let back = try JSONDecoder().decode(AgentsBoard.self, from: JSONEncoder().encode(board))
        XCTAssertEqual(back.extras, extras)
        XCTAssertEqual(back.extraJobs?["grok"]?.phase, .updating)
        XCTAssertEqual(back.extraJobs?["grok"]?.error, "更新失败（退出码 3）。")
        XCTAssertEqual(back.updateCount, 1)
        // An action for one of them says so by its id; one for the four is written as it was.
        let extraAction = try JSONEncoder().encode(AgentsAction(.update, extra: "grok"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: extraAction) as? [String: String], ["kind": "update", "extra": "grok"])
        // A board from an app of before them decodes with none.
        let old = Data(#"{"home":"/Users/x","store":"/s","storeExists":false,"agents":[],"checking":false,"use":{},"applied":{},"running":false,"jobs":{},"pathNotes":[],"uninstallPaths":{}}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(AgentsBoard.self, from: old).extras)
    }
}

/// What an updater logged, from its own thread.
private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [String] = []
    func add(_ line: String) { lock.lock(); kept.append(line); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return kept }
}

/// The phases an updater reported.
private final class Phases: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [AgentStore.Phase] = []
    func add(_ phase: AgentStore.Phase) { lock.lock(); kept.append(phase); lock.unlock() }
    var all: [AgentStore.Phase] { lock.lock(); defer { lock.unlock() }; return kept }
}
