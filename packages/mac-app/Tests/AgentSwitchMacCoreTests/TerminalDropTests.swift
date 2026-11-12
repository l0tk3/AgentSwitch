import XCTest
@testable import AgentSwitchMacCore

/// A drop on the Mac's terminal (docs/terminal-v0.md §1 Mac): 2026-09-30, user: 往终端里拖文件没反应.
final class TerminalDropTests: XCTestCase {
    func testPathsAreEscapedAsITermTypesThem() {
        XCTAssertEqual(TerminalDrop.paths(["/Users/me/Desktop/Screen Shot 2026-09-30 at 10.12.png"]),
                       "/Users/me/Desktop/Screen\\ Shot\\ 2026-09-30\\ at\\ 10.12.png")
        XCTAssertEqual(TerminalDrop.paths(["/tmp/a (1).txt", "/tmp/it's&$x.md", "/tmp/中文 图.jpg"]),
                       "/tmp/a\\ \\(1\\).txt /tmp/it\\'s\\&\\$x.md /tmp/中文\\ 图.jpg")
    }

    func testAPasteIsBracketedWhenTheProgramAskedAndCannotBeEndedEarly() {
        XCTAssertEqual(TerminalDrop.pasted("/tmp/a.png", bracketed: false), "/tmp/a.png")
        XCTAssertEqual(TerminalDrop.pasted("/tmp/a.png", bracketed: true), "\u{1b}[200~/tmp/a.png\u{1b}[201~")
        XCTAssertEqual(TerminalDrop.pasted("x\u{1b}[201~rm -rf ~\r", bracketed: true), "\u{1b}[200~xrm -rf ~\r\u{1b}[201~")
    }
}

/// ⌘V on the Mac's terminal (docs/terminal-v0.md §1 Mac "粘贴图片"): 2026-10-15, user: 无法远程 paste image.
final class TerminalPasteTests: XCTestCase {
    func testAPictureAloneIsSentOnThisMacAndOnAnotherNode() {
        XCTAssertEqual(TerminalPaste.of(files: 0, text: false, picture: true, remote: true), .picture)
        XCTAssertEqual(TerminalPaste.of(files: 0, text: false, picture: true, remote: false), .picture)
    }

    func testTextIsPastedAsBeforeEvenBesideAPicture() {
        XCTAssertEqual(TerminalPaste.of(files: 0, text: true, picture: false, remote: true), .text)
        XCTAssertEqual(TerminalPaste.of(files: 0, text: true, picture: true, remote: true), .text)
        XCTAssertEqual(TerminalPaste.of(files: 0, text: true, picture: true, remote: false), .text)
        XCTAssertEqual(TerminalPaste.of(files: 0, text: false, picture: false, remote: true), .text)
    }

    func testFilesCopiedInFinderAreSentOnlyToAnotherNode() {
        // Finder puts the files' names as text beside their URLs; on this Mac that is pasted as before.
        XCTAssertEqual(TerminalPaste.of(files: 2, text: true, picture: true, remote: true), .files)
        XCTAssertEqual(TerminalPaste.of(files: 1, text: true, picture: false, remote: false), .text)
        XCTAssertEqual(TerminalPaste.of(files: 1, text: false, picture: true, remote: false), .text)
    }
}
