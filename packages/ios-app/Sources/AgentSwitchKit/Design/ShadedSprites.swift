import AgentSwitchLive

/// The pixel look's shaded icons (docs/ui-v0.md §9): the pictures are AgentSwitchLive's, so the Live Activity draws the
/// same ones; here, which picture stands for which of the app's 1-bit sprites.
public typealias ShadedSprite = AgentSwitchLive.ShadedSprite
public typealias ShadedMark = AgentSwitchLive.ShadedMark

extension ShadedSprite {
    /// The shaded picture that stands for a 1-bit sprite in the pixel look, by its rows; nil for one that has none.
    public static func standing(for rows: [String]) -> ShadedSprite? {
        stands.first { $0.rows == rows }?.sprite
    }

    /// The tab bar's three (the app's mark, the terminal window, the globe), the lock, each agent's mark.
    static let stands: [(rows: [String], sprite: ShadedSprite)] = [
        (PixelArt.markRows, dispatch), (PixelArt.terminalWindow, terminals), (PixelArt.globe, browser), (PixelArt.lock, lock),
    ] + PixelArt.agents.keys.sorted().compactMap { harness in agents[harness].map { (PixelArt.agents[harness]!, $0) } }
}
