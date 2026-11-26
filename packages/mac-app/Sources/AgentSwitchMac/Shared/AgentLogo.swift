import AgentSwitchMacCore
import SwiftUI

/// Each agent's mark beside its name in the simple view's head (user #582: 简略视图里能不能把各家agent的logo画上去).
/// Drawn here, not shipped as pictures: in the classic look a simple drawing in the maker's colours on a soft tile —
/// Claude Code's sunburst, Codex's six-petalled knot, OpenCode's block, pi's π, Grok's slashed ring, Antigravity's
/// arch in Google's four colours; in the pixel look the agent's own pixel mark (`PixelArt.agents`), as its tile has.
struct AgentLogo: View {
    let harness: String
    var size: CGFloat = 36
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ZStack {
                RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous).fill(tile)
                Canvas { ctx, box in draw(&ctx, CGRect(origin: .zero, size: box).insetBy(dx: box.width * 0.2, dy: box.height * 0.2)) }
            }
            .frame(width: size, height: size)
            .accessibilityLabel(TerminalListText.agentName(harness))
        } else {
            PixelSprite(rows: PixelArt.agents[harness] ?? PixelArt.agents["pi"]!, pixel: 3, color: Look.ink, strength: 1, shadow: true)
                .frame(width: size, height: size)
                .overlay(Rectangle().strokeBorder(Look.line, lineWidth: 1))
                .accessibilityLabel(TerminalListText.agentName(harness))
        }
    }

    private var ink: Color { Look.ink }

    private var tile: Color {
        switch harness {
        case "claude-code": Look.brandClaude.opacity(0.16)
        case "agy": Look.brandGoogle[3].opacity(0.13)
        default: Look.hover
        }
    }

    private func draw(_ ctx: inout GraphicsContext, _ r: CGRect) {
        let c = CGPoint(x: r.midX, y: r.midY), s = r.width
        switch harness {
        case "claude-code":
            // A sunburst: twelve rays, long and short in turn.
            var p = Path()
            for i in 0..<12 {
                let a = Double(i) / 12 * 2 * .pi - .pi / 2, len = s * (i % 2 == 0 ? 0.5 : 0.36)
                p.move(to: CGPoint(x: c.x + cos(a) * s * 0.08, y: c.y + sin(a) * s * 0.08))
                p.addLine(to: CGPoint(x: c.x + cos(a) * len, y: c.y + sin(a) * len))
            }
            ctx.stroke(p, with: .color(Look.brandClaude), style: StrokeStyle(lineWidth: s * 0.11, lineCap: .round))
        case "codex":
            // A knot of six rounded links turned about the middle.
            for i in 0..<6 {
                let link = Path(roundedRect: CGRect(x: -s * 0.13, y: -s * 0.46, width: s * 0.26, height: s * 0.5), cornerRadius: s * 0.13)
                let t = CGAffineTransform(translationX: c.x, y: c.y).rotated(by: Double(i) / 6 * 2 * .pi)
                ctx.stroke(link.applying(t), with: .color(ink), lineWidth: s * 0.075)
            }
        case "opencode":
            // A block with a hollow: the square of its pixel letters.
            var p = Path(CGRect(x: c.x - s * 0.36, y: c.y - s * 0.44, width: s * 0.72, height: s * 0.88))
            p.addRect(CGRect(x: c.x - s * 0.18, y: c.y - s * 0.26, width: s * 0.36, height: s * 0.52))
            ctx.fill(p, with: .color(ink), style: FillStyle(eoFill: true))
        case "grok":
            // A ring broken by a slash.
            // The ring in two halves, parted where the slash crosses it (at 135° and 315°, y down).
            var ring = Path()
            for (from, to) in [(160.0, 290.0), (340.0, 470.0)] {
                for (i, deg) in stride(from: from, through: to, by: 5).enumerated() {
                    let a = deg * .pi / 180, pt = CGPoint(x: c.x + cos(a) * s * 0.36, y: c.y + sin(a) * s * 0.36)
                    if i == 0 { ring.move(to: pt) } else { ring.addLine(to: pt) }
                }
            }
            ctx.stroke(ring, with: .color(ink), style: StrokeStyle(lineWidth: s * 0.1, lineCap: .round, lineJoin: .round))
            var slash = Path()
            slash.move(to: CGPoint(x: c.x - s * 0.5, y: c.y + s * 0.5))
            slash.addLine(to: CGPoint(x: c.x + s * 0.5, y: c.y - s * 0.5))
            ctx.stroke(slash, with: .color(ink), style: StrokeStyle(lineWidth: s * 0.1, lineCap: .round))
        case "agy":
            // An arch, its legs apart, in Google's four colours.
            var arch = Path()
            arch.move(to: CGPoint(x: c.x - s * 0.46, y: c.y + s * 0.44))
            arch.addCurve(to: CGPoint(x: c.x + s * 0.46, y: c.y + s * 0.44),
                          control1: CGPoint(x: c.x - s * 0.3, y: c.y - s * 0.75), control2: CGPoint(x: c.x + s * 0.3, y: c.y - s * 0.75))
            let colours = Gradient(colors: Look.brandGoogle)
            ctx.stroke(arch, with: .linearGradient(colours, startPoint: CGPoint(x: r.minX, y: r.maxY), endPoint: CGPoint(x: r.maxX, y: r.maxY)),
                       style: StrokeStyle(lineWidth: s * 0.16, lineCap: .round))
        default:
            // pi: its letter.
            ctx.draw(Text("π").font(.system(size: s * 0.95, weight: .semibold, design: .serif)).foregroundColor(ink), at: c)
        }
    }
}
