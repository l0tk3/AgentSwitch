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

    /// A path the screen found (2026-10-01, user: 这种路径我用 cmd+鼠标点击没反应): a file, from home or from where the
    /// agent works; a `:line:column` citation is dropped; a URL stays a URL.
    func testPathsBecomeFiles() {
        let wd = "/Users/me/Projects/AgentSwitch"
        func path(_ link: String) -> String? { LinkPolicy.url(fromLink: link, workdir: wd, home: "/Users/me")?.path }
        XCTAssertEqual(path("/Users/me/Desktop/a b/crt.html"), "/Users/me/Desktop/a b/crt.html")
        XCTAssertEqual(path("~/AgentSwitch/2026-09-29-843dd0fb"), "/Users/me/AgentSwitch/2026-09-29-843dd0fb")
        XCTAssertEqual(path("./docs/ui-v0.md"), "/Users/me/Projects/AgentSwitch/docs/ui-v0.md")
        XCTAssertEqual(path("../other/x.txt"), "/Users/me/Projects/other/x.txt")
        XCTAssertEqual(path("packages/daemon/src/api/live.ts:232:5"), "/Users/me/Projects/AgentSwitch/packages/daemon/src/api/live.ts")
        XCTAssertEqual(LinkPolicy.url(fromLink: "file:///tmp/x.png", workdir: wd)?.absoluteString, "file:///tmp/x.png")
        XCTAssertEqual(LinkPolicy.url(fromLink: "https://example.com/a", workdir: wd)?.absoluteString, "https://example.com/a")
        XCTAssertNil(LinkPolicy.url(fromLink: "docs/a.md", workdir: nil))
        // A real file found this way opens as a document does.
        let file = dir.appendingPathComponent("page.html")
        FileManager.default.createFile(atPath: file.path, contents: Data("<p>x</p>".utf8))
        let url = LinkPolicy.url(fromLink: file.path, workdir: nil)!
        XCTAssertEqual(LinkPolicy.action(for: url), .open(url.resolvingSymlinksInPath()))
    }

    /// A link taken too far (the next line's words glued on) still finds the file; nothing is opened for a path that is
    /// not there, not even its folder.
    func testTheFileIsCheckedOnDisk() throws {
        let file = dir.appendingPathComponent("crt.html")
        FileManager.default.createFile(atPath: file.path, contents: Data("x".utf8))
        let glued = URL(fileURLWithPath: file.path + "see docs/ui-v0.")
        XCTAssertEqual(LinkPolicy.existingFile(glued)?.path, file.path)
        XCTAssertEqual(LinkPolicy.existingFile(file)?.path, file.path)
        XCTAssertNil(LinkPolicy.existingFile(dir.appendingPathComponent("missing.html")))
        let web = URL(string: "https://example.com")!
        XCTAssertEqual(LinkPolicy.existingFile(web), web)
    }

    func testWebAndOtherSchemes() throws {
        let web = try XCTUnwrap(URL(string: "https://example.com/a"))
        XCTAssertEqual(LinkPolicy.action(for: web), .browse(web))
        XCTAssertEqual(LinkPolicy.action(for: try XCTUnwrap(URL(string: "ssh://host"))), .ignore)
        XCTAssertEqual(LinkPolicy.action(for: dir.appendingPathComponent("missing.png")), .ignore)
    }
}
