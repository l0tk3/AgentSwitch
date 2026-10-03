import Foundation

// The settings window's Dispatch group (docs/dispatch-v0.md §3): Context (context.md, memory.md, platform experience),
// Extensions (MCP servers, skills), Log (the router's decisions). Shapes from daemon api/settings.ts,
// api/extensions.ts, extensions/types.ts, router/log.ts, threads/platformMemory.ts.

/// `GET /context` and `GET /memory`: the file after the daemon's lint (credential-looking plaintext lines removed).
public struct DispatchTextDocument: Decodable, Sendable, Hashable {
    public let path: String?
    public let text: String
    public let warnings: [String]

    public init(path: String?, text: String, warnings: [String] = []) {
        self.path = path
        self.text = text
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(path: c.first(String.self, "path"), text: c.first(String.self, "text") ?? "", warnings: c.first([String].self, "warnings") ?? [])
    }
}

/// One credential the sealer found in a context.md save and replaced with a token (never the value).
public struct DispatchSealedField: Decodable, Sendable, Hashable {
    public let label: String
    public let field: String
    public let hosts: [String]

    public init(label: String, field: String, hosts: [String]) {
        self.label = label
        self.field = field
        self.hosts = hosts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(label: c.first(String.self, "label") ?? "", field: c.first(String.self, "field") ?? "", hosts: c.first([String].self, "hosts") ?? [])
    }
}

/// `PUT /context` and `PUT /memory`: the lint's warnings and (context only) what was sealed.
public struct DispatchSaveResult: Decodable, Sendable, Hashable {
    public let path: String?
    public let warnings: [String]
    public let sealed: [DispatchSealedField]

    public init(path: String? = nil, warnings: [String] = [], sealed: [DispatchSealedField] = []) {
        self.path = path
        self.warnings = warnings
        self.sealed = sealed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(path: c.first(String.self, "path"), warnings: c.first([String].self, "warnings") ?? [],
                  sealed: c.first([DispatchSealedField].self, "sealed") ?? [])
    }

    /// The line after a save (the phone's ContextEditorView): 已保存，2 个凭据已加密（账号密码、令牌），部分行已移除.
    public var savedLine: String {
        var parts = ["已保存"]
        if !sealed.isEmpty { parts.append("\(sealed.count) 个凭据已加密（\(sealed.map(\.field).joined(separator: "、"))）") }
        if !warnings.isEmpty { parts.append("部分行已移除") }
        return parts.joined(separator: "，")
    }
}

/// One sourced platform observation (threads/platformMemory.ts PlatformMemory); deleted one by one on the Context page.
public struct DispatchPlatformMemory: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    /// The site it is about (`https://fin.example.com`).
    public let origin: String
    public let key: String
    public let text: String
    /// `operation` (操作经验) or `incident` (临时事件).
    public let kind: String
    /// `observed` (待验证) or `verified` (已验证).
    public let status: String
    public let sourceTaskId: String
    public let sourceEventSeq: Int
    public let sourceQuote: String
    public let createdAt: Int64
    public let updatedAt: Int64
    public let expiresAt: Int64

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.require(String.self, "id")
        origin = c.first(String.self, "origin") ?? ""
        key = c.first(String.self, "key") ?? ""
        text = c.first(String.self, "text") ?? ""
        kind = c.first(String.self, "kind") ?? "operation"
        status = c.first(String.self, "status") ?? "observed"
        let source = c.first(DispatchJSON.self, "source")
        sourceTaskId = source?["taskId"]?.string ?? ""
        sourceEventSeq = source?["eventSeq"]?.int ?? 0
        sourceQuote = source?["quote"]?.string ?? ""
        createdAt = c.first(Int64.self, "createdAt") ?? 0
        updatedAt = c.first(Int64.self, "updatedAt") ?? 0
        expiresAt = c.first(Int64.self, "expiresAt") ?? 0
    }

    public var kindLabel: String { kind == "incident" ? "临时事件" : "操作经验" }
    public var statusLabel: String { status == "verified" ? "已验证" : "待验证" }
    public func isExpired(now: Date = Date()) -> Bool { Date(dispatchMilliseconds: expiresAt) <= now }
}

struct DispatchPlatformMemoryList: Decodable { let records: [DispatchPlatformMemory] }

/// The harnesses an extension can be given to (extensions/types.ts HARNESSES).
public enum DispatchExtensionHarnesses {
    public static let all = ["claude-code", "codex", "opencode"]
}

/// An MCP server handed to the executors (extensions/types.ts McpServer). `PUT /mcp/:name` takes the whole object (the
/// web console's toggle sends it back with `enabled` flipped). Put `enc:v1:` ciphertexts in `env` / `headers`, never
/// plaintext secrets.
public struct DispatchMCPServer: Codable, Sendable, Hashable, Identifiable {
    public let name: String
    /// `stdio` (needs `command`) or `http` (needs `url`).
    public let kind: String
    public let command: String?
    public let args: [String]
    public let env: [String: String]
    public let url: String?
    public let headers: [String: String]
    public let enabled: Bool
    public let harnesses: [String]
    /// Claude Code only: `ask` (calls need a human) or `allow`.
    public let approval: String
    /// The one line the router reads next to the name.
    public let note: String

    public init(name: String, kind: String, command: String? = nil, args: [String] = [], env: [String: String] = [:],
                url: String? = nil, headers: [String: String] = [:], enabled: Bool = true,
                harnesses: [String] = DispatchExtensionHarnesses.all, approval: String = "ask", note: String = "") {
        self.name = name
        self.kind = kind
        self.command = command
        self.args = args
        self.env = env
        self.url = url
        self.headers = headers
        self.enabled = enabled
        self.harnesses = harnesses
        self.approval = approval
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(name: try c.require(String.self, "name"), kind: c.first(String.self, "kind") ?? "stdio",
                  command: c.first(String.self, "command"), args: c.first([String].self, "args") ?? [],
                  env: c.first([String: String].self, "env") ?? [:], url: c.first(String.self, "url"),
                  headers: c.first([String: String].self, "headers") ?? [:], enabled: c.first(Bool.self, "enabled") ?? true,
                  harnesses: c.first([String].self, "harnesses") ?? DispatchExtensionHarnesses.all,
                  approval: c.first(String.self, "approval") ?? "ask", note: c.first(String.self, "note") ?? "")
    }

    public var id: String { name }

    /// The same server switched on or off.
    public func toggled() -> DispatchMCPServer {
        DispatchMCPServer(name: name, kind: kind, command: command, args: args, env: env, url: url, headers: headers,
                          enabled: !enabled, harnesses: harnesses, approval: approval, note: note)
    }

    /// What it runs or where it is: `npx -y @x/server` or the URL.
    public var endpoint: String {
        kind == "http" ? (url ?? "") : ([command ?? ""] + args).joined(separator: " ")
    }
}

/// A skill in AgentSwitch's own registry (extensions/types.ts Skill).
public struct DispatchSkill: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let description: String
    /// The folder holding its SKILL.md.
    public let path: String
    /// Files in the folder besides SKILL.md.
    public let files: Int
    public let enabled: Bool
    public let harnesses: [String]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        name = try c.require(String.self, "name")
        description = c.first(String.self, "description") ?? ""
        path = c.first(String.self, "path") ?? ""
        files = c.first(Int.self, "files") ?? 0
        enabled = c.first(Bool.self, "enabled") ?? true
        harnesses = c.first([String].self, "harnesses") ?? DispatchExtensionHarnesses.all
    }

    public var id: String { name }
}

/// `GET /skills/:name`: the skill and its SKILL.md.
public struct DispatchSkillDetail: Decodable, Sendable, Hashable {
    public let skill: DispatchSkill
    public let content: String

    public init(from decoder: Decoder) throws {
        skill = try DispatchSkill(from: decoder)
        content = try decoder.container(keyedBy: AnyKey.self).first(String.self, "content") ?? ""
    }
}

/// `PUT /skills/:name`: a new SKILL.md, a switch, the harnesses; what is left nil stays as it is.
public struct DispatchSkillUpdate: Encodable, Sendable, Hashable {
    public let content: String?
    public let enabled: Bool?
    public let harnesses: [String]?

    public init(content: String? = nil, enabled: Bool? = nil, harnesses: [String]? = nil) {
        self.content = content
        self.enabled = enabled
        self.harnesses = harnesses
    }
}

/// A skill found in the user's own agent folders (`GET /skills/discover`), to import with `POST /skills/import`.
public struct DispatchDiscoveredSkill: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let description: String
    public let path: String
    /// Where it was found (`~/.claude/skills`).
    public let source: String
    public let installed: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        name = try c.require(String.self, "name")
        description = c.first(String.self, "description") ?? ""
        path = c.first(String.self, "path") ?? ""
        source = c.first(String.self, "source") ?? ""
        installed = c.first(Bool.self, "installed") ?? false
    }

    public var id: String { path }
}

/// One row of `GET /routing/log` (router/log.ts LogEntry): a dispatch, re-dispatch or preview, newest first.
public struct DispatchRoutingLogEntry: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let ts: Int64
    public let taskId: String?
    public let cwd: String
    /// `pin`, `router` or `default`: where the target came from.
    public let source: String
    public let harness: String?
    public let model: String?
    /// The router's Decision as JSON text; nil when it made none (a pin).
    public let decision: String?
    public let notes: String
    public let routerError: String?
    public let routerMs: Int
    /// How the dispatch ended (`done`, `failed:refusal`, …), once known.
    public let outcome: String?
    public let rating: Int?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.require(Int.self, "id")
        ts = c.first(Int64.self, "ts") ?? 0
        taskId = c.first(String.self, "taskId")
        cwd = c.first(String.self, "cwd") ?? ""
        source = c.first(String.self, "source") ?? ""
        harness = c.first(String.self, "harness")
        model = c.first(String.self, "model")
        decision = c.first(String.self, "decision")
        notes = c.first(String.self, "notes") ?? ""
        routerError = c.first(String.self, "routerError")
        routerMs = c.first(Int.self, "routerMs") ?? 0
        outcome = c.first(String.self, "outcome")
        rating = c.first(Int.self, "rating")
    }

    public var date: Date { Date(dispatchMilliseconds: ts) }
    public var target: DispatchTarget? {
        guard let harness, let model else { return nil }
        return DispatchTarget(harness: harness, model: model)
    }

    /// The decision's own words (`reason`), for the row; the whole decision opens on a click (`decisionText`).
    public var reason: String? {
        guard let data = decision?.data(using: .utf8), let json = try? JSONDecoder().decode(DispatchJSON.self, from: data) else { return nil }
        return json["reason"]?.string.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The decision as the web console shows it (`DispatchJSON.prettyText`), or as stored when it is not JSON.
    public var decisionText: String? {
        guard let decision else { return nil }
        guard let data = decision.data(using: .utf8), let json = try? JSONDecoder().decode(DispatchJSON.self, from: data) else {
            return decision
        }
        return json.prettyText()
    }

    /// How long the router took: `1.2s`; nil for a pin.
    public var routerTime: String? { routerMs > 0 ? String(format: "%.1fs", Double(routerMs) / 1000) : nil }
}
