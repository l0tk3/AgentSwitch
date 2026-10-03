import SwiftUI

/// One burst when something happens (docs/ui-v0.md §7.2.9), ported from the iPhone's Glitch: 0.29 s in steps — sideways
/// jolts, bands of the view cut away, the cyan and signal copies pulled apart, one inverted frame. On the Dispatch page:
/// a new approval or question box, a task that fails. Never on a passive refresh, nothing under Reduce Motion, and a
/// burst cut short (the row scrolled away, the page left) never keeps its last frame.
struct GlitchBurst<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    /// Only a change to a value this accepts (a task that now failed), not every change.
    var when: ((Trigger) -> Bool)?
    /// Asked as the view appears: true plays it then (a box that arrived after the page loaded, shown for the first time).
    var onAppear: (() -> Bool)?
    @State private var frame: Frame?
    @State private var run: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct Frame: Equatable {
        var dx: CGFloat = 0
        var dy: CGFloat = 0
        /// The band that stays, as fractions cut from the top and the bottom.
        var top: CGFloat = 0
        var bottom: CGFloat = 0
        /// How far the cyan and signal copies stand off, left and right.
        var split: CGFloat = 0
        var invert = false
    }

    /// terminal.css `@keyframes glitch`, as (start in seconds, frame); the last one ends it.
    static var frames: [(Double, Frame?)] {
        [(0.036, Frame(dx: -4, top: 0.12, bottom: 0.52, split: 3)),
         (0.072, Frame(dx: 5, top: 0.58, bottom: 0.08, split: 3)),
         (0.108, Frame(dx: -2, dy: 1, top: 0.30, bottom: 0.36, split: -4)),
         (0.144, Frame(invert: true)),
         (0.180, Frame(split: 1)),
         (0.252, Frame(dx: 2, top: 0.70, split: 1)),
         (0.288, nil)]
    }

    func body(content: Content) -> some View {
        content
            .modifier(Drawn(frame: frame))
            .onChange(of: trigger) { _, new in if when?(new) ?? true { play() } }
            .onAppear { if onAppear?() == true { play() } }
            .onDisappear {
                run?.cancel()
                frame = nil
            }
    }

    private func play() {
        guard !reduceMotion else { return }
        run?.cancel()
        run = Task { @MainActor in
            var elapsed = 0.0
            for (at, next) in Self.frames {
                try? await Task.sleep(for: .milliseconds(Int((at - elapsed) * 1000)))
                guard !Task.isCancelled else { return }
                elapsed = at
                frame = next
            }
        }
    }

    /// One frame on the view: the split copies behind it, the jolt, the band that stays, the inversion.
    private struct Drawn: ViewModifier {
        let frame: Frame?

        func body(content: Content) -> some View {
            let f = frame
            content
                .background {
                    if let f, f.split != 0 {
                        content.colorMultiply(.busy).offset(x: f.split).opacity(0.9)
                        content.colorMultiply(.signal).offset(x: -f.split).opacity(0.9)
                    }
                }
                .offset(x: f?.dx ?? 0, y: f?.dy ?? 0)
                .modifier(Band(frame: f))
                .modifier(Inverted(on: f?.invert == true))
        }
    }

    /// Only the band that stays while a frame cuts one (otherwise nothing is masked: the shadow outside stays).
    private struct Band: ViewModifier {
        let frame: Frame?

        func body(content: Content) -> some View {
            if let f = frame, f.top > 0 || f.bottom > 0 {
                content.mask {
                    GeometryReader { g in
                        let top = f.top * g.size.height, bottom = f.bottom * g.size.height
                        Rectangle().frame(width: g.size.width + 16, height: max(0, g.size.height - top - bottom)).offset(x: -8, y: top)
                    }
                }
            } else {
                content
            }
        }
    }

    private struct Inverted: ViewModifier {
        let on: Bool

        func body(content: Content) -> some View {
            if on { content.colorInvert() } else { content }
        }
    }
}

extension View {
    /// A glitch burst each time `trigger` changes (to a value `when` accepts, if given), and as the view appears when
    /// `onAppear` says so.
    func glitch<T: Equatable>(on trigger: T, when: ((T) -> Bool)? = nil, onAppear: (() -> Bool)? = nil) -> some View {
        modifier(GlitchBurst(trigger: trigger, when: when, onAppear: onAppear))
    }
}
