import XCTest
@testable import AgentSwitchKit

/// The interface's look and the classic look's words and symbols on the phone (docs/ui-v0.md §8, 2026-10-04; the user:
/// 蓝色 英文 固定深色 设置各记各的 图标再说).
final class InterfaceLookTests: XCTestCase {
    func testTheLookIsPixelUnlessClassicIsKept() {
        XCTAssertEqual(InterfaceLook.load(nil), .pixel)
        XCTAssertEqual(InterfaceLook.load(""), .pixel)
        XCTAssertEqual(InterfaceLook.load("Classic"), .pixel, "what is not one of the two words is the default")
        XCTAssertEqual(InterfaceLook.load("pixel"), .pixel)
        XCTAssertEqual(InterfaceLook.load("classic"), .classic)
        XCTAssertEqual(InterfaceLook.key, "appearance")
        XCTAssertEqual(InterfaceLook.allCases.map(\.label), ["Pixel", "Classic"])
        XCTAssertTrue(InterfaceLook.classic.isClassic)
        XCTAssertFalse(InterfaceLook.pixel.isClassic)
    }

    func testTheClassicLookHasItsOwnWordForAFewShortWords() {
        for (pixel, classic) in [("Busy", "Working"), ("Waiting", "Needs You"), ("Idle", "Ready"), ("Exited", "Ended"),
                                 ("[!] Approval", "Approval Needed"), ("[?] Question", "Question"), ("? Question", "Question"),
                                 ("On Mac", "On This Mac"), ("bypass", "Bypass"), ("auto", "Auto"),
                                 ("Approve", "Approval Needed"), ("Answer", "Question")] {
            XCTAssertEqual(ClassicWords.word(pixel, in: .classic), classic)
            XCTAssertEqual(ClassicWords.word(pixel, in: .pixel), pixel, "the pixel look's words are never changed")
        }
        for same in ["Allow", "Deny", "Take Over", "Hand Back", "Failed", "Done", "Dispatch", "Terminals", "Browser", "On iPhone", "Reply"] {
            XCTAssertEqual(ClassicWords.word(same, in: .classic), same)
        }
        XCTAssertEqual(ClassicWords.word("1 Waiting", in: .classic), "1 Needs You")
        XCTAssertEqual(ClassicWords.word("3 Waiting", in: .classic), "3 Need You")
        XCTAssertEqual(ClassicWords.word("3 Waiting", in: .pixel), "3 Waiting")
        XCTAssertEqual(ClassicWords.word("Still Waiting", in: .classic), "Still Waiting", "a count only")
    }

    func testALineOfWordsIsWrittenWordByWord() {
        XCTAssertEqual(ClassicWords.phrase("Waiting · Run Command", in: .classic), "Needs You · Run Command")
        XCTAssertEqual(ClassicWords.phrase("Busy · Opus 5.5", in: .classic), "Working · Opus 5.5")
        XCTAssertEqual(ClassicWords.phrase("Waiting · Run Command", in: .pixel), "Waiting · Run Command")
    }

    func testAnAgeSaysAgoInTheClassicLook() {
        XCTAssertEqual(ClassicWords.age("3h", in: .classic), "3h ago")
        XCTAssertEqual(ClassicWords.age("5m", in: .classic), "5m ago")
        XCTAssertEqual(ClassicWords.age("2d", in: .classic), "2d ago")
        XCTAssertEqual(ClassicWords.age("Now", in: .classic), "Now")
        XCTAssertEqual(ClassicWords.age("10/3", in: .classic), "10/3")
        XCTAssertEqual(ClassicWords.age("3m ago", in: .classic), "3m ago", "said already")
        XCTAssertEqual(ClassicWords.age("3h", in: .pixel), "3h")
    }

    func testAButtonHasNoBracketsAndALabelNoSlashesInTheClassicLook() {
        XCTAssertEqual(ClassicWords.button("Allow", in: .pixel), "[ Allow ]")
        XCTAssertEqual(ClassicWords.button("Allow", in: .classic), "Allow")
        XCTAssertEqual(ClassicWords.button("+ New Terminal", in: .classic), "New Terminal")
        XCTAssertEqual(ClassicWords.button("+ New Terminal", in: .pixel), "[ + New Terminal ]")
        XCTAssertEqual(ClassicWords.label("Status", in: .pixel), "// Status")
        XCTAssertEqual(ClassicWords.label("Status", in: .classic), "Status")
    }

    func testEachSpriteHasASymbolOrIsDrawnByHand() {
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.square), "circle.fill", "a status square is a dot")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.hollow), "circle")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.lock), "lock")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.picture), "photo")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.terminalWindow), "terminal")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.globe), "globe")
        // The app's own mark and the agents' are drawn by hand: no symbol stands for them.
        XCTAssertNil(PixelArt.symbol(for: PixelArt.markRows))
        for rows in PixelArt.agents.values { XCTAssertNil(PixelArt.symbol(for: rows)) }
        XCTAssertEqual(Set(PixelArt.symbols.map(\.rows)).count, PixelArt.symbols.count, "each set of rows is listed once")
    }
}
