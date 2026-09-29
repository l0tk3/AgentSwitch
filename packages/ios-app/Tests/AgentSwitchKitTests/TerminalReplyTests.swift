import XCTest
@testable import AgentSwitchKit

/// terminal-v0 §1 second round: a reply typed directly is checked for secret-looking text first; `/` lists the agent's
/// slash commands.
final class TerminalReplyTests: XCTestCase {
    func testSecretShapesAreCaught() {
        for text in ["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "ghp_0123456789abcdefghijABCDEFGHIJ0123",
                     "AKIAIOSFODNN7EXAMPLE", "密码是 hunter22", "password: s3cret!!", "api key = 12345678",
                     "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
                     "-----BEGIN OPENSSH PRIVATE KEY-----", "用这个 Xq7vR2mK9pL4wN8tY3zB6cJ5hG1fD0sA 登录"] {
            XCTAssertTrue(SecretHint.looksSecret(text), text)
        }
    }

    func testOrdinaryRepliesAreNot() {
        for text in ["ls -la ~/Downloads", "git log --oneline -5", "看一下 src/api/terminals.ts 里的 input 路由",
                     "https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md", "3a122d62f58ea4e8199c2d0f799c0005dc30757f",
                     "0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b", "密码框在右上角", "the password field is empty", "y",
                     "请用 enc:v1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo 登录"] {
            XCTAssertFalse(SecretHint.looksSecret(text), text)
        }
    }

    func testSlashListsCommandsByPrefixThenByWord() {
        let commands = [SlashCommand(name: "compact", description: ""), SlashCommand(name: "config", description: ""),
                        SlashCommand(name: "frontend:lint", description: "", source: "project"), SlashCommand(name: "clear", description: "")]
        XCTAssertEqual(SlashCommand.matching("/", in: commands).map(\.name), ["compact", "config", "frontend:lint", "clear"])
        XCTAssertEqual(SlashCommand.matching("/co", in: commands).map(\.name), ["compact", "config"])
        XCTAssertEqual(SlashCommand.matching("/lint", in: commands).map(\.name), ["frontend:lint"])
        XCTAssertEqual(SlashCommand.matching("/compact", in: commands), [], "a whole name needs no list")
        XCTAssertEqual(SlashCommand.matching("/compact now", in: commands), [], "arguments started")
        XCTAssertEqual(SlashCommand.matching("hello /co", in: commands), [])
    }
}
