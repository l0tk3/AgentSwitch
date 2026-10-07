import Foundation

/// The app's pixel marks (docs/ui-v0.md §7.3) as data: the views and the menu-bar image draw them. The same shapes as
/// the terminal page's `packages/daemon/ui/pixel.js` — keep the two in step.
public enum PixelArt {
    /// A cell of a mark: its place, and whether it belongs to the lit lane (the icon's highlighted one) and its end.
    public struct Cell: Sendable, Equatable {
        public let x: Int
        public let y: Int
        public let lit: Bool
        public let end: Bool
    }

    /// One source switched onto three lanes — the Dispatch page's icon (the app's own mark until 2026-10-04, hence the
    /// name; the app's mark is the stack below): S = source, a/b/c = lanes, A/B/C = their ends; the top lane is the lit
    /// one. 14 × 11, y down.
    public static let markRows = [
        "...........AAA",
        "......aaaaaAAA",
        ".....a.....AAA",
        "....a.........",
        "SSSa.......BBB",
        "SSSbbbbbbbbBBB",
        "SSSc.......BBB",
        "....c.........",
        ".....c.....CCC",
        "......cccccCCC",
        "...........CCC",
    ]
    public static let markWidth = 14
    public static let markHeight = 11

    public static let markCells: [Cell] = cells(markRows)

    /// The lit lane from the source to its end, the way the busy block runs.
    public static let laneA: [(x: Int, y: Int)] = [(3, 4), (4, 3), (5, 2), (6, 1), (7, 1), (8, 1), (9, 1), (10, 1)]

    /// Empty cells in an inside corner of a diagonal step: a half-lit pixel there smooths the step (sub-pixel
    /// anti-aliasing, for marks of 20 pt and up). Each carries the lit/dim role of the cell it leans on.
    public static let markSmoothing: [Cell] = smoothing(markRows)

    /// The app's mark in one colour, for the menu bar (docs/ui-v0.md §10): the front window as a solid panel with its
    /// prompt cut out of it — the pixel app icon's front window, cell for cell — and the edge of one window behind it
    /// (the first one drew three windows as outlines; the user: 可以简化一下突出主体). 14 × 11.
    /// P = the panel, p = its prompt, b = the window behind.
    public static let stackRows = [
        "...bbbbbbbbbb.", ".............b", ".PPPPPPPPPP..b", "PPPPPPPPPPPP.b", "PPppPPPPPPPP.b", "PPPppPPPPPPP.b", "PPPPppPPPPPP.b",
        "PPPppPPPPPPP.b", "PPppPPppppPP..", "PPPPPPPPPPPP..", ".PPPPPPPPPP...",
    ]

    /// A cell of that mark: its place and the part it belongs to.
    public struct StackCell: Sendable, Equatable {
        public enum Part: Sendable, Equatable { case panel, prompt, behind }
        public let x: Int
        public let y: Int
        public let part: Part
    }

    public static let stackCells: [StackCell] = stackRows.enumerated().flatMap { y, row in
        row.enumerated().compactMap { x, c in
            switch c {
            case "P": return StackCell(x: x, y: y, part: .panel)
            case "p": return StackCell(x: x, y: y, part: .prompt)
            case "b": return StackCell(x: x, y: y, part: .behind)
            default: return nil
            }
        }
    }

    /// How a part of the one-colour mark shows in a state: true in full, false faint, nil not at all. Idle: the panel
    /// in full, its prompt a hole in it, the window behind faint. Busy: the window behind in full too. Waiting or an
    /// error: the panel faint and the prompt lit. Off is the idle picture, made less of by whoever draws it: the
    /// pixel look takes every other cell away, the classic look fades the whole mark.
    public static func stackShows(_ part: StackCell.Part, in state: MarkState) -> Bool? {
        switch (state, part) {
        case (.idle, .panel), (.off, .panel), (.busy, .panel), (.busy, .behind), (.waiting, .prompt), (.error, .prompt): return true
        case (.idle, .behind), (.off, .behind), (.waiting, _), (.error, _): return false
        case (.idle, .prompt), (.off, .prompt), (.busy, .prompt): return nil
        }
    }

    /// The same for a cell of the pixel look's mark: off, every other cell is gone.
    public static func stackShows(_ cell: StackCell, in state: MarkState) -> Bool? {
        state == .off && (cell.x + cell.y) % 2 == 1 ? nil : stackShows(cell.part, in: state)
    }

    /// How the mark shows the whole app: at rest (idle), its title bar in the busy colour with a block running along
    /// it (busy), in amber (waiting) or red (error), or dithered to half (off).
    public enum MarkState: Sendable, Equatable { case idle, busy, waiting, error, off }

    /// The app's state for the mark: the services first, then whether anything waits for the user.
    public static func markState(_ level: StatusLevel, waiting: Int = 0) -> MarkState {
        switch level {
        case .error: return .error
        case .warning: return .waiting
        case .busy: return .busy
        case .off: return .off
        case .ok: return waiting > 0 ? .waiting : .idle
        }
    }

    /// Off: every other cell, a checkerboard.
    public static func dithered(_ cell: Cell) -> Bool { (cell.x + cell.y) % 2 == 1 }

    // MARK: sprites (5 × 5 and smaller), "#" lit

    public static let square = ["####", "####", "####", "####"]
    public static let hollow = ["####", "#..#", "#..#", "####"]
    public static let lock = [".###.", "#...#", "#####", "##.##", "#####"]
    /// Each agent's mark, from its own logo: Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π.
    public static let agents: [String: [String]] = [
        "claude-code": ["#.#.#", ".###.", "#####", ".###.", "#.#.#"],
        "codex": [".....", "#....", ".#...", "#.###", "....."],
        "opencode": ["##.##", "#...#", "#...#", "#...#", "##.##"],
        "pi": ["#####", ".#.#.", ".#.#.", ".#.#.", ".#..#"],
    ]
    /// The terminals tab and window: a framed terminal (">_" alone means Codex).
    public static let terminalWindow = ["#########", "#.......#", "#.#.....#", "#..#....#", "#.#..##.#", "#.......#", "#########"]

    /// The main window's bar (once the terminal window's toolbar), in 1 pt cells (the weight of the system's icons beside the traffic lights; corners
    /// stepped): the list (a window with its sidebar) and new terminal. docs/design/implemented/terminal.html, "细像素".
    public static let toolbarList = [
        ".################.", "#.....#..........#", "#.....#..........#", "#.###.#..........#", "#.....#..........#", "#.###.#..........#",
        "#.....#..........#", "#.###.#..........#", "#.....#..........#", "#.....#..........#", "#.....#..........#", "#.....#..........#",
        "#.....#..........#", ".################.",
    ]
    public static let toolbarNew = [
        "......#......", "......#......", "......#......", "......#......", "......#......", "......#......", "#############",
        "......#......", "......#......", "......#......", "......#......", "......#......", "......#......",
    ]

    /// The Terminals bar's split buttons (docs/terminal-v0.md §1 分屏, 2026-10-03; docs/design/implemented/split.html), the
    /// list's window with a line down its middle (split right) or across it (split down).
    public static let toolbarSplitRight = [
        ".################.", "#........#.......#", "#........#.......#", "#........#.......#", "#........#.......#", "#........#.......#",
        "#........#.......#", "#........#.......#", "#........#.......#", "#........#.......#", "#........#.......#", "#........#.......#",
        "#........#.......#", ".################.",
    ]
    public static let toolbarSplitDown = [
        ".################.", "#................#", "#................#", "#................#", "#................#", "#................#",
        "##################", "#................#", "#................#", "#................#", "#................#", "#................#",
        "#................#", ".################.",
    ]
    /// The simple view (docs/simple-view-v0.md): a page of lines, as a record reads.
    public static let toolbarRecord = [
        "##########.....", "...............", "###############", "...............", "############...", "...............", "###############",
        "...............", "########.......",
    ]
    /// The main window's settings (dispatch-v0 §1), at the toolbar's weight: three sliders (a gear at this size is a blob,
    /// docs/design/concepts/menu-icons.html); docs/design/implemented/mac-window.html `ICON.sliders`.
    public static let toolbarSettings = [
        "..##.........", "#############", "..##.........", ".............", ".............", "........##...", "#############",
        "........##...", ".............", ".............", ".....##......", "#############", ".....##......",
    ]

    /// The main window's rail (2026-10-03, proposal B, docs/design/implemented/window-bars.html), in the bar's 1 pt cells
    /// and one ink: the app's mark for Dispatch, a terminal window with its title bar and a prompt for Terminals, a globe
    /// — a one-pixel circle, a meridian, the equator — for Browser (the phone's tab icon drawn at 15 × 15); the settings
    /// at its foot are `toolbarSettings`.
    public static let railDispatch: [String] = markRows.map { String($0.map { $0 == "." ? "." : "#" }) }
    public static let railTerminals = [
        "################", "#..............#", "################", "#..............#", "#.#............#", "#..#...........#",
        "#...#..........#", "#..#...........#", "#.#...######...#", "#..............#", "#..............#", "################",
    ]
    public static let railBrowser = [
        ".....#####.....", "...##.....##...", "..#..#...#..#..", ".#..#.....#..#.", ".#..#.....#..#.", "#...#.....#...#",
        "#...#.....#...#", "###############", "#...#.....#...#", "#...#.....#...#", ".#..#.....#..#.", ".#..#.....#..#.",
        "..#..#...#..#..", "...##.....##...", ".....#####.....",
    ]

    /// The lit cells of a sprite.
    public static func sprite(_ rows: [String]) -> [(x: Int, y: Int)] {
        rows.enumerated().flatMap { y, row in row.enumerated().compactMap { x, c in c == "#" ? (x, y) : nil } }
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
