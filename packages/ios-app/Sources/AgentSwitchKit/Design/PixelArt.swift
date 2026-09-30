import AgentSwitchLive
import Foundation

/// The app's pixel marks (docs/ui-v0.md §7.3) as data: the views draw them. The same shapes as the terminal page's
/// `packages/daemon/ui/pixel.js` and the Mac app's `PixelArt` — keep the three in step (PixelArtTests pins them).
public enum PixelArt {
    /// A cell of a mark: its place, and whether it belongs to the lit lane (the icon's highlighted one) and its end.
    public struct Cell: Sendable, Equatable {
        public let x: Int
        public let y: Int
        public let lit: Bool
        public let end: Bool
    }

    /// One source switched onto three lanes, as the app icon: S = source, a/b/c = lanes, A/B/C = their ends; the top
    /// lane is the lit one. 14 × 11, y down.
    public static let markRows = LiveArt.markRows
    public static let markWidth = 14
    public static let markHeight = 11

    public static let markCells: [Cell] = cells(markRows)

    /// The lit lane from the source to its end, the way the busy block runs.
    public static let laneA: [(x: Int, y: Int)] = LiveArt.laneA

    /// Empty cells in an inside corner of a diagonal step: a half-lit pixel there smooths the step (sub-pixel
    /// anti-aliasing, for marks of 20 pt and up). Each carries the lit/dim role of the cell it leans on.
    public static let markSmoothing: [Cell] = smoothing(markRows)

    /// How the mark shows the whole app: the lit lane (idle), a block running along it (busy), its end in amber
    /// (waiting) or red (error), or dithered to half (off).
    public enum MarkState: Sendable, Equatable { case idle, busy, waiting, error, off }

    /// The phone's state for the mark: the Mac out of reach first, then what waits for the user, then work under way.
    public static func markState(reachable: Bool, waiting: Int, busy: Bool) -> MarkState {
        if !reachable { return .off }
        if waiting > 0 { return .waiting }
        return busy ? .busy : .idle
    }

    /// Off: every other cell, a checkerboard.
    public static func dithered(_ cell: Cell) -> Bool { (cell.x + cell.y) % 2 == 1 }

    // MARK: sprites (5 × 5 and smaller), "#" lit

    public static let square = ["####", "####", "####", "####"]
    public static let hollow = ["####", "#..#", "#..#", "####"]
    public static let lock = [".###.", "#...#", "#####", "##.##", "#####"]
    /// A picture (a frame, a hill, the sun): the terminal reply box's photo button.
    public static let picture = ["#######", "#....##", "#.....#", "#..#..#", "#.###.#", "#######"]
    /// Each agent's mark, from its own logo: Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π.
    public static let agents: [String: [String]] = LiveArt.agents
    /// The terminals tab and window: a framed terminal (">_" alone means Codex).
    public static let terminalWindow = ["#########", "#.......#", "#.#.....#", "#..#....#", "#.#..##.#", "#.......#", "#########"]

    /// The lit cells of a sprite.
    public static func sprite(_ rows: [String]) -> [(x: Int, y: Int)] {
        rows.enumerated().flatMap { y, row in row.enumerated().compactMap { x, c in c == "#" ? (x, y) : nil } }
    }

    // MARK: the wordmark

    /// The wordmark's letters, 5 × 7 (pixel.js `FONT`).
    public static let letters: [Character: [String]] = [
        "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
        "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
        "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
        "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
        "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
        "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
        "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
        "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
        "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
        "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    ]

    /// A word in the wordmark's letters, 7 rows, one empty column between letters; letters it lacks are left out.
    public static func wordRows(_ word: String) -> [String] {
        let glyphs = word.uppercased().compactMap { letters[$0] }
        return (0..<7).map { y in glyphs.map { $0[y] }.joined(separator: ".") }
    }

    /// The same rows with 2-cell strokes on half-size cells: the settled wordmark's grid (its signal offset is one of
    /// these cells, half a stroke).
    public static func fine(_ rows: [String]) -> [String] {
        rows.flatMap { row -> [String] in
            let wide = String(row.flatMap { [$0, $0] })
            return [wide, wide]
        }
    }

    /// The half-lit cells in the diagonal steps of any "#" sprite (as `markSmoothing` for the mark).
    public static func halfLit(_ rows: [String]) -> [(x: Int, y: Int)] {
        smoothing(rows).map { ($0.x, $0.y) }
    }

    // MARK: helpers

    static func cells(_ rows: [String]) -> [Cell] {
        rows.enumerated().flatMap { y, row in
            row.enumerated().compactMap { x, c in c == "." ? nil : Cell(x: x, y: y, lit: "aAS".contains(c), end: c == "A") }
        }
    }

    static func smoothing(_ rows: [String]) -> [Cell] {
        let grid = rows.map { Array($0) }
        func at(_ x: Int, _ y: Int) -> Character? { y >= 0 && y < grid.count && x >= 0 && x < grid[y].count ? grid[y][x] : nil }
        func on(_ x: Int, _ y: Int) -> Bool { at(x, y).map { $0 != "." } ?? false }
        var out: [Cell] = []
        for (y, row) in grid.enumerated() {
            for (x, c) in row.enumerated() where c == "." {
                let n = on(x, y - 1), s = on(x, y + 1), w = on(x - 1, y), e = on(x + 1, y)
                let corner = (n && e && !on(x + 1, y - 1)) || (n && w && !on(x - 1, y - 1)) || (s && e && !on(x + 1, y + 1)) || (s && w && !on(x - 1, y + 1))
                guard corner, [n, s, w, e].filter({ $0 }).count == 2, let lean = n ? at(x, y - 1) : at(x, y + 1) else { continue }
                out.append(Cell(x: x, y: y, lit: "aAS".contains(lean), end: false))
            }
        }
        return out
    }
}
