import XCTest
@testable import AgentSwitchMacCore

/// A path the agent's screen broke over indented lines (docs/terminal-v0.md §1 链接; 2026-10-02, user: 折成两行的长路径
/// ⌘-点不开): the clicked word joined back with its neighbours, longest first, and the first that exists opened.
final class WrappedPathTests: XCTestCase {
    /// As Claude Code printed it in the user's terminal: the path broken after `-85d`, the rest indented 7.
    private let head = "/private/tmp/claude-501/-Users-me-Desktop-WorkSpace-Projects-AgentSwitch/0e3e5e94-d0e2-4f5b-b869-85d"
    private let tail = "7a3bb725b/scratchpad/standalone/out/agentswitch-browser.html"
    private var whole: String { head + tail }
    private var screen: [String] {
        ["⏺ Wrote the page to",
         "  " + head,
         "       " + tail,
         "",
         "⏺ Open it in the browser to check the layout."]
    }

    private func column(of text: String, in line: String, offset: Int = 3) -> Int {
        let start = line.range(of: text)!.lowerBound
        return line.distance(from: line.startIndex, to: start) + offset
    }

    func testTheRealOutputJoinsFromEitherLine() {
        let lines = screen
        let fromHead = WrappedPath.candidates(lines: lines, row: 1, column: column(of: head, in: lines[1]))
        XCTAssertEqual(fromHead, [whole, head], "the join first, then the word alone")
        let fromTail = WrappedPath.candidates(lines: lines, row: 2, column: column(of: tail, in: lines[2], offset: 20))
        XCTAssertEqual(fromTail, [whole, tail])
    }

    func testTheRealOutputOpensTheFileFromEitherLine() throws {
        // The same shape on disk: a folder that exists, a file whose name runs over the break.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-wrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("-Users-me-Desktop-WorkSpace-Projects-AgentSwitch/0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b/scratchpad/standalone/out")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("agentswitch-browser.html")
        FileManager.default.createFile(atPath: file.path, contents: Data("<p>x</p>".utf8))
        let full = file.path
        let cut = full.range(of: "85d7a3bb725b")!.lowerBound
        let up = String(full[..<full.index(cut, offsetBy: 3)]), down = String(full[full.index(cut, offsetBy: 3)...])
        let lines = ["⏺ Wrote", "  " + up, "       " + down, ""]

        // The head alone is no file (only its folder exists), and its longest existing part is not taken for it.
        XCTAssertNil(LinkPolicy.target(link: up, workdir: nil))
        let fromHead = WrappedPath.joins(lines: lines, row: 1, column: 5)
        XCTAssertEqual(LinkPolicy.target(link: up, wrapped: fromHead, workdir: nil)?.path, full)
        // The tail is a relative path from where the agent works: nothing there; joined, the file.
        let fromTail = WrappedPath.joins(lines: lines, row: 2, column: 12)
        XCTAssertEqual(LinkPolicy.target(link: down, wrapped: fromTail, workdir: "/Users/nobody/project")?.path, full)
    }

    func testAPathBrokenAtASlashOpensTheFileNotTheFolder() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-wrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("docs/design")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("mac-window.html")
        FileManager.default.createFile(atPath: file.path, contents: Data("x".utf8))
        let up = root.appendingPathComponent("docs").path
        let lines = ["  see " + up, "    /design/mac-window.html"]
        let wrapped = WrappedPath.joins(lines: lines, row: 0, column: 8)
        XCTAssertEqual(LinkPolicy.target(link: up, wrapped: wrapped, workdir: nil)?.path, file.path,
                       "the longest that exists, though the head is a folder")
    }

    func testAWordThatIsAFileOnItsOwnStillOpens() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-wrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let a = root.appendingPathComponent("a.txt"), b = root.appendingPathComponent("b.txt")
        for f in [a, b] { FileManager.default.createFile(atPath: f.path, contents: Data("x".utf8)) }
        // A list of files, one an indented line: each its own, never glued together.
        let lines = ["  Files:", "    " + a.path, "    " + b.path]
        let fromA = WrappedPath.joins(lines: lines, row: 1, column: 6)
        XCTAssertEqual(fromA.first, WrappedPath.Join(a.path + b.path), "a join is offered first")
        XCTAssertEqual(LinkPolicy.target(link: a.path, wrapped: fromA, workdir: nil)?.path, a.path)
        let fromB = WrappedPath.joins(lines: lines, row: 2, column: 6)
        XCTAssertEqual(fromB.first, WrappedPath.Join(a.path + b.path, reachesUp: true))
        XCTAssertEqual(LinkPolicy.target(link: b.path, wrapped: fromB, workdir: nil)?.path, b.path)
    }

    /// 2026-10-02 review: a list of indented relative paths, the clicked one deleted. The join with the line above,
    /// `src/a.tssrc/b.ts`, cut back to what exists is `src/a.ts` — the other line's file, never the one clicked.
    func testAJoinWithTheLineAboveIsNeverCutBack() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-wrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let src = root.appendingPathComponent("src")
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        let a = src.appendingPathComponent("a.ts")
        FileManager.default.createFile(atPath: a.path, contents: Data("x".utf8))
        let lines = ["  Changed:", "    src/a.ts", "    src/b.ts"]
        let fromB = WrappedPath.joins(lines: lines, row: 2, column: 6)
        XCTAssertEqual(fromB, [WrappedPath.Join("src/a.tssrc/b.ts", reachesUp: true), WrappedPath.Join("src/b.ts")])
        XCTAssertNil(LinkPolicy.target(link: "src/b.ts", wrapped: fromB, workdir: root.path), "b.ts is gone: nothing opens")
        // The clicked line's own file still opens, and a join with the line below may still be cut back to it.
        let fromA = WrappedPath.joins(lines: lines, row: 1, column: 6)
        XCTAssertEqual(fromA, [WrappedPath.Join("src/a.tssrc/b.ts"), WrappedPath.Join("src/a.ts")])
        XCTAssertEqual(LinkPolicy.target(link: "src/a.ts", wrapped: fromA, workdir: root.path)?.path, a.path)
        XCTAssertEqual(LinkPolicy.target(link: "src/a.tsx", wrapped: [WrappedPath.Join("src/a.tssrc/b.ts")], workdir: root.path)?.path,
                       a.path, "cut back from below")
        // Both gone: nothing, whichever line is clicked.
        try FileManager.default.removeItem(at: a)
        XCTAssertNil(LinkPolicy.target(link: "src/a.ts", wrapped: fromA, workdir: root.path))
        XCTAssertNil(LinkPolicy.target(link: "src/b.ts", wrapped: fromB, workdir: root.path))
    }

    func testOnlyAWordAtTheBreakJoins() {
        let long = "  /a/b/c/d/e/f/g/h/i/j/k"
        // Not the last word of its line: nothing below continues it.
        XCTAssertEqual(WrappedPath.candidates(lines: [long + " is here", "    c/d.txt"], row: 0, column: 3), ["/a/b/c/d/e/f/g/h/i/j/k"])
        // The next line is not indented: not a continuation.
        XCTAssertEqual(WrappedPath.candidates(lines: [long, "c/d.txt"], row: 0, column: 3), ["/a/b/c/d/e/f/g/h/i/j/k"])
        // Not the first word of its line: nothing above continues into it.
        XCTAssertEqual(WrappedPath.candidates(lines: [long, "    see c/d.txt"], row: 1, column: 9), ["c/d.txt"])
        // A line that is not indented does not continue the one above.
        XCTAssertEqual(WrappedPath.candidates(lines: [long, "c/d.txt"], row: 1, column: 2), ["c/d.txt"])
        // A blank line ends it.
        XCTAssertEqual(WrappedPath.candidates(lines: [long, "      ", "    c"], row: 0, column: 3), ["/a/b/c/d/e/f/g/h/i/j/k"])
        // Only the next line's first word.
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b/c/d/e/f/g/h", "    i.txt and more"], row: 0, column: 3),
                       ["/a/b/c/d/e/f/g/hi.txt", "/a/b/c/d/e/f/g/h"])
        // A line broken there reaches as far right as the one it continues into (it was filled to the break): a short
        // line above an indented longer one is not the path's start.
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b", "    c/d.txt"], row: 0, column: 3), ["/a/b"])
        XCTAssertEqual(WrappedPath.candidates(lines: ["⏺ Wrote to", "  /a/b/c/d/e"], row: 1, column: 3), ["/a/b/c/d/e"])
    }

    func testUpToThreeLinesEachWay() {
        let lines = ["x /p1", "  p2", "  p3", "  p4", "  p5", "  p6"]
        let fromTop = WrappedPath.candidates(lines: lines, row: 0, column: 3)
        XCTAssertEqual(fromTop.first, "/p1p2p3p4", "three lines down, not four")
        XCTAssertEqual(fromTop.count, 4)
        let fromBottom = WrappedPath.candidates(lines: lines, row: 5, column: 3)
        XCTAssertEqual(fromBottom.first, "p3p4p5p6", "three lines up")
        // From the middle: up and down, every combination, longest first.
        let fromMiddle = WrappedPath.candidates(lines: ["x /a", "  b", "  c", "y"], row: 1, column: 2)
        XCTAssertEqual(fromMiddle, ["/abc", "/ab", "bc", "b"])
    }

    func testAContinuationStopsAtALineWithMoreThanTheWord() {
        // The second line holds the path's end and a word after it: the third line is not the path's.
        let lines = ["  /a/b/c/d/e/f/g/h/i", "    c.txt done", "    d"]
        XCTAssertEqual(WrappedPath.candidates(lines: lines, row: 0, column: 3), ["/a/b/c/d/e/f/g/h/ic.txt", "/a/b/c/d/e/f/g/h/i"])
    }

    func testQuotesBracketsAndASentencesPunctuationComeOff() {
        XCTAssertEqual(WrappedPath.candidates(lines: ["  (see `/a/b/c/d", "    /e.txt`)."], row: 0, column: 8),
                       ["/a/b/c/d/e.txt", "/a/b/c/d"])
        XCTAssertEqual(WrappedPath.candidates(lines: ["  “/a/b”，"], row: 0, column: 4), ["/a/b"])
        XCTAssertEqual(WrappedPath.candidates(lines: ["  src/a.ts:12:5,"], row: 0, column: 4), ["src/a.ts:12:5"], "where in the file stays")
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b:"], row: 0, column: 4), ["/a/b"])
    }

    func testAClickOnABlankOrOffTheLineIsNothing() {
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b"], row: 0, column: 0), [])
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b"], row: 0, column: 40), [])
        XCTAssertEqual(WrappedPath.candidates(lines: ["  /a/b"], row: 3, column: 2), [])
        XCTAssertEqual(WrappedPath.candidates(lines: [], row: 0, column: 0), [])
    }

    func testTheTerminalsEmptyCellsAreBlanks() {
        // Cells nothing was written to come out of the buffer as NUL.
        let lines = ["\u{0}\u{0}/a/b/c/d\u{0}\u{0}", "\u{0}\u{0}\u{0}e.txt\u{0}"]
        XCTAssertEqual(WrappedPath.candidates(lines: lines, row: 0, column: 3), ["/a/b/c/de.txt", "/a/b/c/d"])
    }

    func testAWideCharactersSecondCellIsPartOfItsWord() {
        // `/Users/me/文档/` as the terminal holds it: each CJK character two cells; the row a cell an entry.
        let tail = WrappedPath.wideTail
        let head: [Character] = Array("  /Users/me/") + ["文", tail, "档", tail] + Array("/report-of-th")
        let next: [Character] = Array("    e-week.md") + Array(repeating: " ", count: 4)
        XCTAssertEqual(WrappedPath.candidates(rows: [head, next], row: 0, column: 13), ["/Users/me/文档/report-of-the-week.md", "/Users/me/文档/report-of-th"],
                       "clicked on 文's second cell")
        XCTAssertEqual(WrappedPath.candidates(rows: [head, next], row: 1, column: 6), ["/Users/me/文档/report-of-the-week.md", "e-week.md"])
    }

    func testAURLIsNotJoined() {
        // A link with a scheme is the link (an OSC 8 target, a web page): never swapped for a word around it.
        let web = "https://example.com/a"
        XCTAssertEqual(LinkPolicy.target(link: web, wrapped: [WrappedPath.Join("/tmp")], workdir: nil)?.absoluteString, web)
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).absoluteString
        XCTAssertEqual(LinkPolicy.target(link: file, wrapped: [WrappedPath.Join("/")], workdir: nil)?.path,
                       URL(fileURLWithPath: NSTemporaryDirectory()).path)
    }
}
