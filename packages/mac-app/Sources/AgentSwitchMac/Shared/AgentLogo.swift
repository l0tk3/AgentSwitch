import AgentSwitchMacCore
import AppKit
import SwiftUI

/// Each agent's logo beside its name in the simple view's head: the one its own command-line program draws on its
/// start screen (`AgentLogoArt`, user #590: 图标统一放各家cli里放的那个图标), in its own colours, in both looks — on a
/// soft rounded tile in the classic look, in a square frame in the pixel look.
struct AgentLogo: View {
    let harness: String
    var size: CGFloat = 36
    /// The art alone, no tile or frame under it (the new-terminal sheet's tiles).
    var bare = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        ZStack {
            if bare {
                EmptyView()
            } else if look.isClassic {
                RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous).fill(Look.hover)
            } else {
                Rectangle().strokeBorder(Look.line, lineWidth: 1)
            }
            Canvas { ctx, box in draw(&ctx, CGRect(origin: .zero, size: box).insetBy(dx: bare ? 0 : box.width * 0.18, dy: bare ? 0 : box.height * 0.18)) }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(TerminalListText.agentName(harness))
    }

    private func draw(_ ctx: inout GraphicsContext, _ r: CGRect) {
        guard let art = AgentLogoArt.art[harness] ?? AgentLogoArt.art["pi"] else { return }
        let wide = art.rows.map(\.count).max() ?? 0, high = art.rows.count
        guard wide > 0, high > 0 else { return }
        let tall = CGFloat(AgentLogoArt.tall[harness] ?? 1)
        let cell = min(r.width / CGFloat(wide), r.height / (CGFloat(high) * tall))
        let left = r.midX - cell * CGFloat(wide) / 2, top = r.midY - cell * tall * CGFloat(high) / 2
        var colours: [Character: Color] = [:]
        for (key, hex) in art.colours {
            guard let k = key.first else { continue }
            colours[k] = hex == "ink" ? Look.ink : Self.colour(hex)
        }
        for (y, row) in art.rows.enumerated() {
            for (x, key) in row.enumerated() where key != "." {
                // A hair over a cell, so neighbouring cells meet without a seam.
                let box = CGRect(x: left + CGFloat(x) * cell, y: top + CGFloat(y) * cell * tall, width: cell + 0.3, height: cell * tall + 0.3)
                ctx.fill(Path(box), with: .color(colours[key] ?? Look.ink))
            }
        }
    }

    /// `RRGGBB` as the program drew it.
    private static func colour(_ hex: String) -> Color {
        let v = UInt32(hex, radix: 16) ?? 0
        let red = CGFloat((v >> 16) & 0xFF) / 255, green = CGFloat((v >> 8) & 0xFF) / 255, blue = CGFloat(v & 0xFF) / 255
        return Color(nsColor: NSColor(srgbRed: red, green: green, blue: blue, alpha: 1))
    }
}
