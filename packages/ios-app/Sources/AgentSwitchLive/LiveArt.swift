/// The pixel shapes the Live Activity draws, here with no dependencies for the widget extension; the app's PixelArt
/// (AgentSwitchKit) takes them from here, so there is one copy (docs/ui-v0.md §7.3; the same shapes as
/// `packages/daemon/ui/pixel.js` and the Mac app's `PixelArt`).
public enum LiveArt {
    /// One source switched onto three lanes, as the app icon: S = source, a/b/c = lanes, A/B/C = their ends; the top
    /// lane is the lit one. 14 × 11, y down.
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

    /// The lit lane from the source to its end, the way the busy block runs.
    public static let laneA: [(x: Int, y: Int)] = [(3, 4), (4, 3), (5, 2), (6, 1), (7, 1), (8, 1), (9, 1), (10, 1)]

    /// Each agent's 5 × 5 mark, by harness.
    public static let agents: [String: [String]] = [
        "claude-code": ["#.#.#", ".###.", "#####", ".###.", "#.#.#"],
        "codex": ["#....", ".#...", "..#..", ".#...", "#.###"],
        "opencode": ["##.##", "#...#", "#...#", "#...#", "##.##"],
        "pi": ["#####", ".#.#.", ".#.#.", ".#.#.", ".#..#"],
    ]

    /// A terminal row names its agent as the app shows it (ModelName.harness): the harness for that name.
    public static func harness(named name: String) -> String? {
        ["Claude Code": "claude-code", "Codex": "codex", "OpenCode": "opencode", "pi": "pi"][name]
    }
}
