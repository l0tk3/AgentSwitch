import XCTest
@testable import AgentSwitchMacCore

/// A profile's claude.ai session key and the device Claude Code says it is (docs/profiles-v0.md §3.4, §3.5): what is
/// typed is told from the other kinds of key before it is sealed; the service says only that one is kept; a terminal
/// carries the device, and the bar shows its first digits.
final class ProfileSessionKeyTests: XCTestCase {
    private let key = "sk-ant-sid01-" + String(repeating: "Ab3_-", count: 12)

    func testWhatIsTypedIsASessionKeyOrSaidNotToBe() {
        XCTAssertTrue(SessionKeyText.valid(key))
        XCTAssertNil(SessionKeyText.problem(key))
        // Pasted as the cookie, or quoted, it is taken down to the key.
        XCTAssertEqual(SessionKeyText.cleaned("  sessionKey=\(key); Path=/; Secure \n"), key)
        XCTAssertEqual(SessionKeyText.cleaned("\"\(key)\""), key)
        XCTAssertTrue(SessionKeyText.valid("sessionKey=\(key);"))
        // Nothing is said while it could still become one.
        for typing in ["", "s", "sk-ant-", "sk-ant-sid01-abc"] {
            XCTAssertNil(SessionKeyText.problem(typing), typing)
            XCTAssertFalse(SessionKeyText.valid(typing), typing)
        }
        XCTAssertEqual(SessionKeyText.problem("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "这是 API key，不是 claude.ai 的 session key。")
        XCTAssertEqual(SessionKeyText.problem("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz"), "这是 claude setup-token 的令牌，不是 claude.ai 的 session key。")
        XCTAssertEqual(SessionKeyText.problem("hunter2"), "Session key 应以 sk-ant-sid 开头。")
        XCTAssertEqual(SessionKeyText.site, "claude.ai")
    }

    func testAProfileSaysItKeepsOneAndWhichDeviceItIs() throws {
        let device = String(repeating: "56967b93", count: 8)
        let agents = try JSONDecoder().decode([String: AgentProfiles].self, from: Data(#"""
        {"claude-code":{"current":"default","creatable":true,"profiles":[
          {"id":"default","name":"Default","kind":"subscription","createdAt":0,"device":"\#(device)"},
          {"id":"abc123def0","name":"cwork1","kind":"subscription","createdAt":1,"sessionKey":true}]}}
        """#.utf8))
        let list = try XCTUnwrap(agents["claude-code"]).profiles
        XCTAssertEqual(list.map(\.hasSessionKey), [false, true])
        XCTAssertEqual(list.map(\.device), [device, nil])
    }

    func testATerminalCarriesItsDeviceAndTheBarShowsItsFirstDigits() throws {
        let device = "56967b93c1a04e7d9f20b6a3e85d17c40a9be2f6713d58c4e09a1b7f3c6d2e85"
        let info = try JSONDecoder().decode(TerminalInfo.self, from: Data(#"{"id":"t1","harness":"claude-code","cwd":"/w","name":"n","status":"idle","device":"\#(device)"}"#.utf8))
        XCTAssertEqual(info.device, device)
        XCTAssertEqual(info.context.device, device)
        // What its stream says of it later does not lose it.
        XCTAssertEqual(info.with(status: "working").device, device)
        XCTAssertEqual(DeviceID.label(device), "ID 56967b93")
        XCTAssertTrue(DeviceID.help(device).hasSuffix(device))
        // None said, or something that is not an id: nothing is shown.
        for said in [#""device":null"#, #""device":"<b>x</b>""#, #""x":1"#] {
            let other = try JSONDecoder().decode(TerminalInfo.self, from: Data("{\"id\":\"t2\",\"harness\":\"codex\",\"cwd\":\"/w\",\"name\":\"n\",\"status\":\"idle\",\(said)}".utf8))
            XCTAssertNil(other.device, said)
            XCTAssertNil(other.context.device, said)
        }
    }
}
