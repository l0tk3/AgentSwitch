import AgentSwitchKit
import SwiftUI

/// Each agent's logo as its own command-line program draws it on its start screen (`AgentLogoArt`, user #590: 图标统一放
/// 各家cli里放的那个图标), cell by cell in its own colours, in both looks — as the Mac draws it (AgentLogo.swift there):
/// the new terminal's tiles, and beside the name in a terminal's simple view.
struct AgentLogo: View {
    let harness: String
    var size: CGFloat = 28
    /// Drawn in the page's ink where its program draws in the terminal's own colour; this ink instead (a dimmed tile).
    var ink: Color = Theme.ink

    var body: some View {
        Canvas { ctx, box in Self.draw(harness, &ctx, CGRect(origin: .zero, size: box), ink: ink) }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    static func draw(_ harness: String, _ ctx: inout GraphicsContext, _ r: CGRect, ink: Color) {
        guard let art = AgentLogoArt.art[harness] ?? AgentLogoArt.art["pi"] else { return }
        let wide = art.rows.map(\.count).max() ?? 0, high = art.rows.count
        guard wide > 0, high > 0 else { return }
        let tall = CGFloat(AgentLogoArt.tall[harness] ?? 1)
        let cell = min(r.width / CGFloat(wide), r.height / (CGFloat(high) * tall))
        let left = r.midX - cell * CGFloat(wide) / 2, top = r.midY - cell * tall * CGFloat(high) / 2
        var colours: [Character: Color] = [:]
        for (key, hex) in art.colours {
            guard let k = key.first else { continue }
            colours[k] = hex == "ink" ? ink : colour(hex)
        }
        for (y, row) in art.rows.enumerated() {
            for (x, key) in row.enumerated() where key != "." {
                // A hair over a cell, so neighbouring cells meet without a seam.
                let box = CGRect(x: left + CGFloat(x) * cell, y: top + CGFloat(y) * cell * tall, width: cell + 0.3, height: cell * tall + 0.3)
                ctx.fill(Path(box), with: .color(colours[key] ?? ink))
            }
        }
    }

    /// `RRGGBB` as the program drew it.
    private static func colour(_ hex: String) -> Color {
        let v = UInt32(hex, radix: 16) ?? 0
        return Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
