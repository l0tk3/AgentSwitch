import XCTest
@testable import AgentSwitchMacCore

/// docs/mesh-v0.md §5.2: a client whose routes are another node's, and the rows of Settings › Nodes.
final class NodesTests: XCTestCase {
    func testProfileSecretsUseTheTargetsPublicKeyWithoutPuttingTheSecretInArguments() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("node-gate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let executable = dir.appendingPathComponent("gate")
        let script = """
        #!/bin/sh
        test "$#" = 4 && test "$1" = enc && test "$2" = --batch && test "$3" = --pubkey && test "$4" = remote-public-key || exit 2
        input=$(cat)
        case "$input" in *test-secret*) printf '[{"token":"enc:v1:test"}]';; *) exit 3;; esac
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let cli = GateCLI(executable: executable, environment: ["PATH": "/usr/bin:/bin"])
        let token = try await cli.seal(GateSealRequest(label: "profile/test", sites: "example.com", value: "test-secret"), publicKey: "remote-public-key")
        XCTAssertEqual(token, "enc:v1:test")
    }

    func testProfileAndUpdateRequestsTargetTheSelectedNode() async throws {
        let transport = StubTransport { _ in (200, "{}") }
        let client = DaemonClient(port: 1, transport: transport).onNode("remote123")
        _ = try? await client.profiles()
        _ = try? await client.profileGateKey()
        _ = try? await client.setCodexAuth(id: "default", content: "{}")
        _ = try? await client.nodeReleaseUpdate("prepare", version: "0.3.0")
        _ = try? await client.nodeReleaseUpdate("install", version: "0.3.0")
        let requests = transport.requests
        XCTAssertEqual(requests.map { $0.url!.path }, ["/nodes/remote123/profiles", "/nodes/remote123/gate/pubkey", "/nodes/remote123/profiles/codex/default/auth", "/nodes/remote123/update/release/prepare", "/nodes/remote123/update/release/install"])
        XCTAssertEqual(requests.map { $0.httpMethod }, ["GET", "GET", "PUT", "POST", "POST"])
    }

    func testAClientOnANodeAsksEveryRouteThroughThisMacsService() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("nodes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("nodes"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try "local-token-value".write(to: home.appendingPathComponent("local-token"), atomically: true, encoding: .utf8)
        try "nodes-key-value\n".write(to: home.appendingPathComponent("nodes/key"), atomically: true, encoding: .utf8)
        let transport = StubTransport { _ in (200, "{}") }
        let here = DaemonClient(port: 4711, transport: transport, tokenFile: home.appendingPathComponent("local-token"))
        let there = here.onNode("f5e937d15369")
        XCTAssertFalse(here.isRemote)
        XCTAssertTrue(there.isRemote)
        _ = try? await here.health()
        _ = try? await there.health()
        _ = try? await there.forBrowser("claude-code.abc123def0").browserTabs()
        _ = try? await there.nodeInfo()
        // The list of nodes, pairing and removal are this Mac's own service's, whichever node the client is on.
        _ = try? await there.nodes()
        _ = try? await there.removeNode(id: "f5e937d15369", both: true)
        _ = try? await there.onNode(nil).health()
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url!.path)\($0.url!.query.map { "?" + $0 } ?? "")" }, [
            "GET /healthz", "GET /nodes/f5e937d15369/healthz", "GET /nodes/f5e937d15369/profile-browser/claude-code.abc123def0/browser/tabs",
            "GET /nodes/f5e937d15369/node", "GET /nodes", "DELETE /nodes/f5e937d15369?both=1", "GET /healthz"])
        // The nodes key goes with the routes that are under /nodes, and with no other; the local token with all.
        XCTAssertEqual(transport.requests.map { $0.value(forHTTPHeaderField: DaemonClient.nodesKeyHeader) },
                       [nil, "nodes-key-value", "nodes-key-value", "nodes-key-value", "nodes-key-value", "nodes-key-value", nil])
        XCTAssertTrue(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer local-token-value" })
        // A node named by a name with a space in it.
        XCTAssertEqual(here.onNode("Mac mini").nodePrefix, "/nodes/Mac%20mini")
    }

    func testPairingCodesAreForBothWaysUnlessToldNot() async throws {
        let transport = StubTransport { _ in (200, #"{"code":"K7QD-2M9F","expiresAt":1790000000000,"link":"agentswitch://pair?p=e30"}"#) }
        let client = DaemonClient(port: 4711, transport: transport)
        _ = try await client.createPairing()
        _ = try await client.createPairing(back: false)
        XCTAssertEqual(transport.requests.map { String(decoding: $0.httpBody ?? Data(), as: UTF8.self) }, ["{}", #"{"back":false}"#])
    }

    func testReadsTheNodesAsTheServiceSaysThem() throws {
        let json = """
        {"self":{"name":"MacBook Pro","kind":"mac","fingerprint":"aa","port":4713,"listening":true},
         "nodes":[{"id":"f5e937d15369","name":"Mac mini","kind":"mac","port":4713,"fingerprint":"f5e9","lan":["192.168.1.30"],"tailnet":["mac-mini.tail1234.ts.net"],
                   "last":"192.168.1.30","gate":null,"deviceId":"d-there","pairedAt":1791600000000,"inbound":"d-here","state":"online","address":"192.168.1.30","waiting":2},
                  {"id":"0937184ad0d9","name":"Studio","kind":null,"port":4713,"fingerprint":"0937","lan":[],"tailnet":[],"deviceId":"d2","inbound":null,"state":"revoked","address":"10.0.0.9","waiting":null}]}
        """
        let list = try JSONDecoder().decode(NodeList.self, from: Data(json.utf8))
        XCTAssertEqual(list.own, NodeSelf(name: "MacBook Pro", fingerprint: "aa", port: 4713))
        XCTAssertEqual(list.nodes.map(\.state), [.online, .revoked])
        XCTAssertEqual(list.nodes[0].waiting, 2)
        XCTAssertEqual(list.nodes[0].inbound, "d-here")
        XCTAssertNil(list.nodes[1].kind)
        let added = try JSONDecoder().decode(NodeAdded.self, from: Data(#"{"ok":true,"back":"paired","node":{"id":"f5e937d15369","name":"Mac mini","deviceId":"d"}}"#.utf8))
        XCTAssertEqual(added.back, .paired)
        XCTAssertEqual(added.node.state, .online)
        XCTAssertEqual(NodeText.paired(added), "已与 Mac mini 配对，双向可用。")
        let info = try JSONDecoder().decode(NodeInfo.self, from: Data(#"{"name":"Mac mini","kind":"mac","version":"0.1.0","home":"/Users/dev","has":["dispatch","terminals","keyboard"]}"#.utf8))
        XCTAssertTrue(info.has("keyboard"))
        XCTAssertFalse(info.has("clash"))
        XCTAssertEqual(try JSONDecoder().decode(MeshSettings.self, from: Data(#"{"keyboard":false}"#.utf8)), MeshSettings(keyboard: false))
    }

    func testTheRowsAreTheNodesWithTheirTwoDirectionsThenWhoOnlyUsesThisMac() {
        let device = { (id: String, name: String, platform: String, revoked: Bool, online: Bool) in
            Device(id: id, name: name, platform: platform, createdAt: Date(timeIntervalSince1970: 100), lastSeenAt: nil, revokedAt: revoked ? Date() : nil, online: online)
        }
        let nodes = [
            NodeStatus(id: "n2", name: "Studio", state: .offline, deviceId: "x", inbound: "gone"),
            NodeStatus(id: "n1", name: "mac mini", state: .online, address: "192.168.1.30", waiting: 1, deviceId: "y", inbound: "d-mini"),
        ]
        let devices = [device("d-phone", "iPhone 17 Pro", "ios", false, true), device("d-mini", "Mac mini", "macos", false, true),
                       device("gone", "Studio", "macos", true, false), device("d-book", "MacBook Air", "macos", false, false),
                       device("d-old", "Old Phone", "ios", true, false)]
        let rows = NodeRows.build(nodes: nodes, devices: devices)
        XCTAssertEqual(rows.map(\.id), ["n1", "n2", "device-d-book", "device-d-phone"])
        XCTAssertEqual(rows.map(\.uses), [true, true, false, false])
        XCTAssertEqual(rows.map(\.usedBy), [true, false, true, true])       // Studio's device here was revoked: one way now
        XCTAssertEqual(rows.map(\.kind), [.mac, .mac, .mac, .phone])
        XCTAssertEqual(rows.map(\.canBeUsed), [true, true, true, false])
        XCTAssertEqual(rows.map(\.line), ["Online · 192.168.1.30", "Offline", "Offline", "Online"])
        XCTAssertEqual(NodeRows.build(nodes: [NodeStatus(id: "n", name: "x", state: .revoked)], devices: []).first?.line, "Removed There")
    }

    func testAScreenOnAnotherNodesTerminalIsNamedAfterThisMacsDeviceThere() {
        // On this Mac's own terminals, as before: another `mac-…` screen is this app's other screen, which let go.
        XCTAssertEqual(TerminalSizeHolder.screen(onNodeAs: nil, unique: "ab12cd34"), "mac-ab12cd34")
        XCTAssertNil(TerminalSizeHolder.holder("mac-other", seenFrom: "mac-ab12cd34"))
        XCTAssertEqual(TerminalSizeHolder.holder("phone-1", seenFrom: "mac-ab12cd34"), "phone-1")
        XCTAssertEqual(TerminalSizeHolder.holder("mac-ab12cd34", seenFrom: "mac-ab12cd34"), "mac-ab12cd34")
        // On another node's: that node's own window (`mac-…`) does hold the size; another screen of this Mac there
        // has let go; a third node's screen holds it.
        let mine = TerminalSizeHolder.screen(onNodeAs: "cec3ed5e-9f", unique: "ab12cd34")
        XCTAssertEqual(mine, "node-cec3ed5e-ab12cd34")
        XCTAssertEqual(TerminalSizeHolder.holder("mac-17aa", seenFrom: mine), "mac-17aa")
        XCTAssertNil(TerminalSizeHolder.holder("node-cec3ed5e-ffff0000", seenFrom: mine))
        XCTAssertEqual(TerminalSizeHolder.holder("node-0badf00d-ffff0000", seenFrom: mine), "node-0badf00d-ffff0000")
        // And seen from that node's own window, this Mac's screen is a screen elsewhere, said as such.
        XCTAssertEqual(TerminalSizeHolder.holder(mine, seenFrom: "mac-17aa"), mine)
        XCTAssertEqual(["phone-1", "mac-17aa", mine, "web-9"].map(TerminalSizeHolder.place(of:)), ["iphone", "mac", "node", "web"])
        XCTAssertEqual(TerminalWindowText.away("node").head, "On Another Node")
        // The client says whose screens these are.
        let client = DaemonClient(port: 4711)
        XCTAssertNil(client.screenOwner)
        XCTAssertEqual(client.onNode("f5e937d15369", as: "cec3ed5e").screenOwner, "cec3ed5e")
        XCTAssertEqual(client.onNode("f5e937d15369").screenOwner, "f5e937d15369")
        XCTAssertNil(client.onNode("f5e937d15369", as: "cec3ed5e").onNode(nil).screenOwner)
    }

    func testTheWordsOfTheMenuAndThePaths() {
        XCTAssertEqual(NodeText.path("192.168.1.30"), "LAN")
        XCTAssertEqual(NodeText.path("100.101.102.103"), "Tailscale")
        XCTAssertEqual(NodeText.path("mac-mini.tail1234.ts.net"), "Tailscale")
        XCTAssertNil(NodeText.path(nil))
        XCTAssertEqual(NodeText.menuDetail(NodeStatus(id: "n", name: "x", state: .online, address: "10.0.0.2", waiting: 2)), "2 Waiting")
        XCTAssertEqual(NodeText.menuDetail(NodeStatus(id: "n", name: "x", state: .online, address: "10.0.0.2", waiting: 0)), "LAN")
        XCTAssertEqual(NodeText.menuDetail(NodeStatus(id: "n", name: "x", state: .offline)), "Offline")
        XCTAssertEqual(NodeText.tilde("/Users/dev/Projects/App", home: "/Users/dev"), "~/Projects/App")
        XCTAssertEqual(NodeText.tilde("/Users/developer/x", home: "/Users/dev"), "/Users/developer/x")
        XCTAssertEqual(NodeText.tilde("/home/dev", home: "/home/dev"), "~")
        XCTAssertEqual(NodeText.tilde("/srv/x", home: ""), "/srv/x")
    }
}
