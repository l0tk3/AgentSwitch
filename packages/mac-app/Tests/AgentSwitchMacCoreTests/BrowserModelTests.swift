import CoreGraphics
import XCTest
@testable import AgentSwitchMacCore

/// The Browser page's logic (docs/browser-v0.md §1 Mac, §5): the daemon's shapes decoded tolerantly, the stream's
/// events and how they change a tab, the SSE parser for long lines, the screen's geometry, the input events and their
/// queue, the keys, and what the page writes.
final class BrowserModelTests: XCTestCase {
    private typealias F = DispatchFixture

    static func tabObject(_ id: String, owner: [String: Any] = ["kind": "you", "id": "you", "label": "You"], title: String = "Page",
                          url: String = "https://example.com/", status: String = "idle", heldBy: Any = NSNull(), action: Any = NSNull()) -> [String: Any] {
        ["id": id, "owner": owner, "title": title, "url": url, "site": "example.com", "kind": "web", "status": status, "loading": false,
         "heldBy": heldBy, "action": action, "viewport": ["width": 1280, "height": 800, "scale": 1, "mobile": false, "by": NSNull()],
         "openedAt": 1_790_000_000_000]
    }

    static var codex: [String: Any] { ["kind": "terminal", "id": "k1", "label": "codex · AgentSwitch"] }

    // MARK: decoding

    func testTheListDecodesAsTheDaemonSendsIt() throws {
        let list = try F.decode(BrowserTabList.self, object: [
            "running": true,
            "groups": [
                ["owner": Self.codex, "tabs": [Self.tabObject("a", owner: Self.codex, title: "PR #128", status: "busy",
                                                              action: ["tool": "browser_click", "description": "click \"Merge\"",
                                                                       "box": ["x": 10, "y": 20, "width": 100, "height": 30], "at": 1_790_000_000_500])]],
                ["owner": ["kind": "you", "id": "you", "label": "You"], "tabs": [Self.tabObject("b", heldBy: "mac-main")]],
            ],
        ])
        XCTAssertTrue(list.running)
        XCTAssertEqual(list.tabs.map(\.id), ["a", "b"])
        let a = try XCTUnwrap(list.tab("a"))
        XCTAssertEqual(a.owner.kind, .terminal)
        XCTAssertEqual(a.owner.harness, "codex")
        XCTAssertEqual(a.status, .busy)
        XCTAssertEqual(a.action?.box, BrowserBox(x: 10, y: 20, width: 100, height: 30))
        XCTAssertEqual(a.viewport, BrowserViewport(width: 1280, height: 800))
        XCTAssertNotNil(a.openedAt)
        XCTAssertEqual(list.tab("b")?.heldBy, "mac-main")
    }

    func testUnknownWordsAndMissingFieldsDoNotFailTheList() throws {
        let list = try F.decode(BrowserTabList.self, object: [
            "groups": [
                ["owner": ["kind": "robot", "id": "r"], "tabs": [
                    ["id": "x", "status": "dreaming", "kind": "ftp", "viewport": "huge", "action": "nope", "future": [1, 2]],
                    ["title": "no id: left out"],
                ]],
                ["owner": ["kind": "you"], "tabs": []],
            ],
        ])
        XCTAssertFalse(list.running)
        XCTAssertEqual(list.groups.count, 1, "an empty group is left out")
        let tab = try XCTUnwrap(list.tabs.first)
        XCTAssertEqual(list.tabs.count, 1, "a tab without an id is left out")
        XCTAssertEqual(tab.status, .idle)
        XCTAssertEqual(tab.kind, .web)
        XCTAssertEqual(tab.owner.kind, .you, "an unknown owner is taken for a person's")
        XCTAssertEqual(tab.viewport, .standard)
        XCTAssertNil(tab.action)
        XCTAssertNil(tab.heldBy)
    }

    func testServersDecode() throws {
        let list = try F.decode(BrowserServerList.self, object: ["servers": [
            ["port": 5173, "bind": "loopback", "pid": 42, "name": "vite", "cwd": "/Users/me/site", "url": "http://localhost:5173/"],
            ["name": "no port: left out"],
            ["port": 3000],
        ]])
        XCTAssertEqual(list.servers.map(\.port), [5173, 3000])
        XCTAssertEqual(list.servers[1].url, "http://localhost:3000/")
        XCTAssertEqual(BrowserTabText.server(list.servers[0], home: "/Users/me"), "localhost:5173 · vite · ~/site")
        XCTAssertEqual(BrowserTabText.server(list.servers[1], home: "/Users/me"), "localhost:3000")
    }

    func testOwnersNameTheirAgent() {
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch").harness, "codex")
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "claude · site").harness, "claude-code")
        XCTAssertEqual(BrowserOwner(kind: .task, id: "t", label: "登录财务平台下载对账单").harness, nil, "a task's title names no agent")
        XCTAssertNil(BrowserOwner.you.harness)
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch").agentName, "codex")
        // In a sentence and on the holder line, by the name people call it (2026-10-02 review).
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch").agentTitle, "Codex")
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "claude · site").agentTitle, "Claude Code")
        XCTAssertEqual(BrowserOwner(kind: .terminal, id: "k", label: "opencode · site").agentTitle, "OpenCode")
        XCTAssertEqual(BrowserOwner(kind: .task, id: "t", label: "登录财务平台").agentTitle, "登录财务平台", "a task's title as it is")
    }

    func testTheHolderLineAndWhyAHoldEnded() {
        let codex = BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch")
        XCTAssertEqual(BrowserTabText.heldHere(BrowserTab(id: "a", owner: codex, heldBy: "mac-main")), "You · Taken Over from Codex")
        XCTAssertEqual(BrowserTabText.heldHere(BrowserTab(id: "a", heldBy: "mac-main")), "You · Taken Over")
        XCTAssertEqual(BrowserTabText.holdEnded(reason: .idle, heldBy: nil), "2 分钟无操作，已自动交还。")
        XCTAssertEqual(BrowserTabText.holdEnded(reason: .take, heldBy: "phone-1"), "此标签已由其他屏幕接手。")
        XCTAssertNil(BrowserTabText.holdEnded(reason: .handBack, heldBy: nil), "this Mac's own Hand Back says nothing")
        XCTAssertNil(BrowserTabText.holdEnded(reason: .take, heldBy: nil))
        XCTAssertNil(BrowserTabText.holdEnded(reason: nil, heldBy: nil))
    }

    func testARefusedStreamIsTriedAgainLaterAndSaidOnce() {
        let start = ContinuousClock.now
        var retry = BrowserStreamRetry()
        XCTAssertTrue(retry.allows("a", at: start))
        XCTAssertTrue(retry.failed("a", at: start), "the first refusal is said")
        XCTAssertFalse(retry.allows("a", at: start.advanced(by: .seconds(1))))
        XCTAssertTrue(retry.allows("a", at: start.advanced(by: .seconds(2))))
        XCTAssertTrue(retry.allows("b", at: start), "another tab is not held back")
        XCTAssertFalse(retry.failed("a", at: start.advanced(by: .seconds(2))), "the next refusals are not")
        XCTAssertFalse(retry.allows("a", at: start.advanced(by: .seconds(5))))
        XCTAssertTrue(retry.allows("a", at: start.advanced(by: .seconds(6))), "2 s, then 4 s")
        for n in 3...10 { _ = retry.failed("a", at: start.advanced(by: .seconds(n * 100))) }
        XCTAssertFalse(retry.allows("a", at: start.advanced(by: .seconds(1000 + 59))))
        XCTAssertTrue(retry.allows("a", at: start.advanced(by: .seconds(1000 + 60))), "at most a minute")
        retry.succeeded("a")
        XCTAssertTrue(retry.allows("a", at: start.advanced(by: .seconds(1000))))
        XCTAssertTrue(retry.failed("a", at: start), "said again after it worked")
        XCTAssertTrue(retry.failed("b", at: start), "another tab's refusal is its own")
        retry.reset()
        XCTAssertEqual(retry, BrowserStreamRetry())
    }

    // MARK: the list

    func testTheSelectionStaysOrMovesToTheNeighbour() {
        func list(_ ids: [String]) -> BrowserTabList {
            BrowserTabList(running: true, groups: [BrowserTabGroup(owner: .you, tabs: ids.map { BrowserTab(id: $0) })])
        }
        let before = list(["a", "b", "c"])
        XCTAssertEqual(before.selection(keeping: "b"), "b")
        XCTAssertEqual(list(["a", "c"]).selection(keeping: "b", previous: before), "c", "the next one")
        XCTAssertEqual(list(["a", "b"]).selection(keeping: "c", previous: before), "b", "the last closed: the one before")
        XCTAssertEqual(list(["x"]).selection(keeping: "b", previous: before), "x", "none of its neighbours: the first")
        XCTAssertEqual(list(["a"]).selection(keeping: nil), "a")
        XCTAssertNil(BrowserTabList.empty.selection(keeping: "a"))
    }

    func testReplacingAndRemovingKeepTheRest() {
        let list = BrowserTabList(running: true, groups: [
            BrowserTabGroup(owner: .you, tabs: [BrowserTab(id: "a"), BrowserTab(id: "b")]),
            BrowserTabGroup(owner: BrowserOwner(kind: .task, id: "t", label: "T"), tabs: [BrowserTab(id: "c")]),
        ])
        let renamed = list.replacing(BrowserTab(id: "b", title: "New"))
        XCTAssertEqual(renamed.tab("b")?.title, "New")
        XCTAssertEqual(list.tab("b")?.title, "", "the original is left as it was")
        XCTAssertEqual(list.replacing(BrowserTab(id: "zz")), list)
        let removed = list.removing("c")
        XCTAssertEqual(removed.groups.count, 1, "the emptied group goes")
        XCTAssertEqual(removed.tabs.map(\.id), ["a", "b"])
    }

    func testActivityCountsAgentsAtWorkAndWaiting() {
        let list = BrowserTabList(running: true, groups: [BrowserTabGroup(owner: .you, tabs: [
            BrowserTab(id: "a", status: .busy), BrowserTab(id: "b", status: .waiting), BrowserTab(id: "c"), BrowserTab(id: "d", status: .busy),
        ])])
        XCTAssertEqual(PageActivity.of(list), PageActivity(busy: 2, waiting: 1))
        XCTAssertEqual(PageActivity.of(list).mark, .waiting)
        XCTAssertEqual(PageActivity.of(.empty), .none)
    }

    // MARK: the stream's events

    func testStreamEventsDecode() {
        let tab = BrowserStreamEvent.decode(event: "tab", data: String(decoding: F.json(["type": "tab", "tab": Self.tabObject("a")]), as: UTF8.self))
        XCTAssertEqual(tab, .tab(BrowserTab(id: "a", title: "Page", url: "https://example.com/", site: "example.com", kind: .web,
                                            openedAt: Date(timeIntervalSince1970: 1_790_000_000))))
        let frame = BrowserStreamEvent.decode(event: "frame", data: #"{"type":"frame","seq":7,"data":"/9j/","format":"jpeg","width":1280,"height":800,"scale":1,"viewport":{"width":1280,"height":800},"pageScale":1,"scrollX":0,"scrollY":120}"#)
        guard case .frame(let f)? = frame else { return XCTFail("a frame") }
        XCTAssertEqual(f.seq, 7)
        XCTAssertEqual(f.geometry, BrowserFrameGeometry(seq: 7, width: 1280, height: 800, scale: 1))
        XCTAssertEqual(f.scrollY, 120)
        XCTAssertEqual(BrowserStreamEvent.decode(event: "url", data: #"{"type":"url","url":"file:///x","site":"~/x","kind":"file"}"#),
                       .url(url: "file:///x", site: "~/x", kind: .file))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "title", data: #"{"title":"T"}"#), .title("T"))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "loading", data: #"{"loading":true}"#), .loading(true))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "status", data: #"{"status":"waiting"}"#), .status(.waiting))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "held", data: #"{"heldBy":null,"reason":"idle"}"#), .held(heldBy: nil, reason: .idle))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "held", data: #"{"heldBy":"phone-1","reason":"take"}"#), .held(heldBy: "phone-1", reason: .take))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "action", data: #"{"action":null}"#), .action(nil))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "viewport", data: #"{"viewport":{"width":900,"height":600,"scale":2,"mobile":false,"by":"mac-main"}}"#),
                       .viewport(BrowserViewport(width: 900, height: 600, scale: 2, by: "mac-main")))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "closed", data: #"{"reason":"browser-exited"}"#), .closed(.browserExited))
        XCTAssertEqual(BrowserStreamEvent.decode(event: "message", data: #"{"type":"title","title":"by type"}"#), .title("by type"),
                       "an unnamed event goes by its type")
        XCTAssertNil(BrowserStreamEvent.decode(event: "frame", data: #"{"seq":1}"#), "a frame without its picture")
        XCTAssertNil(BrowserStreamEvent.decode(event: "something", data: "{}"))
        XCTAssertNil(BrowserStreamEvent.decode(event: "title", data: "not json"))
    }

    func testEventsChangeOneThingOfTheTab() {
        let tab = BrowserTab(id: "a", owner: .you, title: "Old", url: "https://a.com/", site: "a.com", heldBy: "mac-main",
                             action: BrowserAction(tool: "t", description: "d"))
        XCTAssertEqual(BrowserStreamEvent.title("New").applied(to: tab).title, "New")
        let moved = BrowserStreamEvent.url(url: "file:///x.html", site: "~/x.html", kind: .file).applied(to: tab)
        XCTAssertEqual([moved.url, moved.site], ["file:///x.html", "~/x.html"])
        XCTAssertEqual(moved.kind, .file)
        XCTAssertEqual(moved.title, "Old")
        XCTAssertNil(BrowserStreamEvent.held(heldBy: nil, reason: .handBack).applied(to: tab).heldBy, "a hold that ended clears the holder")
        XCTAssertNil(BrowserStreamEvent.action(nil).applied(to: tab).action)
        XCTAssertEqual(BrowserStreamEvent.status(.busy).applied(to: tab).status, .busy)
        XCTAssertEqual(BrowserStreamEvent.closed(.closed).applied(to: tab), tab)
        XCTAssertEqual(tab.title, "Old", "the tab itself is not changed")
    }

    // MARK: the SSE parser

    func testLongLinesInPiecesAndCRLF() {
        let picture = String(repeating: "A", count: 300_000)
        let whole = Data("event: frame\r\ndata: {\"seq\":1,\"data\":\"\(picture)\"}\r\n\r\n: ping\n\nevent: title\ndata: {\"title\":\"x\"}\n\n".utf8)
        var parser = BrowserSSEParser()
        var got: [(event: String, data: String)] = []
        var i = whole.startIndex
        while i < whole.endIndex {
            let end = min(i + 4093, whole.endIndex)
            got += parser.feed(whole[i..<end])
            i = end
        }
        XCTAssertEqual(got.map(\.event), ["frame", "title"])
        XCTAssertEqual(got.first?.data, #"{"seq":1,"data":""# + picture + #""}"#)
        XCTAssertEqual(got.last?.data, #"{"title":"x"}"#)
    }

    func testMultiLineDataAndDefaults() {
        var parser = BrowserSSEParser()
        let got = parser.feed(Data("data: a\ndata: b\n\nid: 3\nretry: 9\nevent: x\n\n".utf8))
        XCTAssertEqual(got.count, 1, "an event without data is no event")
        XCTAssertEqual(got.first?.event, "message")
        XCTAssertEqual(got.first?.data, "a\nb")
    }

    // MARK: geometry

    func testTheFrameFitsFromTheTop() {
        let frame = BrowserFrameGeometry(width: 1280, height: 800)
        XCTAssertEqual(BrowserGeometry.fit(frame, in: CGSize(width: 640, height: 600)), CGRect(x: 0, y: 0, width: 640, height: 400),
                       "wide: across the whole width, at the top")
        XCTAssertEqual(BrowserGeometry.fit(frame, in: CGSize(width: 1000, height: 400)), CGRect(x: 180, y: 0, width: 640, height: 400),
                       "tall: centred across")
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 0, height: 0), in: CGSize(width: 10, height: 10)), .zero)
    }

    func testPointsMapToTheFramesPixels() {
        let frame = BrowserFrameGeometry(seq: 3, width: 1280, height: 800)
        let size = CGSize(width: 1000, height: 400)   // drawn at x 180…820, half size
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 180, y: 0), frame: frame, in: size), CGPoint(x: 0, y: 0))
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 500, y: 200), frame: frame, in: size), CGPoint(x: 640, y: 400))
        XCTAssertNil(BrowserGeometry.framePoint(CGPoint(x: 100, y: 200), frame: frame, in: size), "beside the frame")
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 100, y: 500), frame: frame, in: size, clamped: true), CGPoint(x: 0, y: 799),
                       "a drag that left the frame stays at its edge")
        XCTAssertEqual(BrowserGeometry.frameDistance(10, frame: frame, in: size), 20, "a scroll in the frame's pixels")
    }

    func testAnActionsBoxLandsOnTheView() {
        let size = CGSize(width: 640, height: 600)
        let box = BrowserBox(x: 100, y: 200, width: 300, height: 40)
        XCTAssertEqual(BrowserGeometry.viewRect(box, frame: BrowserFrameGeometry(width: 1280, height: 800), in: size),
                       CGRect(x: 50, y: 100, width: 150, height: 20))
        // A frame at twice the CSS pixels (scale 2): the box is in CSS pixels, the same place on screen.
        XCTAssertEqual(BrowserGeometry.viewRect(box, frame: BrowserFrameGeometry(width: 2560, height: 1600, scale: 2), in: size),
                       CGRect(x: 50, y: 100, width: 150, height: 20))
    }

    func testTheHeldSizeIsTheScreensPointsWithinTheDaemonsRange() {
        XCTAssertEqual(BrowserGeometry.viewport(for: CGSize(width: 1010.6, height: 700.2), backingScale: 2),
                       BrowserViewportRequest(width: 1010, height: 700, scale: 2))
        XCTAssertEqual(BrowserGeometry.viewport(for: CGSize(width: 120, height: 9000), backingScale: 8),
                       BrowserViewportRequest(width: 200, height: 4096, scale: 4))
    }

    // MARK: input

    private func encoded(_ event: BrowserInputEvent) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any]) ?? [:]
    }

    func testEventsEncodeAsTheDaemonsSchema() {
        let click = encoded(.mouse(.down, x: 10.5, y: 20, button: .right, clickCount: 5, modifiers: [.shift, .command], seq: 9))
        XCTAssertEqual(click["type"] as? String, "mouse")
        XCTAssertEqual(click["action"] as? String, "down")
        XCTAssertEqual(click["x"] as? Double, 10.5)
        XCTAssertEqual(click["button"] as? String, "right")
        XCTAssertEqual(click["clickCount"] as? Int, 3, "at most a triple click")
        XCTAssertEqual(click["modifiers"] as? [String], ["Meta", "Shift"])
        XCTAssertEqual(click["seq"] as? Int, 9)
        let wheel = encoded(.wheel(x: 1, y: 2, deltaX: 0, deltaY: -40))
        XCTAssertEqual(wheel["type"] as? String, "wheel")
        XCTAssertEqual(wheel["deltaY"] as? Double, -40)
        XCTAssertNil(wheel["seq"])
        XCTAssertEqual(encoded(.text("你好")) as NSDictionary, ["type": "text", "text": "你好"])
        XCTAssertEqual(encoded(.key("a", modifiers: [.control, .option])) as NSDictionary, ["type": "key", "key": "a", "modifiers": ["Alt", "Control"]])
    }

    func testLongTextIsCutIntoPiecesWithoutSplittingACharacter() {
        XCTAssertEqual(BrowserInputEvent.texts(""), [])
        XCTAssertEqual(BrowserInputEvent.texts("abc"), [.text("abc")])
        XCTAssertEqual(BrowserInputEvent.texts("abcdefg", limit: 3), [.text("abc"), .text("def"), .text("g")])
        // 👍🏽 is four UTF-16 units: kept whole.
        XCTAssertEqual(BrowserInputEvent.texts("ab👍🏽c", limit: 3), [.text("ab"), .text("👍🏽"), .text("c")])
    }

    func testTheQueueCoalescesMovesAndWheelsOnly() {
        var queue = BrowserInputQueue()
        queue.append(.mouse(.move, x: 1, y: 1))
        queue.append(.mouse(.move, x: 2, y: 2))
        XCTAssertEqual(queue.events, [.mouse(.move, x: 2, y: 2)])
        XCTAssertTrue(queue.onlyMotion)
        queue.append(.mouse(.down, x: 2, y: 2))
        queue.append(.mouse(.move, x: 3, y: 3))
        queue.append(.mouse(.up, x: 3, y: 3))
        XCTAssertEqual(queue.events.count, 4, "nothing moves past a press")
        XCTAssertFalse(queue.onlyMotion)
        queue.append(.wheel(x: 5, y: 5, deltaX: 0, deltaY: 10))
        queue.append(.wheel(x: 6, y: 6, deltaX: 1, deltaY: 15, seq: 4))
        XCTAssertEqual(queue.events.last, .wheel(x: 6, y: 6, deltaX: 1, deltaY: 25, seq: 4), "the wheel adds up at the newer place")
        queue.append(.wheel(x: 6, y: 6, deltaX: 0, deltaY: 5, modifiers: .control))
        XCTAssertEqual(queue.events.count, 6, "a pinch (⌃ wheel) is not added to a scroll")
        XCTAssertEqual(queue.take(limit: 2).count, 2)
        XCTAssertEqual(queue.events.count, 4)
        queue.removeAll()
        XCTAssertTrue(queue.isEmpty)
        XCTAssertFalse(queue.onlyMotion)
    }

    // MARK: keys

    private func key(_ code: UInt16, _ chars: String? = nil, _ mods: BrowserModifiers = []) -> BrowserKeyAction {
        BrowserKeys.action(keyCode: code, characters: chars, modifiers: mods)
    }

    func testNamedKeysGoAsKeysWithTheirModifiers() {
        XCTAssertEqual(key(36, "\r"), .key("Enter", []))
        XCTAssertEqual(key(76), .key("Enter", []), "the keypad's Enter")
        XCTAssertEqual(key(51), .key("Backspace", []))
        XCTAssertEqual(key(117), .key("Delete", []))
        XCTAssertEqual(key(53), .key("Escape", []))
        XCTAssertEqual(key(48, "\t", .shift), .key("Tab", .shift))
        XCTAssertEqual(key(123, nil, .option), .key("ArrowLeft", .option), "⌥← a word left")
        XCTAssertEqual(key(124, nil, .command), .key("ArrowRight", .command))
        XCTAssertEqual(key(126), .key("ArrowUp", []))
        XCTAssertEqual(key(116), .key("PageUp", []))
        XCTAssertEqual(key(119), .key("End", []))
    }

    func testShortcutsTheClipboardAndText() {
        XCTAssertEqual(key(0, "a", .command), .key("a", .command), "⌘A selects all in the page")
        XCTAssertEqual(key(6, "z", [.command, .shift]), .key("z", [.command, .shift]))
        XCTAssertEqual(key(9, "v", .command), .paste)
        XCTAssertEqual(key(9, "V", [.command, .shift]), .paste)
        XCTAssertEqual(key(8, "c", .command), .copy)
        XCTAssertEqual(key(7, "x", .command), .cut)
        XCTAssertEqual(key(12, "q", .command), .ignore, "the app's own")
        XCTAssertEqual(key(13, "w", .command), .ignore)
        XCTAssertEqual(key(24, "=", .command), .ignore, "⌘ with a non-letter")
        XCTAssertEqual(key(14, "e", .control), .key("e", .control), "⌃E: the end of the line")
        XCTAssertEqual(key(18, "1", .control), .ignore)
        XCTAssertEqual(key(0, "a"), .text, "typing goes through the text input system")
        XCTAssertEqual(key(14, "e", .option), .text, "⌥E composes an accent")
        XCTAssertEqual(key(49, " "), .text)
    }

    func testEditingCommandsAnInputMethodPassesOn() {
        XCTAssertEqual(BrowserKeys.key(forCommand: "insertNewline:"), .key("Enter"))
        XCTAssertEqual(BrowserKeys.key(forCommand: "deleteBackward:"), .key("Backspace"))
        XCTAssertEqual(BrowserKeys.key(forCommand: "insertBacktab:"), .key("Tab", modifiers: .shift))
        XCTAssertNil(BrowserKeys.key(forCommand: "noop:"))
    }

    // MARK: what the page writes

    func testTheAddressBarsText() {
        XCTAssertEqual(BrowserAddress.display("https://github.com/acme/app/pull/128"), "github.com/acme/app/pull/128")
        XCTAssertEqual(BrowserAddress.display("https://github.com/"), "github.com")
        XCTAssertEqual(BrowserAddress.display("https://a.com/?q=%E4%BD%A0"), "a.com/?q=你")
        XCTAssertEqual(BrowserAddress.display("http://example.com/x"), "http://example.com/x", "http keeps its scheme: no lock")
        XCTAssertEqual(BrowserAddress.display("http://localhost:5173/"), "localhost:5173")
        XCTAssertEqual(BrowserAddress.display("http://127.0.0.1:3000/app"), "localhost:3000/app")
        XCTAssertEqual(BrowserAddress.display("file:///Users/me/%E6%96%87%E6%A1%A3/mesh.html"), "file:///Users/me/文档/mesh.html")
        XCTAssertEqual(BrowserAddress.display("about:blank"), "")
        XCTAssertEqual(BrowserAddress.editing("file:///Users/me/%E6%96%87.html"), "file:///Users/me/文.html")
        XCTAssertEqual(BrowserAddress.editing("about:blank"), "")
        XCTAssertEqual(BrowserAddress.editing("https://a.com/x?y=1"), "https://a.com/x?y=1")
        XCTAssertTrue(BrowserAddress.isSecure("https://a.com"))
        XCTAssertFalse(BrowserAddress.isSecure("http://localhost:5173"))
    }

    func testRecentsKeepWhereAPageIsNotItsTokens() {
        XCTAssertEqual(BrowserRecents.entry(for: "https://user:pw@github.com/acme?token=abc#top"), "https://github.com/acme")
        XCTAssertEqual(BrowserRecents.entry(for: "http://localhost:5173/"), "http://localhost:5173/")
        XCTAssertEqual(BrowserRecents.entry(for: "file:///Users/me/x.html"), "file:///Users/me/x.html")
        XCTAssertNil(BrowserRecents.entry(for: "about:blank"))
        XCTAssertNil(BrowserRecents.entry(for: "chrome://settings"))
        var list: [String] = []
        for n in 0..<10 { list = BrowserRecents.adding("https://s\(n).com/", to: list) }
        XCTAssertEqual(list.count, BrowserRecents.limit)
        XCTAssertEqual(list.first, "https://s9.com/")
        XCTAssertEqual(BrowserRecents.adding("https://s5.com/", to: list).prefix(2), ["https://s5.com/", "https://s9.com/"], "once, in front")
    }

    func testRowsTitlesAndLabels() {
        let codex = BrowserOwner(kind: .terminal, id: "k", label: "codex · AgentSwitch")
        XCTAssertEqual(BrowserTabText.title(BrowserTab(id: "a", title: "  PR  ")), "PR")
        XCTAssertEqual(BrowserTabText.title(BrowserTab(id: "a", site: "localhost:5173")), "localhost:5173")
        XCTAssertEqual(BrowserTabText.title(BrowserTab(id: "a", title: "about:blank", kind: .blank)), "New Tab")
        XCTAssertEqual(BrowserTabText.place(BrowserTab(id: "a", kind: .blank)), "Blank")
        XCTAssertEqual(BrowserTabText.place(BrowserTab(id: "a", site: "~/x.html", kind: .file)), "~/x.html")
        XCTAssertNil(BrowserTabText.waiting(BrowserTab(id: "a", status: .busy)))
        XCTAssertEqual(BrowserTabText.waiting(BrowserTab(id: "a", status: .waiting)), "Waiting")
        XCTAssertEqual(BrowserTabText.waiting(BrowserTab(id: "a", status: .waiting, action: BrowserAction(tool: "ask", description: "等你：短信验证码"))),
                       "等你：短信验证码")
        XCTAssertEqual(BrowserTabText.group(codex), "codex · AgentSwitch")
        XCTAssertEqual(BrowserTabText.group(.you), "You")
        XCTAssertEqual(BrowserTabText.actionLabel(BrowserAction(tool: "browser_click", description: #"click "Merge""#), owner: codex),
                       #"codex · click "Merge""#)
        XCTAssertEqual(BrowserTabText.actionLabel(BrowserAction(tool: "browser_click", description: ""), owner: codex), "codex · browser_click")
        XCTAssertEqual(BrowserTabText.holder(BrowserTab(id: "a", heldBy: "mac-main"), screen: "mac-main"), .thisMac)
        XCTAssertEqual(BrowserTabText.holder(BrowserTab(id: "a", heldBy: "phone-1"), screen: "mac-main"), .elsewhere("phone-1"))
        XCTAssertNil(BrowserTabText.holder(BrowserTab(id: "a"), screen: "mac-main"))
    }
}
