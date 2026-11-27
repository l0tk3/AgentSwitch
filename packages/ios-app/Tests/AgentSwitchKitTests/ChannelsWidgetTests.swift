import AgentSwitchLive
import XCTest
@testable import AgentSwitchKit

/// The home screen's Channels widget's copy of the rooms (docs/app-v0.md §6).
final class ChannelsWidgetTests: XCTestCase {
    private static let list = #"""
    {"rooms":[
      {"id":"r1","name":"design","topic":"t","members":3,"faces":[],"unread":0,"forYou":false,
       "last":{"seq":4,"from":"you","text":"**Bold** and `code`\nsecond line","at":3000}},
      {"id":"desk","name":"调度台","topic":"","members":2,"faces":[],"desk":true,"unread":1,"forYou":true,
       "last":{"seq":9,"from":"dispatch","text":"@you done","at":1000}},
      {"id":"r2","name":"quiet","topic":"nothing yet","members":2,"faces":[],"last":null,"unread":0,"forYou":false},
      {"id":"r3","name":"tasks","topic":"","members":4,"faces":[],"unread":2,"forYou":false,"attention":2,
       "last":{"seq":2,"from":"daemon","text":"blocked","at":5000}}]}
    """#

    private func snapshot() throws -> ChannelsSnapshot {
        ChannelsSnapshot(try JSONDecoder().decode(RoomList.self, from: Data(Self.list.utf8)), classic: true, savedAt: Date(timeIntervalSince1970: 9))
    }

    func testTheCopyKeepsTheListsOrderAndOneLineOfTheLastWord() throws {
        let s = try snapshot()
        XCTAssertEqual(s.channels.map(\.id), ["desk", "r1", "r2", "r3"], "the desk first, as the list shows it")
        XCTAssertEqual(s.channels[1].from, "You")
        XCTAssertEqual(s.channels[1].text, "Bold and code second line")
        XCTAssertEqual(s.channels[1].at, Date(timeIntervalSince1970: 3))
        XCTAssertNil(s.channels[2].from)
        XCTAssertEqual(s.channels[2].text, "nothing yet", "nothing said: the topic")
        XCTAssertEqual(s.waiting, 3, "a message naming the user, and two things waiting in r3")
        XCTAssertEqual(s.unread, 3)
    }

    func testWhatAWidgetShows() throws {
        let s = try snapshot()
        XCTAssertEqual(s.pick(.recent, limit: 9).map(\.id), ["r3", "r1", "desk", "r2"], "spoken in last first; never spoken in last")
        XCTAssertEqual(s.pick(.recent, limit: 2).map(\.id), ["r3", "r1"])
        XCTAssertEqual(s.pick(.mentions, limit: 9).map(\.id), ["r3", "desk"])
        XCTAssertEqual(s.pick(.chosen, chosen: ["r2", "gone", "r1", "r2"], limit: 9).map(\.id), ["r2", "r1"], "in the order picked, once")
    }

    func testTheShelfKeepsItWhole() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let s = try snapshot()
        XCTAssertTrue(ChannelsShelf.write(s, to: folder))
        XCTAssertEqual(ChannelsShelf.read(from: folder), s)
        ChannelsShelf.clear(in: folder)
        XCTAssertNil(ChannelsShelf.read(from: folder))
        XCTAssertFalse(ChannelsShelf.write(s, to: nil), "no group: nothing written")
    }

    func testRoomLinks() {
        XCTAssertEqual(LiveLink.room("a1b2").absoluteString, "agentswitch://room/a1b2")
        XCTAssertEqual(LiveLink.roomId(from: LiveLink.room("a1b2")), "a1b2")
        XCTAssertNil(LiveLink.roomId(from: LiveLink.terminal("a1b2")))
        XCTAssertTrue(LiveLink.isRooms(LiveLink.rooms))
        XCTAssertNil(LiveLink.terminalId(from: LiveLink.room("a1b2")))
    }

    func testALongLineIsCut() {
        XCTAssertEqual(ChannelsSnapshot.line(String(repeating: "a", count: 200), limit: 5), "aaaaa…")
        XCTAssertEqual(ChannelsSnapshot.line("  a   b  "), "a b")
    }
}

final class WidgetLinkTests: XCTestCase {
    func testTheAddressInUseIsTriedFirstAndEachOnce() throws {
        let json = #"{"name":"Mac","port":7443,"fingerprint":"ab","lan":["192.168.1.5","10.0.0.2"],"tailnet":["100.64.0.9"],"bonjour":"","deviceId":"d","pairedAt":0}"#
        let profile = try JSONDecoder().decode(ServerProfile.self, from: Data(json.utf8))
        let inUse = APIEndpoint(host: "10.0.0.2", port: 7443, kind: .bonjour)
        XCTAssertEqual(WidgetLink.endpoints(of: profile, inUse: inUse).map(\.host), ["10.0.0.2", "192.168.1.5", "100.64.0.9"])
        XCTAssertEqual(WidgetLink.endpoints(of: profile, inUse: nil).map(\.kind), [.lan, .lan, .tailnet])
    }
}
