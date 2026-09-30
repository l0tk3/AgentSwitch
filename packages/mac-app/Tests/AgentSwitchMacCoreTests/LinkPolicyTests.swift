import XCTest
@testable import AgentSwitchMacCore

/// ⌘-click on a terminal link (docs/terminal-v0.md §1 链接): documents open as in iTerm, nothing that could run does.
final class LinkPolicyTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-links-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func file(_ name: String, executable: Bool = false) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try Data("x".utf8).write(to: url)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path) }
        return url.resolvingSymlinksInPath()
    }

    func testDocumentsOpenInTheirApp() throws {
        for name in ["shot.png", "report.pdf", "notes.txt", "data.json", "clip.mov"] {
            let url = try file(name)
            XCTAssertEqual(LinkPolicy.action(for: url), .open(url), name)
        }
        let folder = dir.appendingPathComponent("src")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        XCTAssertEqual(LinkPolicy.action(for: folder), .open(folder.resolvingSymlinksInPath()))
    }

    func testWhatCouldRunIsOnlyShown() throws {
        for (name, executable) in [("run.command", false), ("build.sh", false), ("tool.py", false), ("notes.txt", true), ("blob.bin", false)] {
            let url = try file(name, executable: executable)
            XCTAssertEqual(LinkPolicy.action(for: url), .reveal(url), name)
        }
        let app = dir.appendingPathComponent("Fake.app")
        try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        XCTAssertEqual(LinkPolicy.action(for: app), .reveal(app.resolvingSymlinksInPath()))
    }

    func testALinkIsJudgedByWhereItPoints() throws {
        let script = try file("real.command")
        let link = dir.appendingPathComponent("innocent.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: script)
        XCTAssertEqual(LinkPolicy.action(for: link), .reveal(script))
    }

    func testWebAndOtherSchemes() throws {
        let web = try XCTUnwrap(URL(string: "https://example.com/a"))
        XCTAssertEqual(LinkPolicy.action(for: web), .browse(web))
        XCTAssertEqual(LinkPolicy.action(for: try XCTUnwrap(URL(string: "ssh://host"))), .ignore)
        XCTAssertEqual(LinkPolicy.action(for: dir.appendingPathComponent("missing.png")), .ignore)
    }
}
