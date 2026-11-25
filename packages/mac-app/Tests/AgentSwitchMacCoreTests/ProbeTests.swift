import XCTest
@testable import AgentSwitchMacCore

final class PortProbeTests: XCTestCase {
    func testAPortIsListeningOnlyWhileSomethingAcceptsOnIt() {
        let port = TestSupport.freePort()
        XCTAssertFalse(PortProbe.isListening(port: port))
        let server = CannedServer(response: "HTTP/1.1 200 OK\r\n\r\n")
        defer { server.stop() }
        XCTAssertTrue(PortProbe.isListening(port: server.port))
    }
}
