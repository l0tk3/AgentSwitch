import XCTest
@testable import AgentSwitchMacCore

/// The interface's look and the classic look's words and symbols (docs/ui-v0.md §8, 2026-10-04; the user: 蓝色 英文 固定深色
/// 设置各记各的 图标再说).
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
        // The concept page's "经典 · English" column; everything else is the same word in both looks.
        for (pixel, classic) in [("Busy", "Working"), ("Waiting", "Needs You"), ("Idle", "Ready"), ("Exited", "Ended"),
                                 ("[!] Approval", "Approval Needed"), ("? Question", "Question"), ("Gateway", "Gateway OK"),
                                 ("On Mac", "On This Mac"), ("bypass", "Bypass"), ("auto", "Auto"), ("manual", "Ask Each"), ("OK", "Running"),
                                 ("Open Dispatch", "Open AgentSwitch")] {
            XCTAssertEqual(ClassicWords.word(pixel, in: .classic), classic)
            XCTAssertEqual(ClassicWords.word(pixel, in: .pixel), pixel, "the pixel look's words are never changed")
        }
        for same in ["Allow", "Deny", "Take Over", "Hand Back", "Failed", "Done", "Dispatch", "Terminals", "Browser", "iPhone Online", "Gateway Down"] {
            XCTAssertEqual(ClassicWords.word(same, in: .classic), same)
        }
        // How many wait for you.
        XCTAssertEqual(ClassicWords.word("1 Waiting", in: .classic), "1 Needs You")
        XCTAssertEqual(ClassicWords.word("3 Waiting", in: .classic), "3 Need You")
        XCTAssertEqual(ClassicWords.word("3 Waiting", in: .pixel), "3 Waiting")
        XCTAssertEqual(ClassicWords.word("Still Waiting", in: .classic), "Still Waiting", "a count only")
    }

    func testALineOfWordsIsWrittenWordByWord() {
        XCTAssertEqual(ClassicWords.phrase("Waiting · Run Command", in: .classic), "Needs You · Run Command")
        XCTAssertEqual(ClassicWords.phrase("On Mac · 139×46", in: .classic), "On This Mac · 139×46")
        XCTAssertEqual(ClassicWords.phrase("Busy · Opus 5.5", in: .classic), "Working · Opus 5.5")
        XCTAssertEqual(ClassicWords.phrase("Waiting · Run Command", in: .pixel), "Waiting · Run Command")
        XCTAssertEqual(ClassicWords.phrase("Waiting", in: .classic), "Needs You")
    }

    func testAHelpSaysItsKeyInBracketsInTheClassicLook() {
        XCTAssertEqual(ClassicWords.help("List ⌘B", in: .classic), "Show or hide the list (⌘B)")
        XCTAssertEqual(ClassicWords.help("New Terminal ⌘T", in: .classic), "New Terminal (⌘T)")
        XCTAssertEqual(ClassicWords.help("Split Down ⌘⇧D", in: .classic), "Split Down (⌘⇧D)")
        XCTAssertEqual(ClassicWords.help("Back esc", in: .classic), "Back (esc)")
        XCTAssertEqual(ClassicWords.help("Send ↩", in: .classic), "Send (↩)")
        XCTAssertEqual(ClassicWords.help("Settings ⌘,", in: .classic), "Settings (⌘,)")
        XCTAssertEqual(ClassicWords.help("No List on This Page", in: .classic), "This page has no list")
        XCTAssertEqual(ClassicWords.help("Close", in: .classic), "Close", "no key: as it is")
        XCTAssertEqual(ClassicWords.help("Attach, Ciphertext, Pin Model", in: .classic), "Attach, Ciphertext, Pin Model")
        let sentence = "Encrypt & Send ⌘⇧V：密码与令牌在发送前加密，agent 仅接收密文。"
        XCTAssertEqual(ClassicWords.help(sentence, in: .classic), sentence, "a sentence stays as it is")
        XCTAssertEqual(ClassicWords.help("List ⌘B", in: .pixel), "List ⌘B")
    }

    func testEveryToolbarAndRailSpriteHasASymbolOrIsDrawnByHand() {
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarList), "sidebar.left")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarNew), "plus")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarSettings), "slider.horizontal.3")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarSplitRight), "rectangle.righthalf.inset.filled", "the half a split adds, filled in")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.toolbarSplitDown), "rectangle.bottomhalf.inset.filled")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.railTerminals), "terminal")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.railBrowser), "globe")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.square), "circle.fill", "a status square is a dot")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.hollow), "circle")
        XCTAssertEqual(PixelArt.symbol(for: PixelArt.lock), "lock")
        // The app's own mark and the agents' are drawn by hand (ClassicViews): no symbol stands for them.
        XCTAssertNil(PixelArt.symbol(for: PixelArt.railDispatch))
        XCTAssertNil(PixelArt.symbol(for: PixelArt.markRows))
        for rows in PixelArt.agents.values { XCTAssertNil(PixelArt.symbol(for: rows)) }
        // No two sprites are told apart wrongly: each set of rows is listed once.
        XCTAssertEqual(Set(PixelArt.symbols.map(\.rows)).count, PixelArt.symbols.count)
    }

    func testTheStatusBarSaysTheTerminalAsTheLookDoes() {
        let context = TerminalContext(harness: "claude-code", model: "claude-opus-5-5", mode: "bypass", cols: 139, rows: 46)
        XCTAssertEqual(context.agent(in: .pixel), context.agent)
        XCTAssertTrue(context.agent(in: .classic).hasPrefix("Claude Code"), context.agent(in: .classic))
        XCTAssertEqual(context.size(in: .pixel), "On Mac · 139×46")
        XCTAssertEqual(context.size(in: .classic), "On This Mac · 139×46")
        XCTAssertEqual(TerminalContext(harness: "codex", away: "iphone").size(in: .classic), "On iPhone")
        XCTAssertEqual(TerminalContext(harness: "codex").agent(in: .classic), "Codex")
    }
}
