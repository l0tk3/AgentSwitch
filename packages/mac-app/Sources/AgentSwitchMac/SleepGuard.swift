import AppKit
import IOKit.pwr_mgt
import OSLog

private let sleepLog = Logger(subsystem: "com.agentswitch.mac", category: "sleep")

/// Keeps the Mac from sleeping when idle while AgentSwitch has work or a phone connected (2026-09-30, user: the Mac
/// slept while Claude Code ran in a terminal driven from the phone, and the phone — Claude's own remote too — lost it).
/// Nobody touches the Mac then, so it counts as idle; an agent keeps it awake only in its own short turns (Claude Code's
/// `caffeinate -t 300`). The display still sleeps; a closed lid without an external display still sleeps.
@MainActor
final class SleepGuard {
    /// 通用 › stay awake while working.
    static let enabledKey = "keepAwake"
    private var assertion = IOPMAssertionID(0)
    private var held = false

    init() {
        UserDefaults.standard.register(defaults: [Self.enabledKey: true])
    }

    /// Hold while `busy` (and the user has not turned it off); let go otherwise.
    func update(busy: Bool) {
        let want = busy && UserDefaults.standard.bool(forKey: Self.enabledKey)
        guard want != held else { return }
        if want {
            let result = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                                     IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                                     "AgentSwitch: tasks, terminals or a phone at work" as CFString, &assertion)
            held = result == kIOReturnSuccess
            sleepLog.notice("stay awake: \(self.held ? "held" : "failed \(result)", privacy: .public)")
        } else {
            IOPMAssertionRelease(assertion)
            held = false
            sleepLog.notice("stay awake: released")
        }
    }
}
