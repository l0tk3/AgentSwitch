/// Each agent's logo as its own command-line program draws it on its start screen (user #590: 图标统一放各家cli里放的那个
/// 图标), read off those screens on 2026-11-26: Claude Code's creature (quadrant blocks, its clay), Codex's `>_`,
/// OpenCode 2.3's `o` of its wordmark (half blocks), pi 1.6's three-coloured π (half blocks), Grok 1.0.92's ring and
/// stroke (braille dots), Antigravity 1.5's striped arch (half blocks, each its own colour). A cell is one lit pixel:
/// its key names its colour in `colours` (hex `RRGGBB`; `ink`: the page's ink).
public struct AgentLogoArt: Sendable {
    public let rows: [String]
    public let colours: [String: String]

    /// How much taller than wide a cell is where it is not square: Claude Code's art is in quadrant blocks, a quarter
    /// of a terminal cell (itself twice as tall as wide), so its pixels are twice as tall as wide.
    public static let tall: [String: Double] = ["claude-code": 2]

    public static let art: [String: AgentLogoArt] = {
        var all: [String: AgentLogoArt] = [:]
        all["claude-code"] = AgentLogoArt(rows: ["..aaaaaaaaaaaa..", "..aa.aaaaaa.aa..", "aaaaaaaaaaaaaaaa", "..aaaaaaaaaaaa..", "...a.a....a.a..."] as [String], colours: ["a": "D97757"] as [String: String])
        all["agy"] = AgentLogoArt(rows: [".....bc.....", "....a..d....", "...efghij...", "............", "..klmnopqr..", "............", "..tu....vw..", ".s........x.", ".zA......BC.", "y..........D"] as [String], colours: ["a": "DBB131", "b": "F2922E", "c": "F07236", "d": "F0583B", "e": "9EC345", "f": "B5B43E", "g": "E2993D", "h": "F67A34", "i": "F86A35", "j": "EF5442", "k": "7CC251", "l": "71C25C", "m": "5CA98F", "n": "5C91B3", "o": "8373B0", "p": "746FC3", "q": "995DA8", "r": "9C5B97", "s": "6DC694", "t": "61C37D", "u": "43AEAB", "v": "4A80EA", "w": "6C73D8", "x": "6579E1", "y": "67B9F4", "z": "6BC7A3", "A": "64B6F6", "B": "3886FB", "C": "4881F4", "D": "3D85FC"] as [String: String])
        all["pi"] = AgentLogoArt(rows: ["aaa.", "..a.", "bb.c", "b..c"] as [String], colours: ["a": "E48A7A", "b": "4F8EB3", "c": "EAB65D"] as [String: String])
        all["grok"] = AgentLogoArt(rows: [".........................i", "...........iiiii........i.", "........iiiiiiiiiii....i..", ".......iiiiiiiiiiii...i...", "......iiiii..........ii...", ".....iiii...........ii....", "....iiii...........iiii...", "....iii...........iiiii...", "...iii...........ii.iii...", "...iii..........ii...iii..", "...iii.........i.....iii..", "...iii........i......iii..", "...iii.......i.......iii..", "...iii...............iii..", "...iii...............ii...", "....iii.............iii...", "....iii............iiii...", "....iii...........iiii....", "....ii...........iiii.....", "...ii....iiiiiiiiiii......", "...i....iiiiiiiiiii.......", "..i.......iiiiiii.........", ".i........................", "i........................."] as [String], colours: ["i": "ink"] as [String: String])
        all["codex"] = AgentLogoArt(rows: ["#........", ".#.......", "..#......", ".#.......", "#...#####"] as [String], colours: ["#": "ink"] as [String: String])
        all["opencode"] = AgentLogoArt(rows: ["####", "#..#", "#..#", "#..#", "####"] as [String], colours: ["#": "ink"] as [String: String])
        return all
    }()
}
