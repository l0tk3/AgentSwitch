import XCTest
@testable import AgentSwitchMacCore

/// Chat Room as the Mac reads it (docs/chatroom-v0.md; the service's `api/rooms.ts`): the shapes, a state's word and
/// tone, a receipt's line, the rows of a timeline, the `@names` of a text, and the calls.
final class RoomsTests: XCTestCase {
    private let roomJSON = """
    {"room":{"id":"ab12cd34ef","name":"登录","topic":"先定接口","paused":false,"createdAt":1000,"createdBy":"you","lastSeq":4,"readSeq":2},
     "seats":[
      {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1000,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
      {"handle":"daemon","kind":"session","terminal":"t1","face":{"rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":13},"joinedAt":1001.5,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"busy",
       "card":{"agent":"claude-code","name":"daemon","cwd":"/w/daemon","model":"fable","profile":"Work","color":"mint","mode":"default","node":null}},
      {"handle":"gate","kind":"session","terminal":"t2","face":{"rows":["#####"],"color":2},"joinedAt":1002,"addedBy":"daemon","canAdd":false,"byAgent":true,"left":null,"state":"reconnecting","card":null},
      {"handle":"web","kind":"session","terminal":"t3","face":null,"joinedAt":1003,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"signed_out","card":null},
      {"handle":"old","kind":"session","terminal":"t4","face":null,"joinedAt":1004,"addedBy":"you","canAdd":false,"byAgent":false,"left":2000,"state":"some_new_state","card":null}],
     "messages":[
      {"seq":1,"from":"you","to":["daemon"],"text":"@daemon 接口改完了吗","at":86400000},
      {"seq":2,"from":"daemon","to":["gate","web"],"text":"@gate @web 改完了","at":86460000},
      {"seq":3,"from":"daemon","to":[],"text":"测试也补了","at":86470000},
      {"seq":4,"from":"gate","to":["you"],"replyTo":2,"text":"@you 收到","at":172900000}],
     "receipts":{"2":{"web":"ended","gate":"queued"},"1":{"daemon":"delivered"},"9":{"x":"what"}}}
    """

    private func room() throws -> Room { try JSONDecoder().decode(Room.self, from: Data(roomJSON.utf8)) }

    func testARoomIsReadAsTheServiceWritesIt() throws {
        let room = try room()
        XCTAssertEqual(room.room.name, "登录")
        XCTAssertEqual(room.seats.map(\.handle), ["you", "daemon", "gate", "web", "old"])
        XCTAssertTrue(room.seats[0].isUser)
        XCTAssertNil(room.seats[0].state)
        XCTAssertEqual(room.sessions.map(\.handle), ["daemon", "gate", "web"], "the user and a seat that left are not sessions here")
        let daemon = try XCTUnwrap(room.seat("daemon"))
        XCTAssertEqual(daemon.state, .busy)
        XCTAssertEqual(daemon.joinedAt, 1002, "a time with a fraction is a whole number")
        XCTAssertEqual(daemon.card?.profileColor, .mint)
        XCTAssertEqual(daemon.face?.colorIndex, 3)
        XCTAssertEqual(daemon.face?.cells.count, 16)
        XCTAssertEqual(room.seat("gate")?.face?.cells.count, 0, "a face that is not five by five draws nothing")
        XCTAssertTrue(room.seat("gate")?.byAgent == true)
        XCTAssertEqual(room.seat("web")?.state, .signedOut)
        XCTAssertEqual(room.seat("old")?.state, .error, "a state this app does not know")
        XCTAssertEqual(room.messages[3].replyTo, 2)
        XCTAssertEqual(RoomFace.dark.count, 10)
        XCTAssertEqual(RoomFace.light.count, 10)
    }

    func testTheListIsRead() throws {
        let list = try JSONDecoder().decode([RoomSummary].self, from: Data("""
        [{"id":"a","name":"登录","topic":"先定接口","paused":true,"createdAt":1,"members":3,"faces":[],"last":{"seq":1,"from":"you","text":"@daemon 好\\n第二行","at":5},"unread":2,"forYou":true},
         {"id":"b","name":"空","topic":"还没说话","paused":false,"createdAt":1,"members":1,"faces":[],"last":null,"unread":0,"forYou":false}]
        """.utf8))
        XCTAssertEqual(list[0].lastLine, "You: @daemon 好")
        XCTAssertEqual(list[1].lastLine, "还没说话")
        XCTAssertTrue(list[0].forYou && list[0].paused)
    }

    func testAStateHasItsWordToneAndSentence() {
        XCTAssertEqual(SeatState.allCases.map(\.word), ["Busy", "Waiting", "Idle", "Exited", "Reconnecting", "Limited", "Signed Out", "Blocked", "Error", "Offline"])
        XCTAssertEqual(SeatState.allCases.map(\.rawValue), ["busy", "waiting", "idle", "exited", "reconnecting", "limited", "signed_out", "blocked", "error", "offline"])
        // The classic look's words for the four everyday states; the rest are the same in both.
        XCTAssertEqual(SeatState.allCases.map { ClassicWords.word($0.word, in: .classic) },
                       ["Working", "Needs You", "Ready", "Ended", "Reconnecting", "Limited", "Signed Out", "Blocked", "Error", "Offline"])
        // Amber is what needs the user's hands, red what went wrong; what mends itself has no colour.
        XCTAssertEqual(SeatState.allCases.filter { $0.tone == .needsYou }, [.waiting, .signedOut])
        XCTAssertEqual(SeatState.allCases.filter { $0.tone == .failed }, [.blocked, .error])
        XCTAssertEqual(SeatState.allCases.filter { $0.tone == .held }, [.limited, .offline])
        XCTAssertEqual(SeatState.reconnecting.tone, .retrying)
        XCTAssertEqual(SeatState.allCases.filter { $0.says == nil }, [.busy, .waiting, .idle, .exited])
    }

    func testReceiptsSayWhereAMessageIsAndWhy() throws {
        let room = try room()
        let open = room.receipts(of: 2)
        XCTAssertEqual(open.map(\.handle), ["gate", "web"], "in the seats' order; one the app does not know is left out")
        XCTAssertTrue(room.receipts(of: 9).isEmpty)
        XCTAssertTrue(room.receipts(of: 3).isEmpty)
        // One that waits for a seat that must mend says the seat's state; one that can not be given says why.
        XCTAssertEqual(RoomText.receipt(.queued, to: room.seat("gate"), handle: "gate", classic: false), "… gate · Reconnecting")
        XCTAssertEqual(RoomText.receipt(.ended, to: room.seat("web"), handle: "web", classic: false), "× web · Signed Out")
        XCTAssertEqual(RoomText.receipt(.delivered, to: room.seat("daemon"), handle: "daemon", classic: false), "✓ daemon · Delivered")
        XCTAssertEqual(RoomText.receipt(.queued, to: room.seat("daemon"), handle: "daemon", classic: true), "… daemon · Queued")
        XCTAssertEqual(RoomText.receipt(.ended, to: nil, handle: "gone", classic: false), "× gone · Ended")
        XCTAssertEqual(RoomText.receipt(.sent, to: nil, handle: "you", classic: false), "· You · Sent")
        XCTAssertTrue(RoomText.failed(.ended))
        XCTAssertFalse(RoomText.failed(.queued))
    }

    func testRowsRunTogetherAndTheDayStandsBetweenDays() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let rows = RoomRow.rows(try room(), now: Date(timeIntervalSince1970: 172_900), calendar: calendar)
        XCTAssertEqual(rows.map(\.continues), [false, false, true, false], "the same seat soon after runs on; a reply and another day do not")
        XCTAssertEqual(rows.map(\.day), ["Yesterday", nil, nil, "Today"])
        XCTAssertEqual(rows.map(\.forYou), [false, false, false, true], "for the user and after what the user has seen")
    }

    func testATextIsCutIntoItsPieces() {
        let handles: Set<String> = ["daemon", "ios-app", "you"]
        XCTAssertEqual(RoomText.pieces("@daemon 看 `/login`，@nobody 和 a@daemon.com，@ALL @Ios-App", handles: handles),
                       [.mention("daemon"), .plain(" 看 "), .code("/login"), .plain("，@nobody 和 a@daemon.com，"), .mention("all"), .plain(" "), .mention("ios-app")])
        XCTAssertEqual(RoomText.pieces("a ` b", handles: handles), [.plain("a ` b")])
        XCTAssertEqual(RoomText.quote("@daemon 接口 `/login`\n改完了", handles: handles), "接口 /login 改完了")
    }

    func testNamesAreOfferedForWhatIsTypedAfterAt() throws {
        let room = try room()
        XCTAssertEqual(RoomText.mentionQuery("看一下 @da"), "da")
        XCTAssertEqual(RoomText.mentionQuery("@"), "")
        XCTAssertNil(RoomText.mentionQuery("a@b"))
        XCTAssertNil(RoomText.mentionQuery("@daemon 好"))
        XCTAssertNil(RoomText.mentionQuery("没有"))
        XCTAssertEqual(RoomText.offered("", in: room), ["daemon", "gate", "web", "all"])
        XCTAssertEqual(RoomText.offered("g", in: room), ["gate"])
        XCTAssertEqual(RoomText.offered("a", in: room), ["all"])
        XCTAssertEqual(RoomText.completing("看一下 @da", with: "daemon"), "看一下 @daemon ")
    }

    func testTheCallsAreTheServicesRoutes() async throws {
        let head = #"{"id":"r1","name":"n","topic":"","paused":false,"lastSeq":0,"readSeq":0}"#
        let transport = HeaderTransport { request in
            switch (request.httpMethod ?? "", request.url?.path ?? "") {
            case ("GET", "/rooms"):
                return request.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"" ? (304, "", [:]) : (200, #"{"rooms":[]}"#, ["ETag": "\"v1\""])
            case ("GET", "/rooms/r1"): return (200, #"{"room":\#(head),"seats":[],"messages":[],"receipts":{}}"#, ["ETag": "\"r\""])
            case ("POST", "/rooms"): return (201, #"{"room":\#(head),"seats":[],"messages":[],"receipts":{},"problems":["这个会话已经结束，恢复之后再拉进来"]}"#, [:])
            default: return (200, #"{"ok":true}"#, [:])
            }
        }
        let client = DaemonClient(port: 4811, transport: transport, tokenFile: TestSupport.tempDir().appendingPathComponent("none"))
        let first = try await client.rooms()
        XCTAssertEqual(first?.version, "\"v1\"")
        let again = try await client.rooms(version: first?.version)
        XCTAssertNil(again, "unchanged: nothing is sent")
        let room = try await client.room("r1")
        XCTAssertEqual(room?.value.room.id, "r1")
        let made = try await client.makeRoom(name: "n", topic: "t", terminals: ["t1"])
        XCTAssertEqual(made.problems.count, 1)
        try await client.updateRoom("r1", paused: true)
        try await client.seat(terminal: "t1", in: "r1")
        try await client.setCanAdd(true, seat: "daemon", in: "r1")
        try await client.unseat("daemon", in: "r1")
        try await client.say("@daemon hi", replyTo: 3, in: "r1")
        try await client.markRead(4, in: "r1")
        try await client.deleteRoom("r1")
        let sent = transport.requests.dropFirst(3).map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }
        XCTAssertEqual(sent, ["POST /rooms", "PATCH /rooms/r1", "POST /rooms/r1/seats", "PATCH /rooms/r1/seats/daemon", "DELETE /rooms/r1/seats/daemon",
                              "POST /rooms/r1/messages", "POST /rooms/r1/read", "DELETE /rooms/r1"])
        func body(_ index: Int) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(transport.requests[index].httpBody)) as? NSDictionary) }
        XCTAssertEqual(try body(3), ["name": "n", "topic": "t", "terminals": ["t1"]])
        XCTAssertEqual(try body(4), ["paused": true])
        XCTAssertEqual(try body(5), ["terminal": "t1"])
        XCTAssertEqual(try body(6), ["canAdd": true])
        XCTAssertEqual(try body(8), ["text": "@daemon hi", "replyTo": 3])
        XCTAssertEqual(try body(9), ["seq": 4])
    }

    func testTheRailHasItsPictureInBothLooks() {
        XCTAssertTrue(PixelArt.railRooms.allSatisfy { $0.count == 15 } && PixelArt.railRooms.count <= 15)
        XCTAssertTrue(PixelArt.toolbarPeople.allSatisfy { $0.count == 13 })
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.railRooms), .rooms)
        XCTAssertTrue(ShadedSprite.rooms.rows.allSatisfy { $0.count == 16 } && ShadedSprite.rooms.height <= 16)
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.railRooms), "bubble.left")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarPeople), "person.2")
        XCTAssertEqual(MainShortcut.action(for: MainShortcut.Press(key: "m", keyCode: 46, command: true, control: false, option: false, shift: true), on: .terminals, canGoBack: false), .page(.rooms))
    }

    // MARK: rounds, the Kit, notes, files (docs/chatroom-v0.md §7, §6, §9, §3)

    func testRoundsTheKitNotesAndFilesAreReadAndAnOlderServiceReadsAsWithout() throws {
        let json = """
        {"room":{"id":"ab12cd34ef","name":"r","topic":"","paused":false,"lastSeq":2,"readSeq":2,"rounds":7,"roundsLimit":6},
         "seats":[
          {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null,"kit":null},
          {"handle":"old","kind":"session","terminal":"t1","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"idle","card":null,"kit":false},
          {"handle":"new","kind":"session","terminal":"t2","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"idle","card":null,"kit":true},
          {"handle":"gone","kind":"session","terminal":"t3","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"exited","card":null,"kit":false}],
         "messages":[{"seq":1,"from":"old","to":["new"],"text":"@new 看这个","at":1000,"files":["/w/api.md","/w/a b.txt"]},{"seq":2,"from":"new","to":[],"text":"好","at":2000}],
         "receipts":{},
         "notes":{"text":"接口：expiresAt（毫秒）","at":1500.4,"by":"old"}}
        """
        let room = try JSONDecoder().decode(Room.self, from: Data(json.utf8))
        XCTAssertEqual(room.room.rounds, 7)
        XCTAssertEqual(room.room.roundsLimit, 6)
        XCTAssertTrue(Room.roundsSays(7).contains("7"))
        XCTAssertEqual(room.seats.map(\.needsResume), [false, true, false, false], "the user, one with the Kit and one that has ended need no resume")
        XCTAssertEqual(room.messages[0].files, ["/w/api.md", "/w/a b.txt"])
        XCTAssertEqual(room.messages[1].files, [])
        XCTAssertEqual(room.notes, RoomNotes(text: "接口：expiresAt（毫秒）", at: 1500, by: "old"))
        XCTAssertEqual(room.notes?.who, "@old")
        XCTAssertEqual(RoomNotes(text: "x", at: 0, by: "you").who, "You")

        // A service from before these: no rounds, no notes, no files, and a seat that does not say needs nothing.
        let older = try self.room()
        XCTAssertNil(older.room.rounds)
        XCTAssertNil(older.notes)
        XCTAssertNil(older.seat("daemon")?.kit)
        XCTAssertFalse(older.seat("daemon")?.needsResume ?? true)

        let list = try JSONDecoder().decode([RoomSummary].self, from: Data("""
        [{"id":"a","name":"A","topic":"t","paused":false,"members":2,"unread":0,"forYou":false,"rounds":6,"last":null},
         {"id":"b","name":"B","topic":"t","paused":false,"members":2,"unread":0,"forYou":false,"rounds":null,"last":null},
         {"id":"c","name":"C","topic":"t","paused":false,"members":2,"unread":0,"forYou":false,"last":null}]
        """.utf8))
        XCTAssertEqual(list.map(\.rounds), [6, nil, nil])
    }

    func testWhatTheUserSaysCarriesFilesOnlyWhenThereAreSome() {
        let plain = DaemonClient.sayBody("hi", replyTo: nil, files: [])
        XCTAssertEqual(Set(plain.keys), ["text"], "the service refuses a body with anything it does not know")
        let full = DaemonClient.sayBody("hi", replyTo: 3, files: ["/w/a.md"])
        XCTAssertEqual(full["replyTo"] as? Int, 3)
        XCTAssertEqual(full["files"] as? [String], ["/w/a.md"])
    }

    func testTheRoomsWorkIsReadAndAnOlderServiceHasNone() throws {
        let room = try JSONDecoder().decode(Room.self, from: Data("""
        {"room":{"id":"r","name":"R","topic":"","paused":false,"lastSeq":0,"readSeq":0},"seats":[],"messages":[],
         "folder":"/h/room-files/r",
         "tasks":[{"n":1,"title":"a","state":"done","owner":"api","by":"you","updatedAt":10.0,"note":"see a.md"},
                  {"n":2,"title":"b","state":"doing","owner":"ui","by":"api","updatedAt":20,"after":[1]},
                  {"n":3,"title":"c","state":"todo","by":"you","updatedAt":30,"after":[1,2]},
                  {"n":4,"title":"d","state":"done","by":"you","updatedAt":40},
                  {"n":5,"title":"e","state":"later","by":"you","updatedAt":50}],
         "claims":[{"handle":"ui","paths":["/w/src/form.ts","/w/src/app.ts","/w/x"],"why":"T2","at":1,"until":1800000}]}
        """.utf8))
        XCTAssertEqual(room.folder, "/h/room-files/r")
        XCTAssertEqual(room.tasks(.doing).map(\.n), [2])
        XCTAssertEqual(room.tasks(.todo).map(\.n), [3, 5], "a state this app does not know is to do")
        XCTAssertEqual(room.tasks(.done).map(\.n), [4, 1], "the last finished first")
        XCTAssertEqual(room.waits(room.tasks[2]), [2], "T1 is done; T2 is not")
        XCTAssertEqual(room.tasks[0].name, "T1")
        XCTAssertEqual(room.tasks[0].note, "see a.md")
        XCTAssertEqual(room.claim(of: "ui")?.names, "form.ts +2")
        XCTAssertNil(room.claim(of: "api"))

        let older = try self.room()
        XCTAssertEqual(older.tasks, [])
        XCTAssertEqual(older.claims, [])
        XCTAssertNil(older.folder)

        let files = try JSONDecoder().decode(RoomFiles.self, from: Data("""
        {"folder":"/h/room-files/r","files":[{"path":"api/interface.md","size":2048,"modifiedAt":1700000000000.4}],"more":true}
        """.utf8))
        XCTAssertEqual(files.files.map(\.path), ["api/interface.md"])
        XCTAssertEqual(files.files[0].size, 2048)
        XCTAssertTrue(files.more)
    }

    func testATaskTheUserAddsCarriesOnlyWhatWasGiven() {
        XCTAssertEqual(Set(DaemonClient.taskBody(title: "a", detail: "  ", owner: nil).keys), ["title"])
        let full = DaemonClient.taskBody(title: "a", detail: "how", owner: "ui")
        XCTAssertEqual(full["detail"] as? String, "how")
        XCTAssertEqual(full["owner"] as? String, "ui")
    }
}
