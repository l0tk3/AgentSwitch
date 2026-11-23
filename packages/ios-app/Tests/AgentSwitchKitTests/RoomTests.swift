import XCTest
@testable import AgentSwitchKit

/// Chat Room on the phone (docs/chatroom-v0.md): the Mac's answers read as given, a seat's state in the room's words,
/// what a message still has to reach, the timeline's rows, the `@name` being typed, and the calls as the service
/// takes them.
final class RoomTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    /// `GET /rooms/:id` as the service answers (api/rooms.ts `whole`).
    private static let room = #"""
    {"room":{"id":"a1b2c3d4e5","name":"登录","topic":"先定接口","paused":false,"createdAt":1763800000000,"createdBy":"you","lastSeq":4,"readSeq":2},
     "seats":[
       {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1763800000000,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
       {"handle":"daemon","kind":"session","terminal":"t1","face":{"rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":3},"joinedAt":1763800000001,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"idle",
        "card":{"agent":"claude-code","name":"daemon","cwd":"/w/daemon","model":"fable","profile":"Work","color":"mint","mode":"default","node":null}},
       {"handle":"mac-app","kind":"session","terminal":"t2","face":{"rows":["##.##","#...#","..#..","#...#","##.##"],"color":12},"joinedAt":1763800000002,"addedBy":"daemon","canAdd":false,"byAgent":true,"left":null,"state":"reconnecting",
        "card":{"agent":"codex","name":"Mac App","cwd":"/w/Mac App","model":null,"profile":null,"mode":null,"node":null}},
       {"handle":"web","kind":"session","terminal":"t3","face":null,"joinedAt":1763800000003,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"signed_out","card":null},
       {"handle":"old","kind":"session","terminal":"t4","face":null,"joinedAt":1763800000004,"addedBy":"you","canAdd":false,"byAgent":false,"left":1763800009000,"state":"exited","card":null},
       {"handle":"new","kind":"session","terminal":"t5","face":null,"joinedAt":1763800000005,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"dreaming","card":null}],
     "messages":[
       {"seq":1,"from":"you","to":["daemon"],"text":"@daemon 接口改完了吗","at":1763800100000},
       {"seq":2,"from":"daemon","to":["you","mac-app"],"replyTo":1,"text":"改完了 @you，`/login` 多了 expiresAt。@mac-app 跟一下","at":1763800160000},
       {"seq":3,"from":"daemon","to":[],"text":"只是记一笔","at":1763800170000},
       {"seq":4,"from":"you","to":["mac-app","web"],"text":"@mac-app @web 先停","at":1763800900000}],
     "receipts":{"2":{"mac-app":"queued"},"4":{"web":"ended","mac-app":"sent","x":"flying"},"oops":{"a":"sent"}}}
    """#

    private static let list = #"""
    {"rooms":[
      {"id":"a1b2c3d4e5","name":"登录","topic":"先定接口","paused":false,"createdAt":1,"members":3,
       "faces":[{"handle":"daemon","face":{"rows":["#.#.#",".###.","##.##",".###.","#.#.#"],"color":3}}],
       "last":{"seq":4,"from":"daemon","text":"改完了\n见附注","at":1763800900000},"unread":2,"forYou":true},
      {"id":"ffffffffff","name":"空的","topic":"","paused":true,"createdAt":2,"members":1,"faces":[],"last":null,"unread":0,"forYou":false}]}
    """#

    func testARoomIsReadAsTheServiceGivesIt() throws {
        let room = try JSONDecoder().decode(RoomDetail.self, from: Data(Self.room.utf8))
        XCTAssertEqual(room.room.name, "登录")
        XCTAssertEqual([room.room.lastSeq, room.room.readSeq], [4, 2])
        XCTAssertEqual(room.seats.map(\.handle), ["you", "daemon", "mac-app", "web", "old", "new"])
        XCTAssertEqual(room.sessions.map(\.handle), ["daemon", "mac-app", "web", "new"])   // not the user, not one that left
        XCTAssertTrue(try XCTUnwrap(room.seat("you")).isUser)
        let daemon = try XCTUnwrap(room.seat("daemon"))
        XCTAssertEqual(daemon.state, .idle)
        XCTAssertEqual(daemon.card, SeatCard(agent: "claude-code", name: "daemon", cwd: "/w/daemon", model: "fable", profile: "Work", color: .mint, mode: "default"))
        XCTAssertEqual(daemon.face?.cells.count, 16)
        XCTAssertTrue([daemon.canAdd, !daemon.byAgent, daemon.here].allSatisfy { $0 })
        let mac = try XCTUnwrap(room.seat("mac-app"))
        XCTAssertEqual([mac.byAgent, mac.canAdd], [true, false])
        XCTAssertEqual(mac.addedBy, "daemon")
        XCTAssertNil(mac.card?.profile)
        // A colour out of the ten still names one of them.
        XCTAssertEqual(mac.face?.rgb(dark: true), RoomFace.colorsDark[2])
        XCTAssertEqual(room.seat("web")?.state, .signedOut)
        XCTAssertEqual(room.seat("old")?.here, false)
        // A state this app does not know is no state, not a failure to read the room.
        XCTAssertNil(room.seat("new")?.state)
        XCTAssertEqual(room.messages.map(\.seq), [1, 2, 3, 4])
        XCTAssertEqual(room.message(2)?.replyTo, 1)
        XCTAssertEqual(room.messages[0].date, Date(timeIntervalSince1970: 1_763_800_100))
        // Receipts by number; what is not a number or not a receipt is left out.
        XCTAssertEqual(room.receipts, [2: ["mac-app": .queued], 4: ["web": .ended, "mac-app": .sent]])
    }

    func testTheListIsReadAndSaysItsLastLine() throws {
        let list = try JSONDecoder().decode(RoomList.self, from: Data(Self.list.utf8))
        XCTAssertEqual(list.rooms.map(\.id), ["a1b2c3d4e5", "ffffffffff"])
        XCTAssertEqual(list.unread, 2)
        XCTAssertEqual(list.rooms[0].lastLine, "daemon: 改完了 见附注")
        XCTAssertTrue(list.rooms[0].forYou)
        XCTAssertEqual(list.rooms[0].faces.first?.handle, "daemon")
        XCTAssertEqual(list.rooms[1].lastLine, "还没有消息")
        XCTAssertTrue(list.rooms[1].paused)
        XCTAssertEqual(RoomSummary(id: "x", name: "n", topic: "先定接口").lastLine, "先定接口")
        XCTAssertEqual(RoomSummary(id: "x", name: "n", last: .init(seq: 1, from: "you", text: "hi", at: 0)).lastLine, "You: hi")
    }

    func testAStateHasItsWordInEachLookItsMarkAndWhatItMeansForAMessage() {
        XCTAssertEqual(SeatState.allCases.map(\.word), ["Busy", "Waiting", "Idle", "Exited", "Reconnecting", "Limited", "Signed Out", "Blocked", "Error", "Offline"])
        XCTAssertEqual([SeatState.busy, .waiting, .idle, .exited, .signedOut].map { $0.word(in: .classic) }, ["Working", "Needs You", "Ready", "Ended", "Signed Out"])
        XCTAssertEqual(SeatState.busy.word(in: .pixel), "Busy")
        // Amber is what needs the user's hands, red what went wrong; what mends itself has no colour.
        XCTAssertEqual(SeatState.allCases.filter { $0.mark == .amber }, [.waiting, .signedOut])
        XCTAssertEqual(SeatState.allCases.filter { $0.mark == .red }, [.blocked, .error])
        XCTAssertEqual(SeatState.allCases.filter { $0.mark == .held }, [.limited, .offline])
        XCTAssertEqual(SeatState.allCases.filter { $0.mark == .spinner }, [.busy, .reconnecting])
        XCTAssertEqual(SeatState.allCases.filter { $0.says == nil }, [.busy, .waiting, .idle, .exited])
        XCTAssertEqual(SeatState(rawValue: "signed_out"), .signedOut)
    }

    func testAMessageSaysWhoItHasNotReachedAndWhy() throws {
        let room = try JSONDecoder().decode(RoomDetail.self, from: Data(Self.room.utf8))
        XCTAssertEqual(RoomReceiptLine.lines(room.messages[0], in: room), [])
        // Queued for a seat that is trying to reach its service again: its state says what it waits for.
        XCTAssertEqual(RoomReceiptLine.lines(room.messages[1], in: room), [RoomReceiptLine(handle: "mac-app", tick: "…", word: "Reconnecting", failed: false)])
        // In the seats' order; one that can not be given says why.
        XCTAssertEqual(RoomReceiptLine.lines(room.messages[3], in: room), [
            RoomReceiptLine(handle: "mac-app", tick: "·", word: "Sent", failed: false),
            RoomReceiptLine(handle: "web", tick: "×", word: "Signed Out", failed: true),
        ])
        XCTAssertEqual([RoomReceipt.sent, .queued, .delivered, .ended].map(\.word), ["Sent", "Queued", "Delivered", "Ended"])
    }

    func testTheTimelineRunsASpeakersMessagesTogether() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let day: Int64 = 86_400_000, base: Int64 = 1_763_800_000_000 / day * day + 10 * 3_600_000
        let messages = [
            RoomMessage(seq: 1, from: "daemon", text: "一", at: base),
            RoomMessage(seq: 2, from: "daemon", text: "二", at: base + 60_000),
            RoomMessage(seq: 3, from: "you", text: "三", at: base + 70_000),
            RoomMessage(seq: 4, from: "you", replyTo: 1, text: "四", at: base + 80_000),
            RoomMessage(seq: 5, from: "you", text: "五", at: base + 80_000 + 6 * 60_000),
            RoomMessage(seq: 6, from: "you", text: "六", at: base + day),
            RoomMessage(seq: 7, from: "you", replyTo: 99, text: "七", at: base + day + 1000),
        ]
        let rows = RoomRow.rows(messages, calendar: calendar)
        XCTAssertEqual(rows.map(\.continues), [false, true, false, false, false, false, false])
        XCTAssertEqual(rows.map(\.newDay), [true, false, false, false, false, true, false])
        XCTAssertEqual(rows[3].quoted?.seq, 1)
        XCTAssertNil(rows[6].quoted)   // the one it answers is not on the page
        XCTAssertEqual(RoomRow.quote("@daemon 看一下 `GET /clash`\n好吗"), "看一下 GET /clash 好吗")
    }

    func testATextIsCutIntoWordsCodeAndTheNamesOfSeats() {
        let handles: Set<String> = ["daemon", "ios-app", "you", "all"]
        XCTAssertEqual(RoomText.pieces("@daemon 看 `a@b` 和 @ios-app，@Daemon；@nobody a@you.com @types/node", handles: handles), [
            .mention("daemon"), .text(" 看 "), .code("a@b"), .text(" 和 "), .mention("ios-app"), .text("，"), .mention("daemon"), .text("；@nobody a@you.com @types/node"),
        ])
        XCTAssertEqual(RoomText.pieces("(@all) x`", handles: handles), [.text("("), .mention("all"), .text(") x`")])
        XCTAssertEqual(RoomText.pieces("", handles: handles), [])
        XCTAssertEqual(RoomText.handles(of: [RoomSeat(handle: "you", isUser: true), RoomSeat(handle: "web")]), ["you", "web", "all"])
    }

    func testTheNameBeingTypedIsOfferedAndMadeWhole() {
        XCTAssertEqual(RoomMention.query("看一下 @da"), "da")
        XCTAssertEqual(RoomMention.query("@"), "")
        XCTAssertEqual(RoomMention.query("@IOS-"), "ios-")
        XCTAssertNil(RoomMention.query("a@b"))
        XCTAssertNil(RoomMention.query("@daemon 好"))
        XCTAssertNil(RoomMention.query("没有"))
        let seats = [RoomSeat(handle: "you", isUser: true), RoomSeat(handle: "daemon"), RoomSeat(handle: "docs"), RoomSeat(handle: "dead", left: 5), RoomSeat(handle: "android")]
        XCTAssertEqual(RoomMention.offers("d", seats: seats), ["daemon", "docs"])
        XCTAssertEqual(RoomMention.offers("", seats: seats), ["daemon", "docs", "android", "all"])
        XCTAssertEqual(RoomMention.offers("a", seats: seats), ["android", "all"])
        XCTAssertEqual(RoomMention.complete("看一下 @da", with: "daemon"), "看一下 @daemon ")
        XCTAssertEqual(RoomMention.complete("已经写完", with: "daemon"), "已经写完")
    }

    func testTheCallsGoAsTheServiceTakesThem() async throws {
        let room = Data(Self.room.utf8), list = Data(Self.list.utf8)
        let transport = FakeTransport { req, _ in
            let path = req.url?.path ?? "", method = req.httpMethod ?? ""
            func tagged(_ data: Data, _ tag: String) -> (Data, HTTPURLResponse) {
                if req.value(forHTTPHeaderField: "If-None-Match") == tag { return (Data(), httpResponse(req.url, status: 304)) }
                return (data, HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "ETag": tag])!)
            }
            switch (method, path) {
            case ("GET", "/rooms"): return tagged(list, "\"l1\"")
            case ("GET", "/rooms/a1b2c3d4e5"): return tagged(room, "\"r1\"")
            case ("POST", "/rooms"):
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: room) as? [String: Any])
                object["problems"] = ["这个会话已经结束，恢复之后再拉进来"]
                return (json(object), httpResponse(req.url, status: 201))
            case ("PATCH", "/rooms/a1b2c3d4e5"): return (Data(#"{"room":{"id":"a1b2c3d4e5","name":"登录","topic":"新的","paused":true,"createdAt":1,"members":3,"faces":[],"last":null,"unread":0,"forYou":false}}"#.utf8), httpResponse(req.url))
            case ("POST", "/rooms/a1b2c3d4e5/seats"), ("PATCH", "/rooms/a1b2c3d4e5/seats/daemon"):
                return (Data(#"{"seat":{"handle":"daemon","kind":"session","terminal":"t1","face":null,"joinedAt":1,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"busy","card":null}}"#.utf8), httpResponse(req.url, status: method == "POST" ? 201 : 200))
            case ("POST", "/rooms/a1b2c3d4e5/messages"):
                return (Data(#"{"message":{"seq":5,"from":"you","to":["daemon"],"replyTo":2,"text":"@daemon 好","at":9},"receipts":{"daemon":"sent"}}"#.utf8), httpResponse(req.url, status: 201))
            case ("POST", "/rooms/a1b2c3d4e5/read"): return (Data(#"{"readSeq":4}"#.utf8), httpResponse(req.url))
            case ("DELETE", "/rooms/gone"): return (Data(#"{"error":"没有这个房间"}"#.utf8), httpResponse(req.url, status: 404))
            default: return (Data(#"{"ok":true}"#.utf8), httpResponse(req.url))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        func body(_ n: Int) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(transport.requests[n].httpBody)) as? [String: Any]) }

        let rooms = try await api.rooms(etag: nil)
        XCTAssertEqual(rooms?.list.rooms.count, 2)
        XCTAssertEqual(rooms?.etag, "\"l1\"")
        let same = try await api.rooms(etag: "\"l1\"")
        XCTAssertNil(same)   // unchanged: nothing new
        let got = try await api.room("a1b2c3d4e5", etag: nil)
        XCTAssertEqual(got?.room.seats.count, 6)
        let unchanged = try await api.room("a1b2c3d4e5", etag: got?.etag)
        XCTAssertNil(unchanged)

        let made = try await api.createRoom(name: "登录", topic: "", terminals: ["t1", "t3"])
        XCTAssertEqual(made.problems.count, 1)
        XCTAssertEqual(try body(4)["terminals"] as? [String], ["t1", "t3"])
        XCTAssertNil(try body(4)["topic"])

        let updated = try await api.updateRoom("a1b2c3d4e5", paused: true)
        XCTAssertTrue(updated.paused)
        XCTAssertEqual(try body(5) as NSDictionary, ["paused": true])   // only what changes is sent: the body is strict

        let seat = try await api.seat("t1", in: "a1b2c3d4e5")
        XCTAssertEqual(seat.state, .busy)
        XCTAssertEqual(try body(6) as NSDictionary, ["terminal": "t1"])
        _ = try await api.setSeat("daemon", in: "a1b2c3d4e5", canAdd: true)
        XCTAssertEqual(try body(7) as NSDictionary, ["canAdd": true])
        try await api.unseat("mac-app", in: "a1b2c3d4e5")

        let said = try await api.say("@daemon 好", in: "a1b2c3d4e5", replyTo: 2)
        XCTAssertEqual(said.message.seq, 5)
        XCTAssertEqual(said.receipts, ["daemon": .sent])
        XCTAssertEqual(try body(9) as NSDictionary, ["text": "@daemon 好", "replyTo": 2])
        _ = try await api.say("没有引用", in: "a1b2c3d4e5")
        XCTAssertEqual(try body(10) as NSDictionary, ["text": "没有引用"])
        let seen = try await api.markRoomRead("a1b2c3d4e5", upTo: 9)
        XCTAssertEqual(seen, 4)
        try await api.deleteRoom("a1b2c3d4e5")

        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }, [
            "GET /rooms", "GET /rooms", "GET /rooms/a1b2c3d4e5", "GET /rooms/a1b2c3d4e5", "POST /rooms", "PATCH /rooms/a1b2c3d4e5",
            "POST /rooms/a1b2c3d4e5/seats", "PATCH /rooms/a1b2c3d4e5/seats/daemon", "DELETE /rooms/a1b2c3d4e5/seats/mac-app",
            "POST /rooms/a1b2c3d4e5/messages", "POST /rooms/a1b2c3d4e5/messages", "POST /rooms/a1b2c3d4e5/read", "DELETE /rooms/a1b2c3d4e5",
        ])
        // The service's own words come back as the error.
        do { try await api.deleteRoom("gone"); XCTFail("deleted a room that is not there") } catch let error as APIError {
            XCTAssertEqual(error.errorDescription, "没有这个房间")
        }
    }

    /// What the service gained after the first pages: the rounds notice, a seat's Kit, the pinned notes, a message's files.
    func testRoundsKitNotesAndFilesAreRead() throws {
        let json = #"""
        {"room":{"id":"a1b2c3d4e5","name":"r","topic":"","paused":false,"createdAt":1,"createdBy":"you","lastSeq":2,"readSeq":2,"rounds":7,"roundsLimit":6},
         "seats":[
           {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null,"kit":null},
           {"handle":"new","kind":"session","terminal":"t1","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"idle","card":null,"kit":true},
           {"handle":"old","kind":"session","terminal":"t2","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"busy","card":null,"kit":false},
           {"handle":"over","kind":"session","terminal":"t3","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"exited","card":null,"kit":false},
           {"handle":"went","kind":"session","terminal":"t4","face":null,"joinedAt":1,"addedBy":"you","canAdd":false,"byAgent":false,"left":5,"state":"idle","card":null,"kit":false}],
         "messages":[{"seq":1,"from":"new","to":["old"],"text":"@old 看这个","at":1,"files":["/w/docs/api.md","/w/a b/图.png","/"]},{"seq":2,"from":"old","to":[],"text":"好","at":2}],
         "receipts":{},"notes":{"text":"接口：/login 返回 expiresAt","at":1763800000000,"by":"new"}}
        """#
        let room = try JSONDecoder().decode(RoomDetail.self, from: Data(json.utf8))
        XCTAssertEqual(room.room.rounds, 7)
        XCTAssertEqual(room.room.roundsLimit, 6)
        XCTAssertTrue(RoomInfo.roundsSays(7).contains("7"))
        // Only a seat whose session goes on without the Kit needs the user: not the user, not one with it, not one
        // that is over or has left.
        XCTAssertEqual(room.seats.filter(\.needsResume).map(\.handle), ["old"])
        XCTAssertNil(room.seat("you")?.kit)
        XCTAssertEqual(room.notes, RoomNotes(text: "接口：/login 返回 expiresAt", at: 1_763_800_000_000, by: "new"))
        XCTAssertEqual(room.messages[0].files.map(RoomMessage.fileName), ["api.md", "图.png", "/"])
        XCTAssertEqual(room.messages[1].files, [])

        // An older Mac says none of it: no notice, no hint, no notes.
        let before = try JSONDecoder().decode(RoomDetail.self, from: Data(Self.room.utf8))
        XCTAssertNil(before.room.rounds)
        XCTAssertNil(before.notes)
        XCTAssertTrue(before.seats.allSatisfy { !$0.needsResume })

        let list = try JSONDecoder().decode(RoomList.self, from: Data(#"{"rooms":[{"id":"a","name":"a","members":2,"faces":[],"last":null,"unread":0,"forYou":false,"rounds":6},{"id":"b","name":"b","members":2,"faces":[],"last":null,"unread":3,"forYou":false,"rounds":null}]}"#.utf8))
        XCTAssertEqual(list.rooms.map(\.rounds), [6, nil])
        XCTAssertTrue(list.needsYou)   // rounds the user has not seen
        XCTAssertFalse(RoomList(rooms: [list.rooms[1]]).needsYou)   // unread, but none of it for the user
        XCTAssertTrue(try JSONDecoder().decode(RoomList.self, from: Data(Self.list.utf8)).needsYou)   // a message names the user
    }

    func testRoundsAndNotesCallsAreAsTheServiceTakesThem() async throws {
        let transport = FakeTransport { req, _ in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/notes") {
                let empty = (req.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["text"] as? String == ""
                return (Data((empty ? #"{"notes":null}"# : #"{"notes":{"text":"约定","at":5,"by":"you"}}"#).utf8), httpResponse(req.url, status: 200))
            }
            return (Data(#"{"ok":true}"#.utf8), httpResponse(req.url, status: 200))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        try await api.roundsSeen("a1b2c3d4e5")
        let notes = try await api.setRoomNotes("a1b2c3d4e5", text: "约定")
        XCTAssertEqual(notes, RoomNotes(text: "约定", at: 5, by: "you"))
        let none = try await api.setRoomNotes("a1b2c3d4e5", text: "")
        XCTAssertNil(none)
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }, ["POST /rooms/a1b2c3d4e5/rounds/ok", "PUT /rooms/a1b2c3d4e5/notes", "PUT /rooms/a1b2c3d4e5/notes"])
        let sent = try XCTUnwrap(transport.requests[1].httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(sent as NSDictionary, ["text": "约定"])
    }

    func testAMacWithoutChatRoomIsSaidSo() async {
        for status in [403, 404] {
            let transport = FakeTransport { req, _ in (Data(#"{"error":"not allowed"}"#.utf8), httpResponse(req.url, status: status)) }
            let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
            do { _ = try await api.rooms(etag: nil); XCTFail("read rooms from a Mac that has none") } catch { XCTAssertTrue(error is RoomsUnsupported) }
        }
    }

    /// The room's work (§9; the service's `roomWork.test.ts`): its task list, its shared folder, who is changing which files.
    func testTasksTheFolderAndClaimsAreRead() throws {
        let json = #"""
        {"room":{"id":"a1b2c3d4e5","name":"r","topic":"","paused":false,"createdAt":1,"createdBy":"you","lastSeq":0,"readSeq":0,"rounds":null,"roundsLimit":6},
         "seats":[{"handle":"you","kind":"user"},{"handle":"daemon","kind":"session","terminal":"t1","state":"busy"},{"handle":"web","kind":"session","terminal":"t2","state":"idle"}],
         "messages":[],"receipts":{},"notes":null,"folder":"/Users/me/.agentswitch/room-files/a1b2c3d4e5",
         "tasks":[
           {"n":1,"title":"定接口","state":"done","owner":"daemon","by":"you","createdAt":10,"updatedAt":40,"note":"见置顶笔记"},
           {"n":2,"title":"卡片","detail":"局域网在前","state":"doing","owner":"web","by":"daemon","createdAt":20,"updatedAt":30,"after":[1]},
           {"n":3,"title":"文档","state":"todo","by":"you","createdAt":21,"updatedAt":21,"after":[1,2,9]},
           {"n":5,"title":"发布","state":"sleeping","by":"you","createdAt":22,"updatedAt":22,"after":[4]},
           {"n":6,"title":"早先做完的","state":"done","by":"web","createdAt":5,"updatedAt":6,"after":[2]}],
         "claims":[
           {"handle":"daemon","paths":["packages/daemon/src/clash/phone.ts","docs/clash-v0.md","packages/daemon/tests/"],"why":"改接口","at":1763800000000,"until":1763801800000},
           {"handle":"web","paths":["README.md"],"at":1763800000000,"until":1763800060000}]}
        """#
        let room = try JSONDecoder().decode(RoomDetail.self, from: Data(json.utf8))
        XCTAssertEqual(room.folder, "/Users/me/.agentswitch/room-files/a1b2c3d4e5")
        XCTAssertEqual(room.tasks.map(\.n), [1, 2, 3, 5, 6])
        XCTAssertEqual(room.tasks[0], RoomTask(n: 1, title: "定接口", state: .done, owner: "daemon", by: "you", createdAt: 10, updatedAt: 40, note: "见置顶笔记"))
        XCTAssertEqual(room.tasks[1], RoomTask(n: 2, title: "卡片", detail: "局域网在前", state: .doing, owner: "web", by: "daemon", createdAt: 20, updatedAt: 30, after: [1]))
        XCTAssertEqual(room.tasks[1].name, "T2")
        XCTAssertNil(room.tasks[2].owner)
        // A state this app does not know is to do, not a failure to read the room.
        XCTAssertEqual(room.tasks[3].state, .todo)
        // The list's three parts: by number; what is done, the last finished first.
        XCTAssertEqual(room.tasks(.doing).map(\.n), [2])
        XCTAssertEqual(room.tasks(.todo).map(\.n), [3, 5])
        XCTAssertEqual(room.tasks(.done).map(\.n), [1, 6])
        XCTAssertEqual(room.openTasks, 3)
        XCTAssertEqual(RoomTaskState.allCases.map(\.word), ["To Do", "Doing", "Done"])
        // It waits for what comes first and is not done: not for one that is done, nor one no longer on the list.
        XCTAssertEqual(room.waits(room.tasks[1]), [])
        XCTAssertNil(room.waitsWord(room.tasks[1]))
        XCTAssertEqual(room.waits(room.tasks[2]), [2])
        XCTAssertEqual(room.waitsWord(room.tasks[2]), "waits for T2")
        XCTAssertNil(room.waitsWord(room.tasks[3]))
        XCTAssertNil(room.waitsWord(room.tasks[4]))   // done: it waits for nothing any more
        XCTAssertEqual(RoomDetail(room: room.room, seats: [], tasks: [RoomTask(n: 1, title: "a"), RoomTask(n: 2, title: "b", state: .doing), RoomTask(n: 3, title: "c", after: [1, 2])]).waitsWord(RoomTask(n: 3, title: "c", after: [1, 2])), "waits for T1, T2")

        // Who is changing what, by name, and until when; one past its time says nothing any more.
        let during = Date(timeIntervalSince1970: 1_763_800_030), later = Date(timeIntervalSince1970: 1_763_800_090)
        let claim = try XCTUnwrap(room.claim(of: "daemon", now: during))
        XCTAssertEqual(claim.why, "改接口")
        XCTAssertEqual(claim.names(), "phone.ts, clash-v0.md +1")
        XCTAssertEqual(claim.names(limit: 5), "phone.ts, clash-v0.md, tests")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(claim.untilWord(calendar: utc), "until 08:56")
        XCTAssertEqual(room.claim(of: "web", now: during)?.names(), "README.md")
        XCTAssertNil(room.claim(of: "web", now: later))
        XCTAssertNotNil(room.claim(of: "daemon", now: later))
        XCTAssertNil(room.claim(of: "you", now: during))

        // An older Mac says none of it: no tasks, no folder, nobody changing anything.
        let before = try JSONDecoder().decode(RoomDetail.self, from: Data(Self.room.utf8))
        XCTAssertEqual(before.tasks, [])
        XCTAssertEqual(before.folder, "")
        XCTAssertEqual(before.claims, [])
        XCTAssertEqual(before.openTasks, 0)

        // The list of rooms says how each one's tasks stand; an older Mac's rooms have none.
        let list = try JSONDecoder().decode(RoomList.self, from: Data(#"{"rooms":[{"id":"a","name":"a","members":2,"faces":[],"last":null,"unread":0,"forYou":false,"tasks":{"todo":2,"doing":1,"done":4}}]}"#.utf8))
        XCTAssertEqual(list.rooms[0].tasks, RoomTaskCounts(todo: 2, doing: 1, done: 4))
        XCTAssertEqual(list.rooms[0].tasks.open, 3)
        XCTAssertEqual(try JSONDecoder().decode(RoomList.self, from: Data(Self.list.utf8)).rooms.map(\.tasks), [RoomTaskCounts(), RoomTaskCounts()])

        // The shared folder's files as `GET /rooms/:id/files` gives them.
        let files = try JSONDecoder().decode(RoomFiles.self, from: Data(#"{"folder":"/h/room-files/a1","files":[{"path":"report.md","size":2150,"modifiedAt":1763800900000},{"path":"shots/主页.png","size":48000000,"modifiedAt":1763800000000.5}],"more":true}"#.utf8))
        XCTAssertEqual(files.folder, "/h/room-files/a1")
        XCTAssertEqual(files.files.map(\.path), ["report.md", "shots/主页.png"])
        XCTAssertEqual(files.files[0], RoomFile(path: "report.md", size: 2150, modifiedAt: 1_763_800_900_000))
        XCTAssertEqual(files.files[0].modified, Date(timeIntervalSince1970: 1_763_800_900))
        XCTAssertTrue(files.more)
        XCTAssertEqual(RoomFiles.whole(files.files[1].path, in: files.folder), "/h/room-files/a1/shots/主页.png")
        XCTAssertEqual(try JSONDecoder().decode(RoomFiles.self, from: Data(#"{"folder":"/f"}"#.utf8)), RoomFiles(folder: "/f"))
    }

    func testTaskAndFolderCallsAreAsTheServiceTakesThem() async throws {
        let transport = FakeTransport { req, _ in
            let path = req.url?.path ?? "", method = req.httpMethod ?? ""
            switch (method, path) {
            case ("POST", "/rooms/a1b2c3d4e5/tasks"):
                return (Data(#"{"task":{"n":4,"title":"写文档","detail":"接口一节","state":"todo","owner":"web","by":"you","createdAt":7,"updatedAt":7,"after":[1]}}"#.utf8), httpResponse(req.url, status: 201))
            case ("PATCH", "/rooms/a1b2c3d4e5/tasks/4"):
                return (Data(#"{"task":{"n":4,"title":"写文档","state":"done","by":"you","createdAt":7,"updatedAt":9}}"#.utf8), httpResponse(req.url, status: 200))
            case ("PATCH", "/rooms/a1b2c3d4e5/tasks/2"):
                return (Data(#"{"error":"T2 is being done by @web. Take another, or ask @web in the room."}"#.utf8), httpResponse(req.url, status: 409))
            case ("DELETE", "/rooms/a1b2c3d4e5/tasks/9"):
                return (Data(#"{"error":"There is no task T9 in this room."}"#.utf8), httpResponse(req.url, status: 404))
            case ("GET", "/rooms/a1b2c3d4e5/files"):
                return (Data(#"{"folder":"/h/room-files/a1b2c3d4e5","files":[{"path":"a.md","size":3,"modifiedAt":5}],"more":false}"#.utf8), httpResponse(req.url, status: 200))
            default: return (Data(#"{"ok":true}"#.utf8), httpResponse(req.url, status: 200))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        func body(_ n: Int) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(transport.requests[n].httpBody)) as? NSDictionary) }

        let made = try await api.addRoomTask("a1b2c3d4e5", title: "写文档", detail: "接口一节", owner: "web", after: [1])
        XCTAssertEqual(made, RoomTask(n: 4, title: "写文档", detail: "接口一节", state: .todo, owner: "web", by: "you", createdAt: 7, updatedAt: 7, after: [1]))
        XCTAssertEqual(try body(0), ["title": "写文档", "detail": "接口一节", "owner": "web", "after": [1]])
        try await api.addRoomTask("a1b2c3d4e5", title: "只有标题", detail: "")
        XCTAssertEqual(try body(1), ["title": "只有标题"])   // what is not said is not sent

        let done = try await api.setRoomTask(4, in: "a1b2c3d4e5", state: .done)
        XCTAssertEqual(done.state, .done)
        XCTAssertEqual(try body(2), ["state": "done"])
        try await api.setRoomTask(4, in: "a1b2c3d4e5", owner: .seat("daemon"))
        XCTAssertEqual(try body(3), ["owner": "daemon"])
        // Nobody's any more: `null`, which is not the same as not saying.
        try await api.setRoomTask(4, in: "a1b2c3d4e5", owner: .nobody)
        XCTAssertEqual(try body(4), ["owner": NSNull()])
        try await api.setRoomTask(4, in: "a1b2c3d4e5", state: .todo, title: "新标题", detail: "", note: "重做")
        XCTAssertEqual(try body(5), ["state": "todo", "title": "新标题", "detail": "", "note": "重做"])
        try await api.deleteRoomTask(4, in: "a1b2c3d4e5")

        let files = try await api.roomFiles("a1b2c3d4e5")
        XCTAssertEqual(files, RoomFiles(folder: "/h/room-files/a1b2c3d4e5", files: [RoomFile(path: "a.md", size: 3, modifiedAt: 5)]))

        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }, [
            "POST /rooms/a1b2c3d4e5/tasks", "POST /rooms/a1b2c3d4e5/tasks", "PATCH /rooms/a1b2c3d4e5/tasks/4", "PATCH /rooms/a1b2c3d4e5/tasks/4", "PATCH /rooms/a1b2c3d4e5/tasks/4",
            "PATCH /rooms/a1b2c3d4e5/tasks/4", "DELETE /rooms/a1b2c3d4e5/tasks/4", "GET /rooms/a1b2c3d4e5/files",
        ])
        // The service's own words come back as the error.
        do { try await api.setRoomTask(2, in: "a1b2c3d4e5", state: .done); XCTFail("changed a task the Mac refused") } catch let error as APIError {
            XCTAssertEqual(error.errorDescription, "T2 is being done by @web. Take another, or ask @web in the room.")
        }
        do { try await api.deleteRoomTask(9, in: "a1b2c3d4e5"); XCTFail("deleted a task that is not there") } catch let error as APIError {
            XCTAssertEqual(error.errorDescription, "There is no task T9 in this room.")
        }
    }

    func testAFileOfTheSharedFolderIsToldFromOneElsewhere() {
        let folder = "/h/room-files/a1b2c3d4e5"
        XCTAssertEqual(RoomFiles.relative("/h/room-files/a1b2c3d4e5/photo.jpg", in: folder), "photo.jpg")
        XCTAssertEqual(RoomFiles.relative("/h/room-files/a1b2c3d4e5/shots/主 页.png", in: folder), "shots/主 页.png")
        XCTAssertEqual(RoomFiles.relative("/h/room-files/a1b2c3d4e5/a.md", in: folder + "/"), "a.md")
        // Elsewhere on the Mac, a folder whose name only begins the same, the folder itself.
        XCTAssertNil(RoomFiles.relative("/w/docs/a.md", in: folder))
        XCTAssertNil(RoomFiles.relative("/h/room-files/a1b2c3d4e5-old/a.md", in: folder))
        XCTAssertNil(RoomFiles.relative(folder, in: folder))
        XCTAssertNil(RoomFiles.relative(folder + "/", in: folder))
        // What the room's route would not give: out of the folder again, a hidden part, an empty one.
        XCTAssertNil(RoomFiles.relative(folder + "/../x/a.md", in: folder))
        XCTAssertNil(RoomFiles.relative(folder + "/.git/config", in: folder))
        XCTAssertNil(RoomFiles.relative(folder + "/a//b.md", in: folder))
        // A Mac that gave no folder has nothing in it.
        XCTAssertNil(RoomFiles.relative("/a.md", in: ""))
        XCTAssertNil(RoomFiles.relative("/a.md", in: "/"))

        XCTAssertTrue(["/a/b.png", "/a/B.JPG", "c.jpeg", "/x/d.gif", "/x/e.heic", "/x/f.webp"].allSatisfy(RoomMessage.isPicture))
        XCTAssertFalse(["/a/b.md", "/a/png", "/a/b.png.txt", "/a/b.pdf", "/a/b.svg"].contains(where: RoomMessage.isPicture))
        XCTAssertEqual(RoomMessage.maxFiles, 10)
    }

    func testRoomFileCallsAreAsTheServiceTakesThem() async throws {
        let picture = Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF])
        let transport = FakeTransport { req, _ in
            let path = req.url?.path ?? "", method = req.httpMethod ?? ""
            switch (method, path) {
            case ("GET", "/rooms/a1b2c3d4e5/files/content"):
                if req.url?.query?.contains("big") == true { return (Data(#"{"error":"too-large","size":30000000,"limit":26214400}"#.utf8), httpResponse(req.url, status: 413)) }
                return (picture, httpResponse(req.url, contentType: "image/png"))
            case ("PUT", "/rooms/a1b2c3d4e5/files/content"):
                if req.httpBody?.isEmpty != false { return (Data(#"{"error":"empty file"}"#.utf8), httpResponse(req.url, status: 400)) }
                return (Data(#"{"path":"/h/room-files/a1b2c3d4e5/photo 1-2.jpg","name":"photo 1-2.jpg","size":6}"#.utf8), httpResponse(req.url, status: 201))
            case ("POST", "/rooms/a1b2c3d4e5/messages"):
                return (Data(#"{"message":{"seq":5,"from":"you","to":["daemon"],"text":"@daemon 看图","at":9,"files":["/h/room-files/a1b2c3d4e5/photo 1-2.jpg"]},"receipts":{"daemon":"queued"}}"#.utf8), httpResponse(req.url, status: 201))
            default: return (Data(#"{"ok":true}"#.utf8), httpResponse(req.url, status: 200))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")

        // A file of the folder, by where it is under it: the bytes as they are.
        let got = try await api.roomFile("a1b2c3d4e5", path: "shots/主 页+1&2.png")
        XCTAssertEqual(got, picture)
        let get = transport.requests[0]
        XCTAssertEqual(get.httpMethod, "GET")
        XCTAssertEqual(get.url?.path, "/rooms/a1b2c3d4e5/files/content")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(get.url), resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "path", value: "shots/主 页+1&2.png")])
        // Written so the service reads it back the same: no bare `+` (a space to it), no bare `&`, no raw space.
        let query = try XCTUnwrap(URLComponents(url: try XCTUnwrap(get.url), resolvingAgainstBaseURL: false)?.percentEncodedQuery)
        XCTAssertTrue(query.hasPrefix("path=shots/"))
        XCTAssertTrue(query.contains("%2B1%262.png"))
        XCTAssertFalse(query.contains("+") || query.contains(" "))
        XCTAssertEqual(get.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(get.httpBody)

        // A picture picked here: its bytes as the body, its name in the query; where it landed comes back.
        let put = try await api.putRoomFile("a1b2c3d4e5", name: "photo 1.jpg", data: picture)
        XCTAssertEqual(put, MacUploaded(path: "/h/room-files/a1b2c3d4e5/photo 1-2.jpg", name: "photo 1-2.jpg", size: 6))
        let sent = transport.requests[1]
        XCTAssertEqual(sent.httpMethod, "PUT")
        XCTAssertEqual(sent.url?.path, "/rooms/a1b2c3d4e5/files/content")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(sent.url), resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "name", value: "photo 1.jpg")])
        XCTAssertEqual(sent.httpBody, picture)
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")

        // The message then comes with where the file is; one with no files says nothing of files.
        let said = try await api.say("@daemon 看图", in: "a1b2c3d4e5", files: [put.path])
        XCTAssertEqual(said.message.files, ["/h/room-files/a1b2c3d4e5/photo 1-2.jpg"])
        func body(_ n: Int) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(transport.requests[n].httpBody)) as? NSDictionary) }
        XCTAssertEqual(try body(2), ["text": "@daemon 看图", "files": ["/h/room-files/a1b2c3d4e5/photo 1-2.jpg"]])
        try await api.say("没有附件", in: "a1b2c3d4e5", replyTo: 5)
        XCTAssertEqual(try body(3), ["text": "没有附件", "replyTo": 5])

        // The service's refusals come back as they are.
        do { _ = try await api.roomFile("a1b2c3d4e5", path: "big.mov"); XCTFail("read a file the Mac refused") } catch APIError.http(let status, let message) {
            XCTAssertEqual(status, 413)
            XCTAssertEqual(message, "too-large")
        }
        do { _ = try await api.putRoomFile("a1b2c3d4e5", name: "empty.png", data: Data()); XCTFail("put an empty file") } catch APIError.http(let status, let message) {
            XCTAssertEqual(status, 400)
            XCTAssertEqual(message, "empty file")
        }
    }
}
