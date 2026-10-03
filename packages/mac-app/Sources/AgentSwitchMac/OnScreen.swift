import AgentSwitchMacCore
import AppKit
import SwiftUI

// What moves moves only while it is seen (docs/ui-v0.md §7.4, 2026-10-03; Motion in Core): each window's (and each
// page's) SwiftUI root watches where it is and says so in `\.onScreen`; the spinner, the blinking square, the mark and
// the clocks read it and hold still while it is false. AppKit and SwiftUI keep ticking and drawing a window that is
// covered, minimised or hidden, and a hidden page, if nothing stops them.

extension EnvironmentValues {
    /// This part of a window is seen. True where nobody says otherwise (a picture drawn off screen draws its frame).
    @Entry var onScreen = true
}

extension View {
    /// Puts whether this part of its window is seen into `\.onScreen` for what it wraps.
    func followsWindow() -> some View { modifier(FollowsWindow()) }
}

private struct FollowsWindow: ViewModifier {
    @State private var seen = true

    func body(content: Content) -> some View {
        content
            .environment(\.onScreen, seen)
            .background(SeenProbe { seen = $0 })
    }
}

/// An empty view in the wrapped view's place that reports when it starts or stops being seen.
private struct SeenProbe: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> SeenProbeView { SeenProbeView(changed: changed) }
    func updateNSView(_ view: SeenProbeView, context: Context) { view.changed = changed }
    /// Whatever it is offered (no Auto Layout pass to measure an empty view on every layout).
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: SeenProbeView, context: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions()
    }
}

final class SeenProbeView: NSView {
    var changed: (Bool) -> Void
    private var watcher: SeenWatcher!

    init(changed: @escaping (Bool) -> Void) {
        self.changed = changed
        super.init(frame: .zero)
        // Told after the SwiftUI update under way (a state change inside one is not allowed).
        watcher = SeenWatcher(view: self) { [weak self] seen in
            DispatchQueue.main.async { self?.changed(seen) }
        }
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        watcher.windowChanged()
    }

    override func viewDidHide() {
        super.viewDidHide()
        watcher.check()
    }

    override func viewDidUnhide() {
        super.viewDidUnhide()
        watcher.check()
    }
}

/// Whether a view is seen (`Motion.Place`): its window on screen, it and the views around it not hidden. The view
/// calls `windowChanged()` from `viewDidMoveToWindow` and `check()` from `viewDidHide` / `viewDidUnhide`; the watcher
/// follows the window's occlusion, minimising and closing itself. `changed` hears every change, and the first answer.
@MainActor
final class SeenWatcher {
    private weak var view: NSView?
    var changed: (Bool) -> Void
    private(set) var seen: Bool?
    private var closing = false
    private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

    init(view: NSView, changed: @escaping (Bool) -> Void) {
        self.view = view
        self.changed = changed
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func windowChanged() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        closing = false
        if let window = view?.window {
            let center = NotificationCenter.default
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification] {
                observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.closing = false
                        self?.check()
                    }
                })
            }
            observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.closing = true
                    self?.check()
                }
            })
        }
        check()
    }

    func check() {
        let window = view?.window
        let place = Motion.Place(inWindow: window != nil && !closing, windowVisible: window?.isVisible ?? false,
                                 occluded: !(window?.occlusionState.contains(.visible) ?? false),
                                 miniaturized: window?.isMiniaturized ?? false, hidden: view?.isHiddenOrHasHiddenAncestor ?? true)
        guard place.seen != seen else { return }
        seen = place.seen
        changed(place.seen)
    }
}

/// A timeline that steps only when a clock turns (`ClockTicks`): rows' `0:42`, a code's `Expires in 4:59` (stopping
/// once it has run out).
struct ClockSchedule: TimelineSchedule {
    let origins: [Date]
    var until: Date?

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        ClockTicks.moments(from: startDate, origins: origins, until: until)
    }
}
