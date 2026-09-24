#if os(macOS)
import XCTest
@testable import AgentSwitchKit

/// The phone's own client code against a real daemon (app-v0 §7 端到端). Opt-in: `AGENTSWITCH_E2E_LINK` holds a fresh
/// pairing link from the Mac side (`POST /pairing` on the local listener); scripts/e2e-live.sh starts the bundled
/// runtime of AgentSwitch.app with throw-away homes and non-default ports, sets it, and stops everything afterwards.
final class LiveDaemonTests: XCTestCase {
    func testPairPinMintCreateAndFollowAnEchoTask() async throws {
        guard let link = ProcessInfo.processInfo.environment["AGENTSWITCH_E2E_LINK"], !link.isEmpty else {
            throw XCTSkip("set AGENTSWITCH_E2E_LINK (or run scripts/e2e-live.sh)")
        }
        let payload = try PairingLink.parse(link)

        // A wrong fingerprint never gets as far as the pairing request.
        let wrongPin = String(payload.fp.reversed())
        do {
            _ = try await PairingService(transport: PinnedSessionTransport(fingerprint: wrongPin), discovery: nil).pair(payload, deviceName: "e2e")
            XCTFail("pairing with a wrong fingerprint must fail")
        } catch let error as PairingError {
            XCTAssertTrue([.unreachable, .pinMismatch(seen: payload.fp), .pinMismatch(seen: nil)].contains(error) || "\(error)".contains("pinMismatch"), "\(error)")
        }

        let transport = PinnedSessionTransport(fingerprint: payload.fp)
        let outcome = try await PairingService(transport: transport, discovery: nil).pair(payload, deviceName: "e2e iPhone")
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(outcome.endpoint), transport: transport, token: outcome.token)

        let me = try await api.me()
        XCTAssertEqual(me.deviceId, outcome.profile.deviceId)

        // Minting on the phone with the key that came with the QR code (or /gate/pubkey).
        let gate = try XCTUnwrap(outcome.profile.gate)
        let minter = try TokenMinter(publicKeyBase64URL: gate.publicKey)
        let token = try minter.mint(SecretPayload.make(value: "FICTIONAL-e2e-value", hosts: ["login.example.test"], uses: [.http], label: "e2e/pass"))
        XCTAssertTrue(token.hasPrefix("enc:v1:"))

        let task = try await api.createTask(NewTaskRequest(task: "Log in to login.example.test with password \(token) and report ok"))
        var types: [String] = []
        for try await event in api.events(taskId: task.id) { types.append(event.type) }
        XCTAssertEqual(types.last, "done", "events: \(types)")
        let detail = try await api.task(task.id)
        XCTAssertFalse(String(describing: detail).contains("FICTIONAL-e2e-value"), "the plaintext never exists outside the phone")

        // Paired and pinned, a stranger's token is still refused.
        let stranger = AgentSwitchAPI(endpoints: FixedEndpoint(outcome.endpoint), transport: transport, token: "not-a-device-token")
        do { _ = try await stranger.me(); XCTFail("an unknown token must be refused") } catch APIError.unauthorized {}

        // Writes that would change a real Mac: only against the throw-away runtime of scripts/e2e-live.sh.
        guard ProcessInfo.processInfo.environment["AGENTSWITCH_E2E_THROWAWAY"] == "1" else { return }

        // CONTEXT.md from the phone: saved under the Mac's lint (echo mode has no sealer), read back without the plaintext.
        let saved = try await api.saveContext("# e2e\n- 站点 https://login.example.test\n  - 密码: FICTIONAL-context-pass\n")
        XCTAssertFalse(saved.warnings.isEmpty, "the plaintext credential line is reported")
        let context = try await api.context()
        XCTAssertTrue(context.text.contains("https://login.example.test"))
        XCTAssertFalse(context.text.contains("FICTIONAL-context-pass"))
        let example = try await api.contextExample()
        XCTAssertFalse(example.isEmpty)

        // Attachments: staged, sent with a task, listed under in/ and downloaded byte for byte.
        let bytes = Data("e2e attachment \(UUID().uuidString)".utf8)
        let staged = try await api.upload([UploadFile(name: "note.txt", type: "text/plain", data: bytes)])
        XCTAssertEqual(staged.map(\.name), ["note.txt"])
        // A temporary work dir (and its in/) is removed when the task ends: look while it still runs.
        let withFile = try await api.createTask(NewTaskRequest(task: "read the attached note @echo {\"delayMs\":1500,\"result\":\"ok\"}", attachments: staged.map(\.id)))
        let files = try await api.taskFiles(withFile.id)
        let sent = try XCTUnwrap(files.first { $0.name == "note.txt" }, "files: \(files)")
        XCTAssertFalse(sent.isDeliverable)
        let back = try await api.download(taskId: withFile.id, path: sent.path)
        XCTAssertEqual(back, bytes)
        for try await _ in api.events(taskId: withFile.id) {}

        // The advanced delete: a finished task goes, and is gone.
        try await api.deleteTask(task.id)
        do { _ = try await api.task(task.id); XCTFail("a deleted task must be gone") } catch APIError.http(status: 404, message: _) {}
    }
}
#endif
