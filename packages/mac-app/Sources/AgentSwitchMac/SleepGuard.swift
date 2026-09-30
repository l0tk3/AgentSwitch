import AppKit
import AgentSwitchMacCore
import IOKit.ps
import IOKit.pwr_mgt
import OSLog

private let sleepLog = Logger(subsystem: "com.agentswitch.mac", category: "sleep")

/// Keeps the Mac from sleeping when idle while AgentSwitch has work, a phone connected or a terminal open (2026-09-30,
/// user: the Mac slept while Claude Code ran in a terminal driven from the phone, and the phone — Claude's own remote
/// too — lost it; then again once a turn ended and the phone was put away). Nobody touches the Mac then, so it counts as
/// idle; an agent keeps it awake only in its own short turns (Claude Code's `caffeinate -t 300`). When to hold is
/// `AwakePolicy`. The display still sleeps; a closed lid without an external display still sleeps.
@MainActor
final class SleepGuard {
    /// 通用 › stay awake while working.
    static let enabledKey = "keepAwake"
    private var assertion = IOPMAssertionID(0)
    private var held = false
    private var policy = AwakePolicy()

    init() {
        UserDefaults.standard.register(defaults: [Self.enabledKey: true])
    }

    /// From each look at the service (`nil`: not up) and the remote's phones.
    func update(_ live: LiveSnapshot?, phoneOnline: Bool, at now: Date = Date()) {
        let awake = policy.wantsAwake(working: !(live?.rows.isEmpty ?? true), openTerminals: live?.open ?? 0,
                                      phoneOnline: phoneOnline, onBattery: Self.onBattery, at: now)
        let want = awake && UserDefaults.standard.bool(forKey: Self.enabledKey)
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

    /// Running on battery (a laptop off its charger); a desktop never is.
    private static var onBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return (source as String) == kIOPMBatteryPowerKey
    }
}
