package com.agentswitch.kit.design

/**
 * Each agent's logo as its own command-line program draws it on its start screen (the Mac's `AgentLogoArt`, user #590:
 * 图标统一放各家cli里放的那个图标), read off those screens on 2026-11-26: Claude Code's creature (quadrant blocks, its
 * clay), Codex's `>_`, OpenCode 2.3's `o` of its wordmark (half blocks), pi 1.6's three-coloured π (half blocks), Grok
 * 1.0.92's ring and stroke (braille dots), Antigravity 1.5's striped arch (half blocks, each its own colour). A cell is
 * one lit pixel: its key names its colour in `colours` (hex `RRGGBB`; `ink`: the page's ink). The same data as the
 * Mac's, cell for cell.
 */
data class AgentLogoArt(val rows: List<String>, val colours: Map<Char, String>) {
    companion object {
        /** How much taller than wide a cell is where it is not square: Claude Code's art is in quadrant blocks, a
         *  quarter of a terminal cell (itself twice as tall as wide), so its pixels are twice as tall as wide. */
        val tall: Map<String, Double> = mapOf("claude-code" to 2.0)

        val art: Map<String, AgentLogoArt> = mapOf(
            "claude-code" to AgentLogoArt(listOf("..aaaaaaaaaaaa..", "..aa.aaaaaa.aa..", "aaaaaaaaaaaaaaaa", "..aaaaaaaaaaaa..", "...a.a....a.a..."), mapOf('a' to "D97757")),
            "agy" to AgentLogoArt(listOf(".....bc.....", "....a..d....", "...efghij...", "............", "..klmnopqr..", "............", "..tu....vw..", ".s........x.", ".zA......BC.", "y..........D"), mapOf('a' to "DBB131", 'b' to "F2922E", 'c' to "F07236", 'd' to "F0583B", 'e' to "9EC345", 'f' to "B5B43E", 'g' to "E2993D", 'h' to "F67A34", 'i' to "F86A35", 'j' to "EF5442", 'k' to "7CC251", 'l' to "71C25C", 'm' to "5CA98F", 'n' to "5C91B3", 'o' to "8373B0", 'p' to "746FC3", 'q' to "995DA8", 'r' to "9C5B97", 's' to "6DC694", 't' to "61C37D", 'u' to "43AEAB", 'v' to "4A80EA", 'w' to "6C73D8", 'x' to "6579E1", 'y' to "67B9F4", 'z' to "6BC7A3", 'A' to "64B6F6", 'B' to "3886FB", 'C' to "4881F4", 'D' to "3D85FC")),
            "pi" to AgentLogoArt(listOf("aaa.", "..a.", "bb.c", "b..c"), mapOf('a' to "E48A7A", 'b' to "4F8EB3", 'c' to "EAB65D")),
            "grok" to AgentLogoArt(listOf(".........................i", "...........iiiii........i.", "........iiiiiiiiiii....i..", ".......iiiiiiiiiiii...i...", "......iiiii..........ii...", ".....iiii...........ii....", "....iiii...........iiii...", "....iii...........iiiii...", "...iii...........ii.iii...", "...iii..........ii...iii..", "...iii.........i.....iii..", "...iii........i......iii..", "...iii.......i.......iii..", "...iii...............iii..", "...iii...............ii...", "....iii.............iii...", "....iii............iiii...", "....iii...........iiii....", "....ii...........iiii.....", "...ii....iiiiiiiiiii......", "...i....iiiiiiiiiii.......", "..i.......iiiiiii.........", ".i........................", "i........................."), mapOf('i' to "ink")),
            "codex" to AgentLogoArt(listOf("#........", ".#.......", "..#......", ".#.......", "#...#####"), mapOf('#' to "ink")),
            "opencode" to AgentLogoArt(listOf("####", "#..#", "#..#", "#..#", "####"), mapOf('#' to "ink")),
        )
    }
}
