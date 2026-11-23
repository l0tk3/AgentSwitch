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

    /// The one keypair (gate-simple-v0 §1) of the user-process gate.
    static let keys = [
        Keypair(name: "default", public: "_nzdpiOxlAndoW9gDWmE3d85lFS0fU1wnJCM7bqniLQ", created: "2026-09-20T03:41:00Z"),
    ]

    /// The service's own key, made fresh at install: nothing is taken from the user's home.
    static let serviceKeys = [
        Keypair(name: "main", public: "Q2x7mV0pT9cWfL3aRk8uN5eYh1sJd6gBzO4iPq7tXwE", created: "2026-11-23T06:12:00Z"),
    ]

    /// The installed gate program (`<secret-gate>+<built>`, as `system install` records it), and an earlier build for
    /// the update state.
    static let installedGateBuild = "0.1.0+2026-09-24T09:12:40Z"
    static let olderGateBuild = "0.1.0+2026-09-20T03:41:10Z"

    static func gateService(installed: Bool, running: Bool = true, runtimeVersion: String? = nil) -> GateServiceState {
        GateServiceState(availability: installed ? .installed : .notInstalled, running: installed ? running : false,
                         socketPresent: installed, proxyPort: installed ? 8080 : nil, runtimeVersion: runtimeVersion,
                         ownerUid: installed ? Int(getuid()) : nil, problem: nil)
    }

    /// What `system install` prints, and a run that stopped half-way (gate-service-v0 §5.7: done and not done steps).
    static let installOutput = """
        创建系统账户 _agentswitchgate（uid 451）
        复制程序到 /Library/Application Support/AgentSwitch/runtime
        生成密钥对 main
        生成网关证书，发布 gate-public/ca.pem
        启动 com.agentswitch.gate.rpc、com.agentswitch.gate.proxy
        """
    static let installFailedOutput = """
        已完成：创建系统账户 _agentswitchgate（uid 451）
        已完成：复制程序
        未完成：生成密钥对、生成网关证书、启动服务
        无法创建 /Library/Application Support/AgentSwitch/gate/keys：设备上没有空间
        """

    /// `logs tail` as the service would answer it.
    static func gateLog(_ name: GateLogName) -> String {
        switch name {
        case .proxy:
            return """
            2026-09-27 14:02:11 proxy listening on 127.0.0.1:8080 (key: main)
            2026-09-27 14:05:37 api.github.com POST /repos/…/issues  enc:ref:3 → header Authorization (task 7f2c)
            2026-09-27 14:05:38 api.github.com 201
            2026-09-27 14:20:02 SIGHUP: reloaded upstream exceptions and keys
            2026-09-27 14:31:45 denied: enc:ref:9 host not allowed (example.org)
            """
        case .rpc:
            return """
            2026-09-27 14:02:10 rpc listening on /Library/Application Support/AgentSwitch/gate-public/gate.sock
            2026-09-27 14:02:12 uid 501 status ok
            2026-09-27 14:05:36 uid 501 refs.register scope=task-7f2c tokens=1 ok
            2026-09-27 14:20:01 uid 501 keys.new name=travel ok
            2026-09-27 14:40:12 uid 501 refs.release scope=task-7f2c released=1
            """
        }
    }

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

    static let agentReleases = AgentReleaseInfo(channels: [
        "claude-code": AgentChannels(stable: "2.1.285", beta: "2.1.291"), "codex": AgentChannels(stable: "0.160.1", beta: "0.162.0-alpha.16"),
        "opencode": AgentChannels(stable: "2.0.24", beta: "0.0.0-beta-19507"), "pi": AgentChannels(stable: "1.0.4"),
    ], checkedAt: Date(timeIntervalSinceNow: -120))

    /// The daemon's categories (engine/approvalPolicy.ts CATEGORY_TITLES).
    static let categories: [[String: String]] = [
        ["id": "delete", "title": "删除文件或数据（rm、git clean、DROP/DELETE）"],
        ["id": "outside_cwd", "title": "写入工作目录以外的文件"],
        ["id": "shell", "title": "任何 shell 命令"],
        ["id": "git_push", "title": "git push / 强制推送"],
        ["id": "irreversible", "title": "支付、发送消息或邮件、删除账号"],
        ["id": "browser", "title": "浏览器中的提交操作"],
    ]

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

    static var modelSettings: [String: Any] { [
        "router": ["model": "deepseek/deepseek-flash", "options": ["deepseek/deepseek-flash", "claude-haiku-4-5-20251001"]],
        "default": ["harness": "claude-code", "model": "claude-sonnet-4-6"],
        "harnesses": [
            "claude-code": ["default_model": "claude-sonnet-4-6",
                            "models": ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-4-8",
                                       "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]],
            "codex": ["default_model": "gpt-6-astra", "models": ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"]],
            "opencode": ["default_model": "deepseek/deepseek-flash", "models": ["deepseek/deepseek-flash"]],
        ],
        "restartRequired": false,
    ] }
}

/// The credential gate in the design preview (docs/gate-service-v0.md): the user process before the service, the
/// service installed, and the states in between.
enum DemoGate: Equatable {
    case notInstalled, installing, installed, justInstalled, notResponding, updateAvailable

    var installed: Bool { ![.notInstalled, .installing].contains(self) }
}

/// The daemon's files as DemoTransport sees them: the approval policy and the work dir, which PUTs change.
final class DemoBackend: @unchecked Sendable {
    private let lock = NSLock()
    private let home: String
    private var mode = "scoped"
    private var human = ["delete", "git_push", "irreversible"]
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

    func set(mode: ApprovalMode) { locked { self.mode = mode.rawValue } }
    func set(workDir path: String, problem: String?) { locked { workDir = path; workDirProblem = problem } }
    func set(pairedDevices: Bool) { locked { self.pairedDevices = pairedDevices } }

    var hasPairedDevices: Bool { locked { pairedDevices } }
    func set(nodes: Bool) { locked { self.nodes = nodes } }
    var hasNodes: Bool { locked { nodes } }

    var policy: [String: Any] {
        locked { ["policy": ["mode": mode, "human": human], "categories": DemoData.categories] }
    }

    func savePolicy(_ body: [String: Any]) -> [String: Any] {
        locked {
            mode = body["mode"] as? String ?? mode
            human = body["human"] as? [String] ?? human
            return ["policy": ["mode": mode, "human": human]]
        }
    }

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
        case ("GET", "/settings/models"): body = DemoData.modelSettings
        // A fresh Mac has no paired phone; its usage has no readings either.
        case ("GET", "/quota"): body = DemoData.quotaJSON(now: now, fresh: !backend.hasPairedDevices)
        case ("PUT", "/settings/models"): body = ["restartRequired": true]
        case ("GET", "/approvals/policy"): body = backend.policy
        case ("PUT", "/approvals/policy"): body = backend.savePolicy(sent)
        case ("GET", "/settings/workdir"): body = backend.workDirJSON
        case ("PUT", "/settings/workdir"): (status, body) = backend.saveWorkDir(sent["path"] as? String)
        case ("POST", "/pairing"): body = try Self.pairing(now: now)
        case ("POST", "/local/console-link"): body = ["path": "/"]
        // Settings › Add-Ons (AddonsView): a few made-up profiles and what each has.
        case ("GET", "/profiles"): body = DemoData.profilesJSON
        case ("GET", "/profiles/addons"): body = DemoData.addonsJSON(agent: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "agent" }?.value ?? "claude-code")
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
                                     gate: .init(publicKey: DemoData.keys[0].public, keypair: DemoData.keys[0].name))
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
