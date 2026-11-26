#if DEBUG
import AgentSwitchMacCore
import Foundation

/// Sample state for `-designPreview` (docs/ui-v0.md §5). Made-up names, addresses and keys; nothing here is real.
enum DemoData {
    static let computerName = "小林的 MacBook Pro"
    static let bonjourName = "AgentSwitch on \(computerName)"
    static let fingerprint = "3f9a2c7d41be58e06a1d9c2f7b3e4a5d6c7b8a9e0f1d2c3b4a5968778695a4b3"
    static let lan = ["192.168.1.20"]
    static let tailnet = ["100.101.12.7"]
    static let stagedBuild = "2026-09-25T06:20:00Z"
    static let versions = ["built": "2026-09-24T09:12:40Z", "daemon": "0.1.0", "node": "24.21.0",
                           "python": "3.12.14 (python-build-standalone 20260901)", "secret-gate": "0.1.0", "mitmproxy": "12.2.3"]

    /// `fresh`: no phone online and no tailnet address (Tailscale not connected yet).
    static func remote(fresh: Bool) -> RemoteInfo {
        RemoteInfo(port: 4713, fingerprint: fingerprint, lan: lan, tailnet: fresh ? [] : tailnet, bonjour: bonjourName,
                   name: computerName, onlineDevices: fresh ? 0 : 1)
    }

    static let tailscale = TailscaleStatus(state: .running, binary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                                           backendState: "Running", dnsName: "macbook.tail2c41.ts.net", ipv4: tailnet)
    /// A Mac on its first run: Tailscale installed but not connected.
    static let tailscaleStopped = TailscaleStatus(state: .stopped, binary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                                                  backendState: "Stopped", dnsName: nil, ipv4: [])

    static func devices(now: Date) -> [Device] {
        [Device(id: "dev-1", name: "小林的 iPhone", platform: "ios", createdAt: now.addingTimeInterval(-5 * 86_400),
                lastSeenAt: now.addingTimeInterval(-120), revokedAt: nil, online: true,
                files: FileScope(mode: .folders, folders: ["\(NSHomeDirectory())/Projects/lumen", "\(NSHomeDirectory())/Documents"])),
         Device(id: "dev-2", name: "旧 iPhone 13", platform: "ios", createdAt: now.addingTimeInterval(-40 * 86_400),
                lastSeenAt: now.addingTimeInterval(-21 * 86_400), revokedAt: now.addingTimeInterval(-20 * 86_400), online: false)]
    }

    /// docs/mesh-v0.md: this Mac with two nodes — a Mac mini, both ways, with something waiting there; a Studio that
    /// went offline, which this Mac uses and which does not use it back — and the devices that go with them.
    static let nodeList = NodeList(own: NodeSelf(name: computerName, fingerprint: fingerprint, port: 4713), nodes: [
        NodeStatus(id: "7f3a19c2e804", name: "Mac mini", fingerprint: "7f3a19c2e80455b1" + String(repeating: "0", count: 48), lan: ["192.168.1.30"],
                   tailnet: ["mac-mini.tail2c41.ts.net"], state: .online, address: "192.168.1.30", waiting: 1, deviceId: "d-there", inbound: "dev-3"),
        NodeStatus(id: "0937184ad0d9", name: "Mac Studio", fingerprint: "0937184ad0d9" + String(repeating: "1", count: 52), lan: ["192.168.1.41"],
                   state: .offline, deviceId: "d-studio", inbound: nil),
    ])

    static func nodeDevices(now: Date) -> [Device] {
        [Device(id: "dev-3", name: "Mac mini", platform: "macos", createdAt: now.addingTimeInterval(-2 * 86_400),
                lastSeenAt: now.addingTimeInterval(-20), revokedAt: nil, online: true, files: .home)] + devices(now: now)
    }

    static func path(home: String) -> String {
        "/opt/homebrew/bin:\(home)/.local/bin:\(home)/.opencode/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    }

    static func harnesses(home: String) -> [HarnessReport] {
        [HarnessEvaluator.evaluate(HarnessFacts(harness: .claude, binary: "\(home)/.local/bin/claude",
                                                versionOutput: "2.1.278 (Claude Code)", loginEvidence: "钥匙串条目 Claude Code-credentials")),
         HarnessEvaluator.evaluate(HarnessFacts(harness: .codex, binary: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
                                                versionOutput: "codex-cli 0.155.0", loginEvidence: "\(home)/.codex/auth.json")),
         HarnessEvaluator.evaluate(HarnessFacts(harness: .opencode, binary: "\(home)/.opencode/bin/opencode",
                                                versionOutput: "2.0.8", loginEvidence: nil))]
    }

    /// First run: Claude Code ready, Codex not installed, OpenCode not logged in.
    static func freshHarnesses(home: String) -> [HarnessReport] {
        [HarnessEvaluator.evaluate(HarnessFacts(harness: .claude, binary: "\(home)/.local/bin/claude",
                                                versionOutput: "2.1.278 (Claude Code)", loginEvidence: "钥匙串条目 Claude Code-credentials")),
         HarnessEvaluator.evaluate(HarnessFacts(harness: .codex, binary: nil, versionOutput: nil, loginEvidence: nil)),
         HarnessEvaluator.evaluate(HarnessFacts(harness: .opencode, binary: "\(home)/.opencode/bin/opencode",
                                                versionOutput: "2.0.8", loginEvidence: nil))]
    }

    /// 设置 › Agents as this Mac was on 2026-10-06 (docs/agents-v0.md §1): Claude Code's own install with two older
    /// versions kept, Codex only in ChatGPT.app, OpenCode and pi each one version behind.
    static func agents(home: String) -> [AgentReport] {
        let layout = AgentLayout(home: home)
        return [
            AgentReport(agent: .claude, installs: [
                AgentInstall(agent: .claude, source: .stable, key: "stable", binary: layout.command(.claude), command: "claude",
                             location: "\(layout.programRoot(.claude))/2.1.291", version: "2.1.291", bytes: 233_211_568, channel: "latest"),
            ], leftovers: AgentLeftovers(versions: ["2.1.288", "2.1.289"], paths: ["2.1.288", "2.1.289"].map { "\(layout.programRoot(.claude))/\($0)" }, bytes: 458_871_776)),
            AgentReport(agent: .codex, installs: [
                AgentInstall(agent: .codex, source: .app, key: "app", binary: layout.appCodex[0], location: layout.appCodex[0], version: "0.160.1"),
            ]),
            AgentReport(agent: .opencode, installs: [
                AgentInstall(agent: .opencode, source: .stable, key: "stable", binary: layout.command(.opencode), command: "opencode",
                             location: layout.command(.opencode), version: "2.0.18", bytes: 178_946_960),
            ]),
            AgentReport(agent: .pi, installs: [
                AgentInstall(agent: .pi, source: .stable, key: "stable", binary: layout.command(.pi), command: "pi",
                             location: "\(layout.programRoot(.pi))/install/releases/0.87.1", version: "0.87.1", bytes: 157_286_400),
            ]),
        ]
    }

    /// Everything there can be (agents.html `?s=full`): each vendor's own install, betas with their names on the
    /// command line, a pinned version, Homebrew's OpenCode of the first line.
    static func agentsFull(home: String) -> [AgentReport] {
        let layout = AgentLayout(home: home)
        func stored(_ agent: AgentCLI, _ source: AgentSource, _ version: String, _ bytes: Int64) -> AgentInstall {
            AgentInstall(agent: agent, source: source, key: source == .beta ? "beta" : AgentInstall.pinnedKey(version), binary: layout.launcher(agent, source, version),
                         command: source == .beta ? agent.betaCommand : nil, location: layout.storeVersion(agent, source, version), version: version, bytes: bytes)
        }
        return [
            AgentReport(agent: .claude, installs: [
                AgentInstall(agent: .claude, source: .stable, key: "stable", binary: layout.command(.claude), command: "claude",
                             location: "\(layout.programRoot(.claude))/2.1.285", version: "2.1.285", bytes: 229_255_312, channel: "stable"),
                stored(.claude, .beta, "2.1.291", 233_211_568), stored(.claude, .pinned, "2.1.270", 228_100_000),
            ]),
            AgentReport(agent: .codex, installs: [
                AgentInstall(agent: .codex, source: .stable, key: "stable", binary: layout.command(.codex), command: "codex",
                             location: layout.programRoot(.codex), version: "0.160.1", bytes: 310_400_000),
                AgentInstall(agent: .codex, source: .app, key: "app", binary: layout.appCodex[0], location: layout.appCodex[0], version: "0.160.1"),
                stored(.codex, .beta, "0.162.0-alpha.15", 312_000_000),
            ]),
            AgentReport(agent: .opencode, installs: [
                AgentInstall(agent: .opencode, source: .stable, key: "stable", binary: layout.command(.opencode), command: "opencode",
                             location: layout.command(.opencode), version: "2.0.24", bytes: 179_357_602),
                stored(.opencode, .beta, "0.0.0-beta-19507", 180_200_000),
                AgentInstall(agent: .opencode, source: .other, key: "other:/opt/homebrew/bin/opencode", binary: "/opt/homebrew/bin/opencode",
                             location: "/opt/homebrew/bin/opencode", version: "1.18.34"),
            ]),
            AgentReport(agent: .pi, installs: [
                AgentInstall(agent: .pi, source: .stable, key: "stable", binary: layout.command(.pi), command: "pi",
                             location: "\(layout.programRoot(.pi))/install/releases/1.0.4", version: "1.0.4", bytes: 162_000_000),
            ]),
        ]
    }

    /// Grok and Antigravity (agents-v0 §13): Grok a little behind what it says is newest, Antigravity on what it has
    /// (it does not say); on a fresh Mac neither is installed.
    static func agentExtras(home: String, fresh: Bool = false, full: Bool = false) -> [AgentExtra] {
        if fresh {
            return [
                AgentExtra(id: "grok", title: "Grok", command: "grok", canCheck: true),
                AgentExtra(id: "agy", title: "Antigravity", command: "agy", canCheck: false),
            ]
        }
        return [
            AgentExtra(id: "grok", title: "Grok", command: "grok", binary: "\(home)/.grok/bin/grok",
                       version: full ? "1.0.90" : "1.0.92", latest: "1.0.93", canCheck: true),
            AgentExtra(id: "agy", title: "Antigravity", command: "agy", binary: "\(home)/.local/bin/agy",
                       version: full ? "1.5.16" : "1.5.17", canCheck: false),
        ]
    }

    static let agentReleases = AgentReleaseInfo(channels: [
        "claude-code": AgentChannels(stable: "2.1.285", beta: "2.1.291"), "codex": AgentChannels(stable: "0.160.1", beta: "0.162.0-alpha.16"),
        "opencode": AgentChannels(stable: "2.0.24", beta: "0.0.0-beta-19507"), "pi": AgentChannels(stable: "1.0.4"),
    ], checkedAt: Date(timeIntervalSinceNow: -120))

    /// `GET /quota`, read two minutes ago (docs/ui-v0.md §4.2): Claude Code's two windows, Codex with no 5h reading and a
    /// 7d one past 90 %, a DeepSeek balance for OpenCode. `fresh`: nothing usable yet (no Claude task seen, Codex not
    /// installed, OpenCode without a key).
    static func quotaJSON(now: Date, fresh: Bool) -> [[String: Any]] {
        let read = (now.timeIntervalSince1970 - 120) * 1000
        func reset(_ hours: Double) -> Double { (now.timeIntervalSince1970 + hours * 3600).rounded() }
        if fresh {
            return [["harness": "claude-code", "fetchedAt": read, "remaining": NSNull(), "detail": ["windows": [Any](), "windowsAgeMs": NSNull()],
                     "source": "no windows seen yet", "error": NSNull()],
                    ["harness": "codex", "fetchedAt": read, "remaining": NSNull(), "detail": [String: Any](), "source": "codex app-server",
                     "error": "spawn codex ENOENT"],
                    ["harness": "opencode", "fetchedAt": read, "remaining": NSNull(), "detail": [String: Any](), "source": "deepseek /user/balance",
                     "error": "no DeepSeek API key"]]
        }
        return [["harness": "claude-code", "fetchedAt": read, "remaining": 0.18,
                 "detail": ["windows": [["label": "5h", "usedPercent": 20, "resetsAt": reset(2.2)],
                                        ["label": "7d", "usedPercent": 82, "resetsAt": reset(30)],
                                        ["label": "7d opus", "usedPercent": 64, "resetsAt": reset(30)]]],
                 "source": "claude rate_limit_event (subscription windows)", "error": NSNull()],
                ["harness": "codex", "fetchedAt": read, "remaining": 0.09,
                 "detail": ["planType": "pro", "windows": [["label": "7d", "usedPercent": 91, "resetsAt": reset(100)]]],
                 "source": "codex app-server account/rateLimits/read", "error": NSNull()],
                ["harness": "opencode", "fetchedAt": read, "remaining": 1,
                 "detail": ["is_available": true, "balances": [["currency": "CNY", "total": "96.23", "granted": "0.00", "topped_up": "96.23"]]],
                 "source": "deepseek /user/balance", "error": NSNull()]]
    }

    static func quota(now: Date, fresh: Bool) -> [QuotaReading] {
        let data = (try? JSONSerialization.data(withJSONObject: quotaJSON(now: now, fresh: fresh))) ?? Data("[]".utf8)
        return (try? QuotaReading.decodeList(data)) ?? []
    }
}

/// The daemon's files as DemoTransport sees them: the work dir, which a PUT changes.
final class DemoBackend: @unchecked Sendable {
    private let lock = NSLock()
    private let home: String
    private var workDir: String
    private var workDirProblem: String?
    /// Devices the phone list shows; empty on a fresh Mac.
    private var pairedDevices = true
    /// Other nodes are paired with this Mac (the nodes' pictures).
    private var nodes = false

    init(home: String) {
        self.home = home
        workDir = WorkDirSettings.fallbackDefault(home: home)
    }

    func set(workDir path: String, problem: String?) { locked { workDir = path; workDirProblem = problem } }
    func set(pairedDevices: Bool) { locked { self.pairedDevices = pairedDevices } }

    var hasPairedDevices: Bool { locked { pairedDevices } }
    func set(nodes: Bool) { locked { self.nodes = nodes } }
    var hasNodes: Bool { locked { nodes } }

    var workDirJSON: [String: Any] {
        locked { ["path": workDir, "default": WorkDirSettings.fallbackDefault(home: home), "problem": workDirProblem ?? NSNull()] }
    }

    /// The daemon's rule, roughly: not the home folder itself.
    func saveWorkDir(_ path: String?) -> (Int, [String: Any]) {
        guard let path, path.hasPrefix("/") else { return (400, ["error": "路径必须是绝对路径"]) }
        if path == home || path == home + "/" { return (400, ["error": "无法使用主目录本身，请选择其中的子文件夹"]) }
        return locked {
            workDir = path
            workDirProblem = nil
            return (200, ["path": workDir])
        }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// The daemon's management routes, answered from DemoData and DemoBackend (no socket is opened).
struct DemoTransport: HTTPTransport {
    let backend: DemoBackend

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? "/"
        let method = request.httpMethod ?? "GET"
        let sent = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let now = Date()
        var status = 200
        let body: Any
        switch (method, path) {
        case ("GET", "/healthz"): body = ["ok": true, "version": "0.9.0"]
        // The shared browser's engine, for the Environment page's line.
        case ("GET", "/browser/engine"):
            body = ["camoufox": ["installed": ["version": "156.0.1-beta.34"], "ready": true],
                    "playwright": ["active": "bundled", "version": "1.64.0"], "update": ["running": false]]
        case ("GET", "/devices"): body = backend.hasNodes ? DemoData.nodeDevices(now: now).map(Self.json) : backend.hasPairedDevices ? DemoData.devices(now: now).map(Self.json) : []
        case ("GET", "/nodes"): body = Self.nodes(backend.hasNodes ? DemoData.nodeList.nodes : [])
        case ("GET", "/settings/mesh"), ("PUT", "/settings/mesh"): body = ["keyboard": sent["keyboard"] as? Bool ?? true, "files": sent["files"] as? Bool ?? true]
        // A fresh Mac has no paired phone; its usage has no readings either.
        case ("GET", "/quota"): body = DemoData.quotaJSON(now: now, fresh: !backend.hasPairedDevices)
        case ("GET", "/settings/workdir"): body = backend.workDirJSON
        case ("PUT", "/settings/workdir"): (status, body) = backend.saveWorkDir(sent["path"] as? String)
        case ("POST", "/pairing"): body = try Self.pairing(now: now)
        case ("POST", "/local/console-link"): body = ["path": "/"]
        // Settings › Add-Ons (AddonsView): a few made-up profiles and what each has.
        case ("GET", "/profiles"): body = DemoData.profilesJSON
        case ("GET", "/profiles/addons"): body = DemoData.addonsJSON(agent: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "agent" }?.value ?? "claude-code")
        // The Dispatch page: the dispatch as a fresh install has it, turned off.
        case ("GET", "/dispatch/desk"):
            body = ["settings": ["on": false, "agent": "claude-code", "profile": NSNull(), "model": NSNull(), "mode": "bypass", "maxStarted": 8] as [String: Any],
                    "folder": "~/Library/Application Support/AgentSwitch/dispatch", "instructions": "", "room": NSNull(), "terminal": NSNull(), "problem": NSNull(), "replacing": false] as [String: Any]
        default: body = [:] as [String: Any]
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, response)
    }

    private static func json(_ d: Device) -> [String: Any] {
        func ms(_ date: Date?) -> Any { date.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull() }
        var out: [String: Any] = ["id": d.id, "name": d.name, "platform": d.platform, "createdAt": ms(d.createdAt), "lastSeenAt": ms(d.lastSeenAt),
                                  "revokedAt": ms(d.revokedAt), "online": d.online ?? false]
        if let files = d.files { out["files"] = ["mode": files.mode.rawValue, "folders": files.folders] }
        return out
    }

    private static func nodes(_ list: [NodeStatus]) -> [String: Any] {
        ["self": ["name": DemoData.computerName, "kind": "mac", "fingerprint": DemoData.fingerprint, "port": 4713, "listening": true],
         "nodes": list.map { n in
             ["id": n.id, "name": n.name, "kind": n.kind ?? "mac", "fingerprint": n.fingerprint, "port": n.port, "lan": n.lan, "tailnet": n.tailnet,
              "state": n.state.rawValue, "address": n.address ?? NSNull(), "waiting": n.waiting ?? NSNull(), "deviceId": n.deviceId, "inbound": n.inbound ?? NSNull()] as [String: Any]
         }]
    }

    private static func pairing(now: Date) throws -> [String: Any] {
        let payload = PairingPayload(name: DemoData.computerName, port: 4713, fp: DemoData.fingerprint, code: "K7M2Q9XA",
                                     lan: DemoData.lan, tailnet: DemoData.tailnet, bonjour: DemoData.bonjourName,
                                     gate: nil)
        return ["code": "K7M2Q9XA", "expiresAt": now.addingTimeInterval(272).timeIntervalSince1970 * 1000,
                "link": try PairingLink.make(payload)]
    }
}

extension DemoData {
    /// The profiles of the Add-Ons page's demo: `Default`, two with a folder all their own, one that shares `Default`'s.
    static var profilesJSON: [String: Any] {
        func agent(_ profiles: [[String: Any]]) -> [String: Any] { ["current": "default", "creatable": true, "kinds": ["subscription", "api"], "profiles": profiles] }
        let claude: [[String: Any]] = [
            ["id": "default", "name": "Default", "kind": "subscription", "createdAt": 0, "account": "me@example.com"],
            ["id": "abc123def0", "name": "work", "kind": "subscription", "createdAt": 0, "color": "violet", "isolated": true, "account": "work@example.com"],
            ["id": "abc123def1", "name": "lab", "kind": "subscription", "createdAt": 0, "color": "mint", "isolated": true],
            ["id": "abc123def2", "name": "relay", "kind": "api", "createdAt": 0, "color": "sand"],
        ]
        let codex: [[String: Any]] = [
            ["id": "default", "name": "Default", "kind": "subscription", "createdAt": 0, "account": "me@example.com"],
            ["id": "c0dex00001", "name": "team", "kind": "subscription", "createdAt": 0, "color": "violet"],
            ["id": "c0dex00002", "name": "apart", "kind": "subscription", "createdAt": 0, "color": "orchid", "isolated": true],
        ]
        return ["agents": ["claude-code": agent(claude), "codex": agent(codex), "opencode": agent([]), "pi": agent([])]]
    }

    static func addonsJSON(agent: String) -> [String: Any] {
        func mcp(_ name: String, _ command: String, on: Bool = true, secrets: Int = 0, shared: Bool = false, http: Bool = false) -> [String: Any] {
            var item: [String: Any] = ["kind": "mcp", "name": name, "shared": shared, "enabled": on, "transport": http ? "http" : "stdio", "command": command]
            if secrets > 0 { item["secrets"] = secrets }
            return item
        }
        func file(_ kind: String, _ name: String, _ about: String? = nil, shared: Bool = false) -> [String: Any] {
            var item: [String: Any] = ["kind": kind, "name": name, "shared": shared]
            if let about { item["about"] = about }
            return item
        }
        if agent == "codex" {
            let own: [[String: Any]] = [mcp("chrome-devtools", "npx chrome-devtools-mcp@latest"), mcp("linear", "https://mcp.example.com/linear", secrets: 1, http: true), file("skills", "commit-style", "How commits are written here"), file("prompts", "review")]
            return ["agent": agent, "kinds": ["mcp", "skills", "plugins", "prompts", "rules"], "profiles": [
                ["id": "default", "items": own], ["id": "c0dex00001", "items": own.map { $0.merging(["shared": true]) { _, new in new } }],
                ["id": "c0dex00002", "items": [mcp("chrome-devtools", "npx chrome-devtools-mcp@latest", on: false)]],
            ]]
        }
        let pdf = file("skills", "pdf", "Read and fill PDF files"), reviewer = file("agents", "reviewer")
        return ["agent": agent, "kinds": ["mcp", "skills", "plugins", "agents", "commands"], "profiles": [
            ["id": "default", "items": [mcp("chrome-devtools", "npx chrome-devtools-mcp@latest"), mcp("figma", "https://mcp.example.com/figma", secrets: 1, http: true), pdf, file("skills", "xlsx", "Spreadsheets"),
                                        ["kind": "plugins", "name": "status-hud@example-plugins", "shared": false, "enabled": true, "version": "1.4.2"], reviewer, file("commands", "ship")]],
            ["id": "abc123def0", "items": [mcp("chrome-devtools", "npx chrome-devtools-mcp@latest"), mcp("postgres", "uvx mcp-postgres --password •••", on: false, secrets: 1), pdf, file("skills", "release-notes", "This repo’s release steps"), file("agents", "planner")]],
            ["id": "abc123def1", "items": [pdf, reviewer]],
            ["id": "abc123def2", "items": [mcp("chrome-devtools", "npx chrome-devtools-mcp@latest"), file("skills", "pdf", "Read and fill PDF files", shared: true), file("skills", "xlsx", "Spreadsheets", shared: true), file("agents", "reviewer", shared: true), file("commands", "ship", shared: true)]],
        ]]
    }
}
#endif
