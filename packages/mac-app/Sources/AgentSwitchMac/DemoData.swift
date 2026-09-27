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

    static let keys = [
        Keypair(name: "default", public: "_nzdpiOxlAndoW9gDWmE3d85lFS0fU1wnJCM7bqniLQ", current: true),
        Keypair(name: "work", public: "9KWoi82pap7LTaiAZw4yb04mBDBtT2aJLAj1yN88dCA", current: false),
    ]

    /// After the service install (gate-service-v0 §5): `main` new and current, the migrated keys decrypt-only.
    static let serviceKeys = [
        Keypair(name: "main", public: "Q2x7mV0pT9cWfL3aRk8uN5eYh1sJd6gBzO4iPq7tXwE", current: true),
        Keypair(name: "default", public: "_nzdpiOxlAndoW9gDWmE3d85lFS0fU1wnJCM7bqniLQ", current: false, legacy: true),
        Keypair(name: "work", public: "9KWoi82pap7LTaiAZw4yb04mBDBtT2aJLAj1yN88dCA", current: false, legacy: true),
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
        迁移密钥 default、work → gate/keys/legacy/
        新建密钥对 main 并设为当前
        生成网关证书，发布 gate-public/ca.pem
        启动 com.agentswitch.gate.rpc、com.agentswitch.gate.proxy
        """
    static let installFailedOutput = """
        已完成：创建系统账户 _agentswitchgate（uid 451）
        已完成：复制程序
        未完成：迁移密钥、新建密钥对、生成网关证书、启动服务
        无法移动 ~/.secret-gate/keys/work：目标位置已存在同名密钥
        """

    /// `logs tail` as the service would answer it.
    static func gateLog(_ name: GateLogName) -> String {
        switch name {
        case .proxy:
            return """
            2026-09-27 14:02:11 proxy listening on 127.0.0.1:8080 (keys: main + 2 legacy)
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
                lastSeenAt: now.addingTimeInterval(-120), revokedAt: nil, online: true),
         Device(id: "dev-2", name: "旧 iPhone 13", platform: "ios", createdAt: now.addingTimeInterval(-40 * 86_400),
                lastSeenAt: now.addingTimeInterval(-21 * 86_400), revokedAt: now.addingTimeInterval(-20 * 86_400), online: false)]
    }

    static func path(home: String) -> String {
        "/opt/homebrew/bin:\(home)/.local/bin:\(home)/.opencode/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    }

    static func harnesses(home: String) -> [HarnessReport] {
        [HarnessEvaluator.evaluate(HarnessFacts(harness: .claude, binary: "\(home)/.local/bin/claude",
                                                versionOutput: "2.1.278 (Claude Code)", loginEvidence: "钥匙串条目 Claude Code-credentials")),
         HarnessEvaluator.evaluate(HarnessFacts(harness: .codex, binary: "/Applications/ChatGPT.app/Contents/Resources/codex",
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

    init(home: String) {
        self.home = home
        workDir = WorkDirSettings.fallbackDefault(home: home)
    }

    func set(mode: ApprovalMode) { locked { self.mode = mode.rawValue } }
    func set(workDir path: String, problem: String?) { locked { workDir = path; workDirProblem = problem } }
    func set(pairedDevices: Bool) { locked { self.pairedDevices = pairedDevices } }

    var hasPairedDevices: Bool { locked { pairedDevices } }

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
        case ("GET", "/devices"): body = backend.hasPairedDevices ? DemoData.devices(now: now).map(Self.json) : []
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
        default: body = [:] as [String: Any]
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (data, response)
    }

    private static func json(_ d: Device) -> [String: Any] {
        func ms(_ date: Date?) -> Any { date.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull() }
        return ["id": d.id, "name": d.name, "platform": d.platform, "createdAt": ms(d.createdAt), "lastSeenAt": ms(d.lastSeenAt),
                "revokedAt": ms(d.revokedAt), "online": d.online ?? false]
    }

    private static func pairing(now: Date) throws -> [String: Any] {
        let payload = PairingPayload(name: DemoData.computerName, port: 4713, fp: DemoData.fingerprint, code: "K7M2Q9XA",
                                     lan: DemoData.lan, tailnet: DemoData.tailnet, bonjour: DemoData.bonjourName,
                                     gate: .init(publicKey: DemoData.keys[0].public, keypair: DemoData.keys[0].name))
        return ["code": "K7M2Q9XA", "expiresAt": now.addingTimeInterval(272).timeIntervalSince1970 * 1000,
                "link": try PairingLink.make(payload)]
    }
}
#endif
