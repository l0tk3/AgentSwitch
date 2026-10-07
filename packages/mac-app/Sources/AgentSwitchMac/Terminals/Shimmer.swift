import SwiftUI

/// Words for something still going (what the agent is doing now, a run of work not ended): quiet, with a band of the
/// ink's full colour running across them (docs/simple-view-v0.md §5.1; 2026-10-07, user, of the agents' own apps:
/// 思考过程中的闪烁能不能加上). The classic look's band is soft; the pixel look's is a block that moves in steps. Still
/// under Reduce Motion.
struct Shimmer: ViewModifier {
    let on: Bool
    @Environment(\.interfaceLook) private var look
    @Environment(\.accessibilityReduceMotion) private var still

    /// One pass across the words.
    static let lap = 1.9

    func body(content: Content) -> some View {
        if on, !still {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    GeometryReader { geo in
                        let whole = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.lap) / Self.lap
                        let part = look.isClassic ? whole : (whole * 18).rounded(.down) / 18
                        let band = look.isClassic ? max(44, geo.size.width * 0.34) : 22
                        Rectangle()
                            .fill(look.isClassic
                                  ? AnyShapeStyle(LinearGradient(colors: [Look.ink.opacity(0), Look.ink, Look.ink.opacity(0)], startPoint: .leading, endPoint: .trailing))
                                  : AnyShapeStyle(Look.ink))
                            .frame(width: band)
                            .offset(x: -band + (geo.size.width + band) * part)
                    }
                }
                .mask { content }
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }
}

extension View {
    /// A band of light across words for something still going.
    func shimmer(_ on: Bool = true) -> some View { modifier(Shimmer(on: on)) }
}
