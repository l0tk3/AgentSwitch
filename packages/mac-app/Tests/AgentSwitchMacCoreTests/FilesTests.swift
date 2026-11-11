import XCTest
@testable import AgentSwitchMacCore

/// docs/files-v0.md: the Files column's reads as the service says them, its path row, its tree and its words.
final class FilesTests: XCTestCase {
    func testReadsALevelAnEntryAndAPreviewAsTheServiceSaysThem() throws {
        let level = try JSONDecoder().decode(FileLevel.self, from: Data(#"""
        {"path":"/Users/you/lumen","parent":"/Users/you","home":"/Users/you","more":0,"hiddenCount":2,"entries":[
          {"name":"src","kind":"dir","size":0,"mtime":1760600000000,"hidden":false},
          {"name":"docs-link","kind":"link","size":0,"mtime":1,"hidden":false,"link":{"target":"/Users/you/Documents","kind":"dir"}},
          {"name":"node_modules","kind":"dir","size":0,"mtime":1,"hidden":false,"dim":true},
          {"name":".secret-gate","kind":"dir","size":0,"mtime":0,"hidden":true,"locked":true},
          {"name":"app.ts","kind":"file","size":2140,"mtime":1760600000000,"hidden":false}]}
        """#.utf8))
        XCTAssertEqual(level.entries.map(\.isFolder), [true, true, true, true, false])
        XCTAssertEqual(level.entries[1].link, FileEntry.Link(target: "/Users/you/Documents", kind: .dir))
        XCTAssertTrue(level.entries[2].dim)
        XCTAssertTrue(level.entries[3].locked)
        XCTAssertEqual(level.hiddenCount, 2)
        XCTAssertFalse(level.scoped)
        let details = try JSONDecoder().decode(FileDetails.self, from: Data(#"{"name":".env","kind":"file","size":48,"mtime":1,"hidden":true,"path":"/Users/you/lumen/.env","type":"text","lines":3,"sensitive":{"reason":"env"}}"#.utf8))
        XCTAssertEqual(details.sensitive, "env")
        XCTAssertEqual(details.lines, 3)
        XCTAssertEqual(details.type, .text)
        XCTAssertEqual(details.entry.name, ".env")
        let plain = try JSONDecoder().decode(FileDetails.self, from: Data(#"{"name":"src","kind":"dir","size":0,"mtime":1,"hidden":false,"path":"/Users/you/lumen/src","items":3}"#.utf8))
        XCTAssertNil(plain.sensitive)
        XCTAssertEqual(plain.items, 3)
        XCTAssertEqual(try JSONDecoder().decode(FileTextPreview.self, from: Data(#"{"text":"a\n","truncated":false,"lines":1,"size":2}"#.utf8)).text, "a\n")
    }

    func testAsksTheRoutesOfTheNodeTheClientIsOn() async throws {
        let transport = StubTransport { request in
            if request.url!.path == "/files" { return (200, #"{"path":"/Users/you","parent":"/Users","home":"/Users/you","entries":[],"more":0,"hiddenCount":0}"#) }
            if request.url!.path == "/nodes/mini/files" { return (403, #"{"error":"scope"}"#) }
            return (200, #"{"ok":true,"files":{"mode":"folders","folders":["/Users/you/lumen"]}}"#)
        }
        let here = DaemonClient(port: 4711, transport: transport)
        _ = try await here.fileLevel(path: "/Users/you/My Projects", hidden: true)
        _ = try await here.fileLevel(path: nil, hidden: false)
        do {
            _ = try await here.onNode("mini").fileLevel(path: "/Users/you", hidden: false)
            XCTFail("a refusal")
        } catch {
            XCTAssertEqual(FilesRefusal(error), .scope)
            XCTAssertEqual(FilesRefusal(error).sentence(node: "Mac mini"), "此文件夹不在 Mac mini 给这台设备的授权范围内。")
        }
        let set = try await here.onNode("mini").setDeviceFiles(id: "dev 1", scope: FileScope(mode: .folders, folders: ["/Users/you/lumen"]))
        XCTAssertEqual(set, FileScope(mode: .folders, folders: ["/Users/you/lumen"]))
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url!.path)\($0.url!.query.map { "?" + $0 } ?? "")" }, [
            "GET /files?hidden=1&path=/Users/you/My%20Projects", "GET /files?hidden=0", "GET /nodes/mini/files?hidden=0&path=/Users/you",
            "PUT /devices/dev 1/files"])
        XCTAssertTrue(transport.requests.last!.url!.absoluteString.hasSuffix("/devices/dev%201/files"))
        XCTAssertEqual(try JSONDecoder().decode(FileScope.self, from: transport.requests.last!.httpBody!), FileScope(mode: .folders, folders: ["/Users/you/lumen"]))
        // The scope's other modes carry no folders; the switch says files too, and an older service is taken as on.
        XCTAssertEqual(String(data: try JSONEncoder().encode(FileScope(mode: .home, folders: ["/x"])), encoding: .utf8), #"{"mode":"home"}"#)
        XCTAssertEqual(try JSONDecoder().decode(MeshSettings.self, from: Data(#"{"keyboard":false}"#.utf8)), MeshSettings(keyboard: false, files: true))
        XCTAssertEqual(try JSONDecoder().decode(MeshSettings.self, from: Data(#"{"keyboard":true,"files":false}"#.utf8)).files, false)
        let device = try JSONDecoder().decode(Device.self, from: Data(#"{"id":"d1","name":"iPhone","platform":"ios","files":{"mode":"none"}}"#.utf8))
        XCTAssertEqual(device.files, FileScope(mode: .none))
    }

    func testThePathRowFoldsItsMiddleKeepingTheDiskAndTheLastTwo() {
        let levels = FilesPath.levels(of: "/Users/you/Desktop/WorkSpace/Projects/lumen")
        XCTAssertEqual(levels.map(\.name), ["/", "Users", "you", "Desktop", "WorkSpace", "Projects", "lumen"])
        XCTAssertEqual(levels.last?.path, "/Users/you/Desktop/WorkSpace/Projects/lumen")
        let width: (FilesPath.Level) -> Double = { Double($0.name.count + 3) * 7 }
        XCTAssertEqual(FilesPath.fitted(levels, budget: 1000, width: width, fold: 21).folded, [])
        let tight = FilesPath.fitted(levels, budget: 160, width: width, fold: 21)
        XCTAssertEqual(tight.shown.map(\.name), ["/", "Projects", "lumen"])
        XCTAssertEqual(tight.folded.map(\.name), ["Users", "you", "Desktop", "WorkSpace"])
        let some = FilesPath.fitted(levels, budget: 270, width: width, fold: 21)
        XCTAssertEqual(some.shown.map(\.name), ["/", "WorkSpace", "Projects", "lumen"])
        XCTAssertEqual(FilesPath.levels(of: "/").map(\.name), ["/"])
        XCTAssertEqual(FilesPath.parent(of: "/Users"), "/")
        XCTAssertNil(FilesPath.parent(of: "/"))
        XCTAssertEqual(FilesPath.relative("/Users/you/lumen/src/app.ts", to: "/Users/you/lumen"), "src/app.ts")
        XCTAssertNil(FilesPath.relative("/Users/you/lumenx/a", to: "/Users/you/lumen"))
        XCTAssertEqual(FilesPath.join("/", "Users"), "/Users")
    }

    func testTheTreeShowsOpenFoldersWhoseLevelsWereReadWithTheirStems() {
        let root = "/p"
        func dir(_ n: String) -> FileEntry { FileEntry(name: n, kind: .dir) }
        func file(_ n: String) -> FileEntry { FileEntry(name: n, kind: .file, size: 1) }
        let levels = [
            "/p": FileLevel(path: "/p", parent: "/", home: "/h", entries: [file("b.ts"), dir("src"), file(".env"), dir("docs")]),
            "/p/src": FileLevel(path: "/p/src", parent: "/p", home: "/h", entries: [file("main.ts"), dir("lib")]),
        ]
        let rows = FilesTree.rows(root: root, levels: levels, open: ["/p/src", "/p/docs"], order: .name, hidden: false)
        XCTAssertEqual(rows.map(\.path), ["/p/docs", "/p/src", "/p/src/lib", "/p/src/main.ts", "/p/b.ts"])
        XCTAssertEqual(rows.map(\.twig), ["├─", "├─", "│  ├─", "│  └─", "└─"])
        XCTAssertEqual(rows.map(\.waiting), [true, false, false, false, false])
        XCTAssertEqual(FilesTree.rows(root: root, levels: levels, open: [], order: .name, hidden: true).map(\.entry.name), ["docs", "src", "b.ts", ".env"])
    }

    func testOrdersFoldersFirstThenAsAsked() {
        let entries = [FileEntry(name: "b.ts", kind: .file, size: 10, mtime: 3), FileEntry(name: "file10", kind: .file, size: 5, mtime: 1),
                       FileEntry(name: "file9", kind: .file, size: 50, mtime: 2), FileEntry(name: "z", kind: .dir), FileEntry(name: ".a", kind: .file, size: 1, mtime: 9)]
        XCTAssertEqual(FilesSort.name.sorted(entries).map(\.name), ["z", ".a", "b.ts", "file9", "file10"])
        XCTAssertEqual(FilesSort.modified.sorted(entries).map(\.name), ["z", ".a", "b.ts", "file9", "file10"])
        XCTAssertEqual(FilesSort.size.sorted(entries).map(\.name), ["z", "file9", "b.ts", "file10", ".a"])
        XCTAssertEqual(FilesTypeahead.next("f", in: ["a", "file1", "b", "File2"], after: 1), 3)
        XCTAssertEqual(FilesTypeahead.next("e", in: ["a", ".env"], after: nil), 1)
        XCTAssertNil(FilesTypeahead.next("q", in: ["a"], after: nil))
    }

    func testWritesSizesTimesAndKindsAsTheColumnDoes() throws {
        XCTAssertEqual(FilesText.size(120, short: true), "120B")
        XCTAssertEqual(FilesText.size(2140, short: true), "2.1K")
        XCTAssertEqual(FilesText.size(48_200_000, short: true), "48M")
        XCTAssertEqual(FilesText.size(3980, short: true), "4.0K")
        XCTAssertEqual(FilesText.size(2140, short: false), "2.1 KB")
        XCTAssertEqual(FilesText.size(1, short: false), "1 byte")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 14)))
        XCTAssertEqual(FilesText.date(try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 13, minute: 2))), now: now, calendar: calendar), "Today 13:02")
        XCTAssertEqual(FilesText.date(try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 15, hour: 9))), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(FilesText.date(try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 9, day: 2))), now: now, calendar: calendar), "9/2")
        XCTAssertEqual(FilesText.date(try XCTUnwrap(calendar.date(from: DateComponents(year: 2025, month: 1, day: 2))), now: now, calendar: calendar), "2025/1/2")
        XCTAssertEqual(FilesText.kind(of: "app.ts", isFolder: false, type: .text), "TypeScript")
        XCTAssertEqual(FilesText.kind(of: "notes", isFolder: false, type: .text), "Plain Text")
        XCTAssertEqual(FilesText.kind(of: "src", isFolder: true, type: nil), "Folder")
        let details = FileDetails(entry: FileEntry(name: "app.ts", kind: .file, size: 2140, mtime: now.timeIntervalSince1970 * 1000 - 3_600_000), path: "/p/app.ts", type: .text, lines: 14)
        XCTAssertTrue(FilesText.info(details, now: now).hasPrefix("TypeScript · 2.1 KB · 14 Lines · "))
    }

    /// The same table as the service's (daemon tests/fileBrowse.test.ts), for this Mac's own paths.
    func testTellsWhatMayHoldAPasswordByWhereItIsAndItsName() {
        let home = "/Users/you"
        XCTAssertEqual(FilesSensitive.reason("/Users/you/p/.env", home: home), "env")
        XCTAssertNil(FilesSensitive.reason("/Users/you/p/.env.example", home: home))
        XCTAssertEqual(FilesSensitive.reason("/Users/you/p/.env.local", home: home), "env")
        XCTAssertEqual(FilesSensitive.reason("/Users/you/.ssh/id_ed25519", home: home), "ssh")
        XCTAssertNil(FilesSensitive.reason("/Users/you/.ssh/id_ed25519.pub", home: home))
        XCTAssertNil(FilesSensitive.reason("/Users/you/.ssh/config", home: home))
        XCTAssertEqual(FilesSensitive.reason("/Users/you/.codex/auth.json", home: home), "login")
        XCTAssertEqual(FilesSensitive.reason("/Users/you/.grok/auth.json", home: home), "login")
        XCTAssertEqual(FilesSensitive.reason("/Users/you/.aws/credentials", home: home), "cloud")
        XCTAssertEqual(FilesSensitive.reason("/srv/tls/server.pem", home: home), "key")
        XCTAssertEqual(FilesSensitive.reason("/any/id_rsa", home: home), "key")
        XCTAssertNil(FilesSensitive.reason("/Users/you/p/src/app.ts", home: home))
        XCTAssertEqual(FilesSensitive.question(names: [".env"]), "`.env` 可能含有密码或密钥。交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。")
        XCTAssertTrue(FilesSensitive.question(names: [".env", "id_ed25519"]).hasPrefix("这 2 个文件可能含有密码或密钥：`.env`、`id_ed25519`。"))
    }
}
