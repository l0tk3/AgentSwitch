import Foundation

/// The first-run wizard's steps (docs/control-v0.md §6); each can be skipped.
public enum SetupStep: Int, CaseIterable, Sendable, Identifiable {
    case executors, pairing, permissions, done

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .executors: return "执行器"
        case .pairing: return "配对手机"
        case .permissions: return "权限与启动"
        case .done: return "完成"
        }
    }

    public var next: SetupStep? { SetupStep(rawValue: rawValue + 1) }
    public var previous: SetupStep? { SetupStep(rawValue: rawValue - 1) }
}

/// `{flowVersion, lastCompletedStep, closedAt, outcome}` in UserDefaults, written after every step.
public struct SetupWizardState: Equatable, Sendable {
    public enum Outcome: String, Sendable {
        /// Went through to 完成.
        case completed
        /// Closed with Esc / 跳过引导.
        case skipped
        /// Never shown: a phone was already paired when the app first ran with the wizard.
        case alreadySetUp
    }

    /// Bump when the steps change enough that everyone should see the wizard again.
    public static let currentFlow = 1
    public static let key = "setupWizard"
    public static let fresh = SetupWizardState(flowVersion: currentFlow, lastCompletedStep: -1, closedAt: nil, outcome: nil)

    public let flowVersion: Int
    /// -1 before the first step is done.
    public let lastCompletedStep: Int
    public let closedAt: Date?
    public let outcome: Outcome?

    public init(flowVersion: Int, lastCompletedStep: Int, closedAt: Date?, outcome: Outcome?) {
        self.flowVersion = flowVersion
        self.lastCompletedStep = lastCompletedStep
        self.closedAt = closedAt
        self.outcome = outcome
    }

    public init?(dictionary: [String: Any]) {
        guard let flow = (dictionary["flowVersion"] as? NSNumber)?.intValue else { return nil }
        flowVersion = flow
        lastCompletedStep = (dictionary["lastCompletedStep"] as? NSNumber)?.intValue ?? -1
        switch dictionary["closedAt"] {
        case let date as Date: closedAt = date
        case let number as NSNumber: closedAt = FlexibleDate.fromNumber(number.doubleValue)
        default: closedAt = nil
        }
        outcome = (dictionary["outcome"] as? String).flatMap(Outcome.init(rawValue:))
    }

    /// Property-list values only, so `defaults read` shows it as written.
    public var dictionary: [String: Any] {
        var out: [String: Any] = ["flowVersion": flowVersion, "lastCompletedStep": lastCompletedStep]
        if let closedAt { out["closedAt"] = closedAt }
        if let outcome { out["outcome"] = outcome.rawValue }
        return out
    }

    public var isClosed: Bool { closedAt != nil && flowVersion >= SetupWizardState.currentFlow }

    /// Where a wizard left open (the app quit mid-way) picks up.
    public var resumeStep: SetupStep {
        SetupStep(rawValue: min(max(lastCompletedStep + 1, 0), SetupStep.done.rawValue)) ?? .executors
    }

    public func completing(_ step: SetupStep) -> SetupWizardState {
        SetupWizardState(flowVersion: SetupWizardState.currentFlow, lastCompletedStep: max(lastCompletedStep, step.rawValue),
                         closedAt: closedAt, outcome: outcome)
    }

    public func closing(_ outcome: Outcome, at date: Date) -> SetupWizardState {
        SetupWizardState(flowVersion: SetupWizardState.currentFlow, lastCompletedStep: lastCompletedStep, closedAt: date, outcome: outcome)
    }
}

/// Reads and writes the state; `defaults == nil` keeps it in memory only (the design preview).
public struct SetupWizardStore {
    private let defaults: UserDefaults?

    public init(defaults: UserDefaults?) { self.defaults = defaults }

    public func load() -> SetupWizardState? {
        (defaults?.dictionary(forKey: SetupWizardState.key)).flatMap(SetupWizardState.init(dictionary:))
    }

    public func save(_ state: SetupWizardState) {
        defaults?.set(state.dictionary, forKey: SetupWizardState.key)
    }
}

/// Whether to open the wizard on this launch: once, for someone who has not paired a phone yet.
public enum SetupWizardLaunch {
    public enum Decision: Equatable, Sendable {
        case show(SetupStep)
        /// A phone is already paired: record the wizard as done without showing it.
        case markAlreadySetUp
        /// Ask again once the paired devices are known.
        case wait
        case nothing
    }

    /// Seconds to wait for the daemon's device list before deciding without it.
    public static let deviceWait: TimeInterval = 30

    /// `pairedDevices`: active devices, nil while the daemon has not answered. `gaveUpWaiting`: `deviceWait` passed.
    public static func decide(state: SetupWizardState?, pairedDevices: Int?, gaveUpWaiting: Bool) -> Decision {
        if state?.isClosed == true { return .nothing }
        let resume = state?.flowVersion == SetupWizardState.currentFlow ? state?.resumeStep ?? .executors : .executors
        switch pairedDevices {
        case .some(let n) where n > 0: return .markAlreadySetUp
        case .some: return .show(resume)
        case .none: return gaveUpWaiting ? .show(resume) : .wait
        }
    }

    /// `-onboarded YES` on the command line (smoke tests, development) skips the wizard for that launch. Argument-domain
    /// values arrive as strings.
    public static func truthy(_ value: Any?) -> Bool {
        switch value {
        case let flag as Bool: return flag
        case let number as NSNumber: return number.boolValue
        case let text as String: return ["yes", "true", "1"].contains(text.lowercased())
        default: return false
        }
    }
}
