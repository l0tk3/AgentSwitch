import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// The settings window's Dispatch group: what its pages decide besides drawing (DispatchSettingsRules.swift).
final class DispatchSettingsRulesTests: XCTestCase {
    private func logRow(_ fields: [String: Any]) throws -> DispatchRoutingLogEntry {
        var object: [String: Any] = ["id": 1, "ts": 0, "cwd": "/w", "source": "router", "notes": "", "routerMs": 0]
        object.merge(fields) { $1 }
        return try DispatchFixture.decode(DispatchRoutingLogEntry.self, object: object)
    }

    func testLogSegments() throws {
        let dispatched = try logRow(["harness": "codex", "model": "gpt-5.5", "decision": #"{"action":"redispatch","reason":"x"}"#])
        let pinned = try logRow(["source": "pin", "harness": "codex", "model": "gpt-5.5"])
        let asked = try logRow(["decision": #"{"action":"clarify","question":"哪个账号？"}"#])
        let gaveUp = try logRow(["decision": #"{"action":"give_up","reason":"无法完成"}"#])
        let failed = try logRow(["routerError": "timeout"])
        XCTAssertEqual([dispatched, pinned, asked, gaveUp, failed].map(\.verdict), [.dispatched, .dispatched, .answered, .refused, .refused])
        XCTAssertEqual(asked.action, "clarify")
        XCTAssertNil(pinned.action, "a pin has no decision")
        XCTAssertTrue(DispatchRoutingLogFilter.all.matches(gaveUp))
        XCTAssertTrue(DispatchRoutingLogFilter.refused.matches(failed))
        XCTAssertFalse(DispatchRoutingLogFilter.dispatched.matches(asked))
        XCTAssertEqual(DispatchRoutingLogFilter.allCases.map(\.title), ["All", "Dispatched", "Answered", "Refused"])
    }

    func testLogColumns() throws {
        XCTAssertEqual(try logRow(["source": "pin"]).sourceWord, "Pinned")
        XCTAssertEqual(try logRow(["source": "router"]).sourceWord, "Auto")
        XCTAssertEqual(try logRow(["source": "default"]).sourceWord, "Default")
        XCTAssertEqual(try logRow(["source": "later"]).sourceWord, "later", "an unknown source as stored")

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)   // 2026-09-21 14:13 UTC
        let today = try logRow(["ts": Int64(1_789_999_000) * 1000])
        let before = try logRow(["ts": Int64(1_789_900_000) * 1000])
        XCTAssertEqual(today.timeColumn(now: now, calendar: calendar), "13:56")
        XCTAssertEqual(before.timeColumn(now: now, calendar: calendar), "9/20")
    }

    func testTopicHueIsTheWebConsoles() {
        // Values from ui/lib/sidebar.js topicHue, run under node.
        XCTAssertEqual(DispatchTopicHue.hex(for: "t1"), 0xD8C28F)
        XCTAssertEqual(DispatchTopicHue.hex(for: "th_01HZX9Q"), 0xB9A0E8)
        XCTAssertEqual(DispatchTopicHue.hex(for: "0b6f3c2e-9d1a-4c55-8a7e-1f2d3c4b5a69"), 0x8FD8C4)
        XCTAssertEqual(DispatchTopicHue.hex(for: "话题😀abc"), 0xB9A0E8, "outside the BMP: the first UTF-16 unit, as charCodeAt(0)")
        XCTAssertEqual(DispatchTopicHue.hex(for: ""), 0x9FB4FF)
    }

    func testContextSize() {
        XCTAssertEqual(DispatchFileSize.text(bytes: 1023), "1023 B")
        XCTAssertEqual(DispatchFileSize.text(bytes: 1229), "1.2 KB")
        XCTAssertEqual(DispatchFileSize.ofContextLimit(String(repeating: "a", count: 1229)), "1.2 KB / 64 KB")
        XCTAssertEqual(DispatchFileSize.ofContextLimit("密码"), "6 B / 64 KB", "bytes, not characters")
        XCTAssertFalse(DispatchFileSize.exceedsContextLimit(String(repeating: "a", count: 64 * 1024)))
        XCTAssertTrue(DispatchFileSize.exceedsContextLimit(String(repeating: "a", count: 64 * 1024 + 1)))
    }

    func testExperienceWords() throws {
        func record(_ kind: String, _ status: String, expires: Int64) throws -> DispatchPlatformMemory {
            try DispatchFixture.decode(DispatchPlatformMemory.self, object: ["id": "m", "kind": kind, "status": status, "expiresAt": expires,
                                                                              "updatedAt": 1000])
        }
        let now = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(try record("operation", "verified", expires: 200_000).stateWord(now: now), "Verified")
        XCTAssertEqual(try record("operation", "observed", expires: 200_000).stateWord(now: now), "Pending")
        XCTAssertEqual(try record("operation", "verified", expires: 50_000).stateWord(now: now), "Expired")
        XCTAssertEqual(try record("incident", "observed", expires: 0).kindWord, "Incident")
        XCTAssertEqual(try record("operation", "observed", expires: 0).kindWord, "Operation")
        XCTAssertEqual(try record("operation", "observed", expires: 200_000).expires, Date(timeIntervalSince1970: 200))
    }

    func testExtensionNames() {
        XCTAssertTrue(DispatchExtensionName.isValid("github"))
        XCTAssertTrue(DispatchExtensionName.isValid("0-db_local"))
        XCTAssertFalse(DispatchExtensionName.isValid("GitHub"))
        XCTAssertFalse(DispatchExtensionName.isValid("-x"))
        XCTAssertFalse(DispatchExtensionName.isValid(String(repeating: "a", count: 65)))
        XCTAssertNotNil(DispatchExtensionName.problem("", reservedApplies: false))
        XCTAssertNotNil(DispatchExtensionName.problem("playwright", reservedApplies: true))
        XCTAssertNil(DispatchExtensionName.problem("playwright", reservedApplies: false), "a skill may use the name")
    }

    func testKeyValueLines() {
        let pairs = DispatchKeyValueLines.parse(" A = 1 \n\nURL=https://x/?a=b\nFLAG\n", separator: "=")
        XCTAssertEqual(pairs.map(\.key), ["A", "URL", "FLAG"])
        XCTAssertEqual(pairs.map(\.value), ["1", "https://x/?a=b", ""], "split at the first separator")
        XCTAssertEqual(DispatchKeyValueLines.format(["B": "2", "A": "1"], separator: "="), "A=1\nB=2")
        XCTAssertEqual(DispatchKeyValueLines.map(DispatchKeyValueLines.parse("A=1\nA=2", separator: "=")), ["A": "2"])
    }

    func testMCPDraftRoundTripsAServer() {
        let server = DispatchMCPServer(name: "github", kind: "stdio", command: "npx", args: ["-y", "@x/server"],
                                       env: ["GITHUB_TOKEN": "enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l", "LOG": "debug"], enabled: false,
                                       harnesses: ["codex", "claude-code"], approval: "allow", note: "issues")
        var draft = DispatchMCPServerDraft(server)
        XCTAssertFalse(draft.isNew)
        XCTAssertEqual(draft.arguments, "-y\n@x/server")
        XCTAssertEqual(draft.environment, "GITHUB_TOKEN=enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l\nLOG=debug")
        XCTAssertEqual(draft.problems, [])
        let saved = draft.server()
        XCTAssertEqual(saved.harnesses, ["claude-code", "codex"], "in the daemon's order")
        XCTAssertEqual(saved.env, server.env)
        XCTAssertFalse(saved.enabled, "kept as it was")
        XCTAssertNil(saved.url)
        draft.kind = "http"
        draft.url = "https://mcp.example.com/sse"
        draft.headers = "Authorization: Bearer enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l"
        XCTAssertEqual(draft.problems, [])
        let http = draft.server()
        XCTAssertNil(http.command, "only the chosen kind's fields")
        XCTAssertEqual(http.args, [])
        XCTAssertEqual(http.env, [:])
        XCTAssertEqual(http.headers, ["Authorization": "Bearer enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l"])
    }

    func testMCPDraftChecks() {
        var draft = DispatchMCPServerDraft()
        XCTAssertTrue(draft.isNew)
        XCTAssertEqual(draft.harnesses, DispatchExtensionHarnesses.all)
        XCTAssertEqual(draft.problems.count, 2, "a name and a command")
        draft.name = "secret-gate"
        draft.command = "npx"
        XCTAssertEqual(draft.problems.count, 1, "reserved")
        draft.name = "db"
        draft.environment = "DB_PASSWORD=hunter2\nOPENAI_API_KEY=sk-1\nKEYBOARD=us\n=x"
        let problems = draft.problems
        XCTAssertTrue(problems.contains { $0.contains("DB_PASSWORD、OPENAI_API_KEY") }, "\(problems)")
        XCTAssertTrue(problems.contains { $0.contains("KEY=VALUE") })
        draft.environment = "DB_PASSWORD=enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l\nKEYBOARD=us"
        XCTAssertEqual(draft.problems, [])
        draft.kind = "http"
        draft.url = "ftp://x"
        XCTAssertEqual(draft.problems.count, 1)
        draft.url = "https://"
        XCTAssertEqual(draft.problems.count, 1, "a host too")
        draft.url = "http://127.0.0.1:9000/mcp"
        draft.headers = "X-Api-Key: plain"
        XCTAssertEqual(draft.problems.count, 1)
        draft.headers = ""
        draft.note = String(repeating: "x", count: 501)
        XCTAssertEqual(draft.problems.count, 1)
    }

    func testCredentialNames() {
        for key in ["GITHUB_TOKEN", "OPENAI_API_KEY", "Authorization", "X-Api-Key", "db.password", "COOKIE",
                    // Anywhere in the name, case aside.
                    "accessToken", "clientSecret", "PGPASSWORD", "GITHUBTOKEN", "apiKey", "privateKey", "SSH_PASSPHRASE",
                    "MYSQL_PWD", "GITHUB_PAT", "x-auth", "AWS_SECRET_ACCESS_KEY", "refresh_token", "Proxy-Authorization"] {
            XCTAssertTrue(DispatchMCPServerDraft.namesCredential(key), key)
        }
        for key in ["KEYBOARD", "AUTHOR", "LOG_LEVEL", "PATH", "Accept", "MAX_TOKENS", "TOKENIZERS_PARALLELISM", "PASSPORT_DIR",
                    "COMPASS", "monkey", "keycloak_url"] {
            XCTAssertFalse(DispatchMCPServerDraft.namesCredential(key), key)
        }
        XCTAssertEqual(DispatchCredentialCheck.words(of: "X-Api-Key"), ["X", "API", "KEY"])
        XCTAssertEqual(DispatchCredentialCheck.words(of: "privateKey2fa"), ["PRIVATE", "KEY2FA"])
        XCTAssertEqual(DispatchCredentialCheck.words(of: "db.passWord"), ["DB", "PASS", "WORD"])
    }

    /// A credential is one whole ciphertext (or a reference to a variable that holds one), never plaintext beside it.
    func testCiphertextIsTheWholeValue() {
        let token = "enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l"
        XCTAssertTrue(DispatchCredentialCheck.isCiphertext(token))
        XCTAssertTrue(DispatchCredentialCheck.isCiphertext("${GITHUB_TOKEN}"))
        XCTAssertTrue(DispatchCredentialCheck.isCiphertext("$GITHUB_TOKEN"))
        for value in ["hunter2 \(token)", "\(token)x!", "enc:v1:short", "Bearer \(token)", "\(token) \(token)", "enc:v1:"] {
            XCTAssertFalse(DispatchCredentialCheck.isCiphertext(value), value)
        }
        XCTAssertTrue(DispatchCredentialCheck.isHeaderCiphertext("Bearer \(token)"))
        XCTAssertTrue(DispatchCredentialCheck.isHeaderCiphertext("token \(token)"))
        XCTAssertTrue(DispatchCredentialCheck.isHeaderCiphertext(token))
        XCTAssertFalse(DispatchCredentialCheck.isHeaderCiphertext("Basic \(token)"))
        XCTAssertFalse(DispatchCredentialCheck.isHeaderCiphertext("Bearer sk-live-1 \(token)"))
    }

    func testPlaintextInVariablesHeadersAndURLs() {
        let token = "enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l"
        XCTAssertEqual(DispatchCredentialCheck.plaintextVariables([
            ("accessToken", "abc"), ("PGPASSWORD", "x \(token)"), ("GITHUB_TOKEN", token), ("MAX_TOKENS", "4096"), ("EMPTY_TOKEN", ""),
            ("DATABASE_URL", "postgres://app:hunter2@db:5432/app"), ("SAFE_URL", "postgres://app:\(token)@db/app"),
            ("SITE", "https://x.example/?api_key=sk-1"), ("LOG", "debug"),
        ]), ["accessToken", "PGPASSWORD", "DATABASE_URL", "SITE"])
        XCTAssertEqual(DispatchCredentialCheck.plaintextHeaders([
            ("Authorization", "Bearer sk-1"), ("X-Api-Key", "Bearer \(token)"), ("Cookie", "sid=1"), ("Accept", "text/plain"),
        ]), ["Authorization", "Cookie"])
        XCTAssertTrue(DispatchCredentialCheck.urlHoldsPlaintext("https://mcp.example.com/sse?token=abc"))
        XCTAssertTrue(DispatchCredentialCheck.urlHoldsPlaintext("https://user:p%40ss@mcp.example.com/sse"))
        XCTAssertFalse(DispatchCredentialCheck.urlHoldsPlaintext("https://mcp.example.com/sse?token=\(token)&limit=5"))
        XCTAssertFalse(DispatchCredentialCheck.urlHoldsPlaintext("https://user@mcp.example.com/sse"), "a user name alone")
        XCTAssertFalse(DispatchCredentialCheck.urlHoldsPlaintext("@modelcontextprotocol/server-github"))
    }

    func testPlaintextInArguments() {
        let token = "enc:v1:QWxhZGRpbjpvcGVuc2VzYW1l"
        XCTAssertEqual(DispatchCredentialCheck.plaintextArguments([
            "-y", "@x/server", "--token=abc", "--password", "hunter2", "--api-key", token, "--no-auth", "server.js",
            "-e", "GITHUB_TOKEN=ghp_1", "Authorization: Bearer sk-1", "--header", "X-Trace: 1", "--secret=\(token)",
            "--connection", "mysql://root:pw@localhost/db", "--client-secret", "${CLIENT_SECRET}", "--token",
        ]), ["--token", "--password", "GITHUB_TOKEN", "Authorization", "第 17 个参数"])
        XCTAssertEqual(DispatchCredentialCheck.plaintextArguments(["--auth", "--verbose"]), [], "a switch followed by another")
    }

    func testMCPDraftRefusesPlaintextAndANameInUse() {
        var draft = DispatchMCPServerDraft()
        draft.name = "github"
        draft.command = "npx"
        draft.arguments = "-y\n@x/server\n--token\nghp_1"
        draft.environment = "accessToken=abc\nMAX_TOKENS=4096"
        XCTAssertEqual(draft.problems, ["以下项的值须为 enc:v1: 密文：accessToken、--token。"])
        draft.arguments = "-y\n@x/server"
        draft.environment = "MAX_TOKENS=4096"
        XCTAssertEqual(draft.problems(existing: ["github", "db"]), [DispatchMCPServerDraft.nameTaken])
        XCTAssertEqual(draft.problems(existing: ["db"]), [])
        var edited = DispatchMCPServerDraft(DispatchMCPServer(name: "github", kind: "stdio", command: "npx"))
        XCTAssertEqual(edited.problems(existing: ["github"]), [], "editing keeps its own name")
        edited.kind = "http"
        edited.url = "https://mcp.example.com/sse?api_key=sk-1"
        XCTAssertEqual(edited.problems, ["以下项的值须为 enc:v1: 密文：URL。"])
        edited.url = "https://mcp.example.com/sse"
        edited.note = String(repeating: "😀", count: 251)
        XCTAssertEqual(edited.problems, ["备注最多 500 个字符。"], "502 UTF-16 units")
    }

    func testSkillDraftRefusesANameInUse() {
        var draft = DispatchSkillDraft(name: "pdf", content: "# PDF")
        XCTAssertEqual(draft.problems(existing: ["pdf"]), [DispatchSkillDraft.nameTaken])
        XCTAssertEqual(draft.problems(existing: ["docx"]), [])
        draft = DispatchSkillDraft(name: "pdf", content: "# PDF", isNew: false)
        XCTAssertEqual(draft.problems(existing: ["pdf"]), [], "editing keeps its own name")
    }

    func testSkillDraft() {
        var draft = DispatchSkillDraft()
        XCTAssertEqual(draft.problems.count, 2)
        draft.name = "release-notes"
        draft.content = "# Release notes"
        draft.harnesses = ["opencode", "claude-code"]
        XCTAssertEqual(draft.problems, [])
        XCTAssertEqual(draft.update, DispatchSkillUpdate(content: "# Release notes", harnesses: ["claude-code", "opencode"]))
    }

    func testHarnessList() {
        XCTAssertEqual(DispatchHarnessList.text(DispatchExtensionHarnesses.all), "All")
        XCTAssertEqual(DispatchHarnessList.text(["codex", "claude-code"]), "Claude Code · Codex")
        XCTAssertEqual(DispatchHarnessList.text([]), "None")
    }
}
