import XCTest
@testable import AgentSwitchMacCore

/// What a reply box offers as it is typed in (2026-10-07, user: 我输入/的时候输入框应该给我提示应有的选项，包括其他cli里应有的特殊符号也一样).
final class ReplyHintsTests: XCTestCase {
    private func ask(_ text: String, caret: Int? = nil, _ harness: String = "claude-code") -> ReplyHints.Ask? {
        ReplyHints.ask(text: text, caret: caret ?? (text as NSString).length, harness: harness)
    }

    func testASlashAtTheStartAsksForCommandsUntilASpace() {
        XCTAssertEqual(ask("/"), .commands(""))
        XCTAssertEqual(ask("/comp"), .commands("comp"))
        XCTAssertNil(ask("/compact now"))
        XCTAssertNil(ask("看 /compact"))
        // The caret inside the name: what is before it; with more of the name after it, nothing.
        XCTAssertNil(ask("/compact", caret: 3))
        XCTAssertEqual(ask("/co mpact", caret: 3), .commands("co"))
        XCTAssertEqual(ask("/", "pi"), .commands(""))
    }

    func testAnAtAsksForFilesOfTheWordTheCaretIsIn() {
        XCTAssertEqual(ask("@"), .files(query: "", at: 0))
        XCTAssertEqual(ask("看一下 @host"), .files(query: "host", at: 4))
        XCTAssertEqual(ask("看一下 @host 这里", caret: 9), .files(query: "host", at: 4))
        XCTAssertNil(ask("看一下 @host 这里"))
        // Counted as a text view counts (UTF-16): an emoji before it is two.
        XCTAssertEqual(ask("👍 @a"), .files(query: "a", at: 3))
        // An address is not a file.
        XCTAssertNil(ask("写给 me@example.com"))
        XCTAssertNil(ask("@a@b"))
        XCTAssertEqual(ask("@src/term", "codex"), .files(query: "src/term", at: 0))
    }

    func testAFirstCharacterThatChangesTheLineIsSaid() {
        guard case .mark(let shell)? = ask("!git status") else { return XCTFail("no mark") }
        XCTAssertEqual(shell.sign, "!")
        XCTAssertEqual(shell.word, "Shell")
        XCTAssertNil(ask("好！"))
        XCTAssertNil(ask("!ls", "echo"))
        guard case .mark(let skills)? = ask("$", "codex") else { return XCTFail("no mark") }
        XCTAssertEqual(skills.word, "Skills")
        XCTAssertNil(ask("$", "claude-code"))
        XCTAssertNil(ask("$HOME is", "codex"))
        XCTAssertNil(ask("普通的一句话"))
    }

    func testCommandsAreNarrowedByWhatIsTyped() {
        let all = ["compact", "config", "context", "frontend:lint", "lint-fix", "clear"].map { SlashCommand(name: $0, description: "") }
        XCTAssertEqual(ReplyHints.matching("co", in: all).map(\.name), ["compact", "config", "context"])
        XCTAssertEqual(ReplyHints.matching("lint", in: all).map(\.name), ["lint-fix", "frontend:lint"])
        XCTAssertEqual(ReplyHints.matching("", in: all, limit: 2).map(\.name), ["compact", "config"])
        XCTAssertEqual(ReplyHints.matching("clear", in: all), [])
        XCTAssertEqual(ReplyHints.matching("zz", in: all), [])
        let listed = try? JSONDecoder().decode([SlashCommand].self, from: Data(#"[{"name":"compact","description":"Free up context","source":"builtin"},{"name":"mine"}]"#.utf8))
        XCTAssertEqual(listed?.map(\.source), ["builtin", "builtin"])
    }

    func testAChoiceTypesWhatTheAgentReads() {
        XCTAssertEqual(ReplyHints.typed(command: SlashCommand(name: "compact", description: "")), "/compact ")
        XCTAssertEqual(ReplyHints.typed(file: "src/terminals/host.ts", harness: "claude-code"), "@src/terminals/host.ts ")
        XCTAssertEqual(ReplyHints.typed(file: "src/terminals/host.ts", harness: "codex"), "src/terminals/host.ts ")
        XCTAssertEqual(ReplyHints.typed(file: "docs/my notes.md", harness: "claude-code"), "@\"docs/my notes.md\" ")
        XCTAssertEqual(ReplyHints.typed(file: "docs/my notes.md", harness: "codex"), "\"docs/my notes.md\" ")
        XCTAssertEqual(ReplyHints.parts(of: "src/terminals/host.ts").name, "host.ts")
        XCTAssertEqual(ReplyHints.parts(of: "src/terminals/host.ts").folder, "src/terminals")
        XCTAssertEqual(ReplyHints.parts(of: "README.md").folder, "")
    }
}
