import XCTest
@testable import AgentSwitchMacCore

/// The pixel look's shaded icons (docs/ui-v0.md §9, docs/design/concepts/pixel-icons.html): tones of the one ink, no hue.
final class ShadedSpritesTests: XCTestCase {
    private let all = ShadedSprite.all

    /// The same number as the phone's ShadedSpritesTests and the daemon's uiShaded.test.ts: the three copies of the
    /// pictures are one set. A picture changed here changes it; change the other two copies with it.
    func testThePicturesAreTheOnesTheOtherCopiesHave() {
        XCTAssertEqual(ShadedSprite.digest, 4_248_886_859)
        XCTAssertEqual(all.count, 15)
        XCTAssertEqual(Set(all.map(\.name)).count, all.count)
    }

    func testEverySpriteIsARectangleOfKnownTonesWithinTheBoard() {
        for (name, sprite) in all {
            XCTAssertFalse(sprite.rows.isEmpty, name)
            XCTAssertTrue(sprite.rows.allSatisfy { $0.count == sprite.width }, "\(name): every row is as long as the first")
            XCTAssertLessThanOrEqual(sprite.width, 16, name)
            XCTAssertLessThanOrEqual(sprite.height, 16, name)
            XCTAssertEqual(name.hasSuffix("code") || name == "codex" || name == "pi", ShadedSprite.agents[name] != nil, name)
            for tone in Set(sprite.rows.joined()) where tone != "." {
                XCTAssertNotNil(ShadedSprite.color(tone, dark: true), "\(name): \(tone) is a tone")
                XCTAssertNotNil(ShadedSprite.color(tone, dark: false), "\(name): \(tone) is a tone on a light ground")
            }
            let lit = sprite.rows.joined().filter { $0 != "." }.count
            XCTAssertEqual(sprite.cells(dark: true).count, lit, name)
            XCTAssertEqual(sprite.cells(dark: false).count, lit, name)
        }
    }

    func testTheTonesAreTheInksOnlyAndTurnWithTheGround() {
        XCTAssertEqual(ShadedSprite.color("#", dark: true), 0xE9E6DF)
        XCTAssertEqual(ShadedSprite.color("#", dark: false), 0x16140F)
        XCTAssertEqual(ShadedSprite.color("W", dark: true), 0xFFFFFF)
        XCTAssertEqual(ShadedSprite.color("W", dark: false), 0x000000, "the strongest tone is the darkest on paper")
        XCTAssertNil(ShadedSprite.color(".", dark: true))
        XCTAssertNil(ShadedSprite.color("p", dark: true), "no hue: only the ink's tones")
        // Every tone is a grey of the ink's own warmth: no channel far from the others.
        for (tone, rgb) in ShadedSprite.tonesDark.merging(ShadedSprite.tonesLight) { a, _ in a } {
            let parts = [Int(rgb >> 16 & 0xFF), Int(rgb >> 8 & 0xFF), Int(rgb & 0xFF)]
            XCTAssertLessThanOrEqual(parts.max()! - parts.min()!, 24, "\(tone) is a grey")
        }
        XCTAssertEqual(Set(ShadedSprite.tonesDark.keys), Set(ShadedSprite.tonesLight.keys))
    }

    func testTheBarsAndTheRailsSpritesHaveTheirShadedPictures() {
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.railDispatch), .dispatch)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.railTerminals), .terminals)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.railBrowser), .browser)
        // Clash's page is the Mac's alone: its cat is a picture here and not one of those the phone and the web share.
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.railClash), .clash)
        XCTAssertFalse(ShadedSprite.all.contains { $0.sprite == .clash })
        // In the classic look it is drawn by hand too (Clash's own cat's head; the system has only a whole cat).
        XCTAssertNil(PixelArt.symbol(for: PixelArt.railClash))
        XCTAssertTrue(ShadedSprite.clash.rows.allSatisfy { $0.count == 16 } && ShadedSprite.clash.height <= 16)
        XCTAssertTrue(Set(ShadedSprite.clash.rows.joined()).subtracting(["."]).allSatisfy { ShadedSprite.color($0, dark: true) != nil && ShadedSprite.color($0, dark: false) != nil })
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.toolbarSettings), .settings)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.toolbarList), .list)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.toolbarSplitRight), .splitRight)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.toolbarSplitDown), .splitDown)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.toolbarNew), .new)
        XCTAssertEqual(ShadedSprite.standing(for: PixelArt.lock), .lock)
        // Each agent's mark has its shaded one; a status square and the menu bar's mark keep their own drawing.
        for (harness, rows) in PixelArt.agents { XCTAssertEqual(ShadedSprite.standing(for: rows), ShadedSprite.agents[harness], harness) }
        XCTAssertEqual(Set(ShadedSprite.agents.keys), Set(PixelArt.agents.keys))
        XCTAssertNil(ShadedSprite.standing(for: PixelArt.square))
        XCTAssertNil(ShadedSprite.standing(for: PixelArt.hollow))
        XCTAssertNil(ShadedSprite.standing(for: PixelArt.markRows))
        XCTAssertEqual(Set(ShadedSprite.stands.map(\.rows)).count, ShadedSprite.stands.count, "each 1-bit sprite stands once")
    }

    func testACellIsAWholeNumberOfPixels() {
        XCTAssertEqual(ShadedSprite.cell(scale: 2), 1.5)
        XCTAssertEqual(ShadedSprite.cell(scale: 1), 1)
        XCTAssertEqual(ShadedSprite.cell(scale: 3), 4.0 / 3.0, accuracy: 1e-9)
        XCTAssertEqual(ShadedSprite.cell(scale: 0), 1, "a scale that makes no sense is one")
        // Any size asked for: never more than asked, at least a pixel.
        XCTAssertEqual(ShadedSprite.cell(scale: 2, points: 1), 1)
        XCTAssertEqual(ShadedSprite.cell(scale: 2, points: 2.25), 2)
        XCTAssertEqual(ShadedSprite.cell(scale: 3, points: 5.0 / 3.0), 5.0 / 3.0, accuracy: 1e-9)
        XCTAssertEqual(ShadedSprite.cell(scale: 2, points: 0.2), 0.5)
        for scale in [1.0, 2.0, 3.0] {
            for points in [0.75, 1, 1.5, 5.0 / 3.0, 2.25, 3] {
                let pixels = ShadedSprite.cell(scale: scale, points: points) * scale
                XCTAssertEqual(pixels, pixels.rounded(), accuracy: 1e-9, "\(points) pt at \(scale)×")
                XCTAssertGreaterThanOrEqual(pixels, 1)
            }
        }
    }

    func testTheMarksStatesSitOnItsPicture() {
        let rows = ShadedMark.picture.rows.map(Array.init)
        XCTAssertEqual(ShadedMark.picture, .stack)
        // The title bar: the front window's two top rows, twenty-two cells, lit above, dark at its right end.
        let bar = rows.enumerated().flatMap { y, row in row.enumerated().compactMap { x, c in c != "." && ShadedMark.isEnd(x: x, y: y) ? "\(x),\(y)" : nil } }
        XCTAssertEqual(bar.count, 22)
        XCTAssertFalse(ShadedMark.isEnd(x: 11, y: 6), "the window behind shows through the front one's clipped corner")
        XCTAssertEqual(ShadedMark.edge(of: rows[6][1]), .light)
        XCTAssertEqual(ShadedMark.edge(of: rows[7][5]), .face)
        XCTAssertEqual(ShadedMark.edge(of: rows[7][11]), .dark)
        // The block runs along the title bar, two by two cells a step, none twice, all of them the bar's.
        let lane = ShadedMark.lane.flatMap { $0 }
        XCTAssertEqual(ShadedMark.lane.count, 5)
        XCTAssertTrue(ShadedMark.lane.allSatisfy { $0.count == 4 })
        XCTAssertEqual(Set(lane.map { "\($0.x),\($0.y)" }).count, lane.count)
        XCTAssertTrue(Set(lane.map { "\($0.x),\($0.y)" }).isSubset(of: Set(bar)))
        XCTAssertTrue(ShadedMark.dithered(x: 1, y: 0))
        XCTAssertFalse(ShadedMark.dithered(x: 1, y: 1))
    }
}
