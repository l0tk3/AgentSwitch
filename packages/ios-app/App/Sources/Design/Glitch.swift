import SwiftUI

/// One burst when something changes (docs/ui-v0.md §7.2.9), the web page's `.glitch` on a native view: 0.45 s in steps
/// — sideways jolts, bands of the view cut away, the cyan and signal copies pulled apart, one inverted frame. Nothing
/// under Reduce Motion.
struct Glitch<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    /// Also when the view appears (a box that only exists while open).
    var onAppear = false
    /// Only a change to a value this accepts (needs you, exited), not every change.
    var when: ((Trigger) -> Bool)?
    @State private var frame: Frame?
    @State private var run: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The classic look has no bursts (docs/ui-v0.md §8 动效).
    @Environment(\.interfaceLook) private var look

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
            .onAppear { if onAppear { play() } }
            // A burst cut short (the row scrolled away, the page left) must not keep its last frame: the state outlives
            // the disappearance, and the row came back half cut away (2026-10-01, user: 正在工作的 session 怎么只显示了半截).
            .onDisappear {
                run?.cancel()
                frame = nil
            }
    }

    private func play() {
        guard !reduceMotion, !look.isClassic else { return }
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
    struct Drawn: ViewModifier {
        let frame: Frame?
        func body(content: Content) -> some View {
            let f = frame
            content
                .background {
                    if let f, f.split != 0 {
                        content.colorMultiply(Theme.busy).offset(x: f.split).opacity(0.9)
                        content.colorMultiply(Theme.signal).offset(x: -f.split).opacity(0.9)
                    }
                }
                .offset(x: f?.dx ?? 0, y: f?.dy ?? 0)
                .modifier(Band(frame: f))
                .modifier(Inverted(on: f?.invert == true))
        }
    }

    /// Only the band that stays, while a frame cuts one (otherwise nothing is masked: a shadow outside the view stays).
    private struct Band: ViewModifier {
        let frame: Frame?
        func body(content: Content) -> some View {
            if let f = frame, f.top > 0 || f.bottom > 0 {
                content.mask {
                    GeometryReader { g in
                        let top = f.top * g.size.height, bottom = f.bottom * g.size.height
                        // Room for the jolts and the split copies beside the view.
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

/// While something runs, a short burst now and then (2026-10-01, user: 正在运行中的都改成这个效果（glitch 动效）; ui-v0
/// §7.2.9): the bands and the split copies, no inverted frame, 0.14 s every 3 to 7 seconds, so the full burst stays the
/// sign that something happened (it waits for you, it ended). Nothing under Reduce Motion.
struct RunningGlitch: ViewModifier {
    let running: Bool
    @State private var frame: Glitch<Bool>.Frame?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Not while the app is not in front (ui-v0 §7.4, 2026-10-03).
    @Environment(\.scenePhase) private var scenePhase
    /// Nor in the classic look (§8 动效).
    @Environment(\.interfaceLook) private var look

    static var frames: [(Double, Glitch<Bool>.Frame?)] {
        [(0, .init(dx: -3, top: 0.14, bottom: 0.46, split: 3)),
         (0.05, .init(dx: 3, top: 0.56, bottom: 0.1, split: -2)),
         (0.1, .init(split: 1)),
         (0.14, nil)]
    }

    func body(content: Content) -> some View {
        content
            .modifier(Glitch<Bool>.Drawn(frame: frame))
            .task(id: running && !reduceMotion && scenePhase == .active && !look.isClassic) {
                guard running, !reduceMotion, scenePhase == .active, !look.isClassic else { frame = nil; return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 3000...7000)))
                    var elapsed = 0.0
                    for (at, next) in Self.frames where !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(Int((at - elapsed) * 1000)))
                        elapsed = at
                        frame = next
                    }
                }
                // Cut short (it stopped running, the row went away): never left on a frame.
                frame = nil
            }
    }
}

extension View {
    /// Short bursts now and then while `running`.
    func runningGlitch(_ running: Bool) -> some View {
        modifier(RunningGlitch(running: running))
    }

    /// A glitch burst each time `trigger` changes (to a value `when` accepts, if given; and as the view appears, with
    /// `onAppear`).
    func glitch<T: Equatable>(on trigger: T, onAppear: Bool = false, when: ((T) -> Bool)? = nil) -> some View {
        modifier(Glitch(trigger: trigger, onAppear: onAppear, when: when))
    }
}
