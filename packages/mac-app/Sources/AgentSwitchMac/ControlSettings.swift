import AgentSwitchMacCore
import Foundation
import Observation

/// The daemon-side settings the Mac edits (docs/control-v0.md §1, §2): who answers approvals and the default work
/// folder. Both apply at once; nothing restarts. Every change replaces the whole value.
@MainActor
@Observable
final class ControlSettings {
    private(set) var policy: ApprovalPolicySettings?
    /// Why the policy could not be read (the page shows it instead of the form).
    private(set) var policyLoadProblem: String?
    /// Why the last change was refused; cleared by the next one that goes through.
    private(set) var policySaveProblem: String?
    private(set) var savingPolicy = false

    private(set) var workDir: WorkDirFact = .unknown
    private(set) var workDirSaveProblem: String?
    private(set) var savingWorkDir = false

    @ObservationIgnored private var workDirReadAt: Date?
    /// The poll reads the folder again this often (its problem can change: a volume unmounted, permissions).
    static let workDirRefresh: TimeInterval = 60

    // MARK: approval policy

    func loadPolicy(_ client: DaemonClient) async {
        do {
            policy = try await client.approvalPolicy()
            policyLoadProblem = nil
        } catch {
            policyLoadProblem = error.localizedDescription
        }
    }

    /// True when the daemon took it.
    @discardableResult
    func savePolicy(mode: ApprovalMode, human: [String], _ client: DaemonClient) async -> Bool {
        savingPolicy = true
        defer { savingPolicy = false }
        do {
            let saved = try await client.saveApprovalPolicy(ApprovalPolicyUpdate(mode: mode, human: human))
            policy = saved.keepingCategories(of: policy)
            policySaveProblem = nil
            return true
        } catch {
            policySaveProblem = "Not Saved · " + ((error as? DaemonError)?.reason ?? error.localizedDescription)
            return false
        }
    }

    // MARK: default work dir

    func loadWorkDir(_ client: DaemonClient) async {
        do {
            workDir = .known(try await client.workDir())
            workDirReadAt = Date()
        } catch DaemonError.notSupported {
            workDir = .unsupported
            workDirReadAt = Date()
        } catch {
            // Keep what was known; the next poll tries again.
        }
    }

    func refreshWorkDirIfStale(_ client: DaemonClient, now: Date = Date()) async {
        if let read = workDirReadAt, now.timeIntervalSince(read) < ControlSettings.workDirRefresh { return }
        await loadWorkDir(client)
    }

    /// The daemon checks the folder (not the home folder, not a protected one) and creates it; a refusal is kept in
    /// its own words. True when it took it.
    @discardableResult
    func setWorkDir(_ path: String, _ client: DaemonClient) async -> Bool {
        savingWorkDir = true
        defer { savingWorkDir = false }
        do {
            try await client.saveWorkDir(WorkDirUpdate(path: path))
            workDirSaveProblem = nil
            await loadWorkDir(client)
            return true
        } catch {
            workDirSaveProblem = (error as? DaemonError)?.reason ?? error.localizedDescription
            return false
        }
    }

    #if DEBUG
    /// `-designPreview`: a refused save, as the daemon would word it.
    func showDemoWorkDirProblem(_ text: String?) { workDirSaveProblem = text }
    #endif
}
