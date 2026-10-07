import Foundation

/// Only full screen asks the system to hide the menu bar and the Dock while AgentSwitch is in front: AppKit sets the
/// app's presentation options for a window that is full screen and takes them back when it leaves. The app sets none of
/// its own. On 2026-10-05 the menu bar hid whenever the app came to the front, in an ordinary window on an ordinary
/// desktop, until the app was restarted; how it got there was not found (closing the window in, into and out of full
/// screen did not do it in a stand-in). So a request that still stands when no window is full screen is taken back.
public enum StalePresentation {
    /// `options`: `NSApplication.presentationOptions`' raw value (0: the default).
    public static func isStale(options: UInt, anyWindowFullScreen: Bool) -> Bool {
        options != 0 && !anyWindowFullScreen
    }

    /// Looked at a moment apart: a window on its way into or out of full screen passes through such a state, so the
    /// request is taken back only when it was left over twice running.
    public struct Watch: Sendable {
        private var seen = false

        public init() {}

        public mutating func shouldReset(options: UInt, anyWindowFullScreen: Bool) -> Bool {
            guard StalePresentation.isStale(options: options, anyWindowFullScreen: anyWindowFullScreen) else { seen = false; return false }
            if seen { seen = false; return true }
            seen = true
            return false
        }
    }

    /// The time between the two looks.
    public static let interval: TimeInterval = 1.5
}
