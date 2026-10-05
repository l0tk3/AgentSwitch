import XCTest
@testable import AgentSwitchMacCore

/// The native terminal screen's side of the service (docs/terminal-v0.md §1 Mac): its stream, its look, its routes.
final class TerminalScreenDataTests: XCTestCase {
    func testServerSentEventsArriveInPiecesWithCommentsAndCRLF() {
        var parser = SSEParser()
        let text = ": ping\n\nevent: snapshot\r\nid: 3\r\ndata: {\"type\":\"snapshot\",\"seq\":3,\"cols\":80,\"rows\":24,\"data\":\"hi\\u001b[31m\"}\r\n\r\nevent: output\ndata: {\"seq\":4,\"data\":\"你好\"}\n\n"
        let bytes = Array(text.utf8)
        var got: [(event: String, data: String)] = []
        // Cut in the middle of a line and of a multi-byte character.
        for chunk in stride(from: 0, to: bytes.count, by: 7).map({ Array(bytes[$0..<min($0 + 7, bytes.count)]) }) {
            got += parser.feed(chunk)
        }
        XCTAssertEqual(got.map(\.event), ["snapshot", "output"])
        XCTAssertEqual(TerminalStreamEvent.decode(event: got[0].event, data: got[0].data), .snapshot(seq: 3, cols: 80, rows: 24, data: "hi\u{1b}[31m"))
        XCTAssertEqual(TerminalStreamEvent.decode(event: got[1].event, data: got[1].data), .output(seq: 4, data: "你好"))
    }

    func testAnotherScreenOfThisMacHoldsNothing() {
        XCTAssertEqual(TerminalSizeHolder.holder("mac-1a2b", seenFrom: "mac-1a2b"), "mac-1a2b", "this screen's own")
        XCTAssertNil(TerminalSizeHolder.holder("mac-9f00", seenFrom: "mac-1a2b"), "the pane or the window it was in before: let go already")
        XCTAssertEqual(TerminalSizeHolder.holder("phone-77", seenFrom: "mac-1a2b"), "phone-77")
        XCTAssertEqual(TerminalSizeHolder.holder("web-12", seenFrom: "mac-1a2b"), "web-12")
        XCTAssertNil(TerminalSizeHolder.holder(nil, seenFrom: "mac-1a2b"))
    }

    func testTheEventsTheScreenActsOn() {
        XCTAssertEqual(TerminalStreamEvent.decode(event: "resize", data: #"{"type":"resize","cols":120,"rows":40,"by":"phone-1a"}"#), .resize(cols: 120, rows: 40, by: "phone-1a"))
        XCTAssertEqual(TerminalStreamEvent.decode(event: "resize", data: #"{"type":"resize","cols":120,"rows":40,"by":null}"#), .resize(cols: 120, rows: 40, by: nil))
        XCTAssertEqual(TerminalStreamEvent.decode(event: "status", data: #"{"type":"status","status":"waiting"}"#), .status("waiting"))
        XCTAssertEqual(TerminalStreamEvent.decode(event: "exit", data: #"{"type":"exit","code":null}"#), .exit(code: nil))
        XCTAssertEqual(TerminalStreamEvent.decode(event: "removed", data: #"{"type":"removed"}"#), .removed)
        XCTAssertNil(TerminalStreamEvent.decode(event: "permission", data: #"{"type":"permission","request":{}}"#), "the page's")
        XCTAssertNil(TerminalStreamEvent.decode(event: "output", data: "not json"))
    }

    func testTheUsersItermLook() throws {
        let json = ##"{"source":"iterm","fontFamily":"\"MesloLGS NF\", \"MesloLGS-NF-Regular\", \"SF Mono\", Menlo, monospace","fontSize":15,"lineHeight":1,"letterSpacing":0,"theme":{"black":"#000000","red":"#cc0000","green":"#4e9a06","yellow":"#c4a000","blue":"#3465a4","magenta":"#75507b","cyan":"#06989a","white":"#d3d7cf","brightBlack":"#555753","brightRed":"#ef2929","brightGreen":"#8ae234","brightYellow":"#fce94f","brightBlue":"#729fcf","brightMagenta":"#ad7fa8","brightCyan":"#34e2e2","brightWhite":"#eeeeec","background":"#000000","foreground":"#ffffff","cursor":"#ffffff","cursorAccent":"#000000","selectionBackground":"rgba(181,213,255,0.4)"}}"##
        let style = try JSONDecoder().decode(TerminalStyle.self, from: Data(json.utf8))
        XCTAssertEqual(style.families, ["MesloLGS NF", "MesloLGS-NF-Regular", "SF Mono", "Menlo", "monospace"])
        XCTAssertEqual(style.fontSize, 15)
        XCTAssertEqual(style.theme.ansi?.count, 16)
        let red = try XCTUnwrap(TerminalStyle.rgba("#cc0000"))
        XCTAssertEqual(red.red, 0.8, accuracy: 0.001)
        XCTAssertEqual(red.alpha, 1)
        let selection = try XCTUnwrap(TerminalStyle.rgba(try XCTUnwrap(style.theme.selectionBackground)))
        XCTAssertEqual(selection.blue, 1, accuracy: 0.001)
        XCTAssertEqual(selection.alpha, 0.4, accuracy: 0.001)
        XCTAssertNil(TerminalStyle.rgba("red"))
    }

    func testTheRoutesCarryTheToken() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-screen-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let tokenFile = home.appendingPathComponent(DaemonClient.tokenFileName)
        try "tok-9\n".write(to: tokenFile, atomically: true, encoding: .utf8)
        let stub = StubTransport { _ in (200, #"{"ok":true}"#) }
        let client = DaemonClient(port: 4811, transport: stub, tokenFile: tokenFile)
        let stream = client.terminalStreamRequest(id: "ab 1", after: 42)
        XCTAssertEqual(stream.url?.absoluteString, "http://127.0.0.1:4811/terminals/ab%201/stream?after=42")
        XCTAssertEqual(client.terminalStreamRequest(id: "ab1", screen: "mac-3f").url?.absoluteString, "http://127.0.0.1:4811/terminals/ab1/stream?screen=mac-3f")
        XCTAssertEqual(stream.value(forHTTPHeaderField: "Authorization"), "Bearer tok-9")
        try await client.writeTerminal(id: "ab1", data: "\u{1b}[A")
        try await client.terminalKeys(id: "ab1", ["shift-enter"])
        try await client.resizeTerminal(id: "ab1", cols: 120, rows: 40, screen: "mac-3f")
        let sent = stub.requests.map { "\($0.url?.path ?? "") \(String(decoding: $0.httpBody ?? Data(), as: UTF8.self))" }
        XCTAssertEqual(sent[0], #"/terminals/ab1/write {"data":"\u001b[A"}"#)
        XCTAssertEqual(sent[1], #"/terminals/ab1/keys {"keys":["shift-enter"]}"#)
        XCTAssertTrue(sent[2].hasPrefix("/terminals/ab1/resize ") && sent[2].contains(#""cols":120"#) && sent[2].contains(#""rows":40"#) && sent[2].contains(#""screen":"mac-3f""#))
    }
}
