import AgentSwitchMacCore
import Foundation

/// 设置 › Agents (docs/agents-v0.md): what is installed of the four agent CLIs, what the vendors have that is newer, and
/// which install AgentSwitch runs.
extension AppModel {
    var agentLayout: AgentLayout { AgentLayout(home: paths.userHome.path) }
    /// The vendors' last answers, kept between launches (agents-v0 §4).
    private var agentReleasesFile: URL { paths.agentswitchHome.appendingPathComponent("agents.json") }
    /// A scan is cheap, but the page and the environment check may both ask within a moment.
    private static let agentScanSpacing: TimeInterval = 2

    /// What is installed, read again: where things are at once, then the versions the programs say and the sizes.
    func refreshAgents(force: Bool = false) {
        guard !isDemo, !agentsScanning else { return }
        if !force, let last = agentsScanned, Date().timeIntervalSince(last) < AppModel.agentScanSpacing { return }
        agentsScanning = true
        let layout = agentLayout
        let path = config.get().path
        let env = baseEnvironment
        Task {
            let found = await Task.detached { AgentInventory.scan(layout: layout, path: path) }.value
            // Keep what was already known of an install that is still there, so the rows do not blink.
            agents = found.map { report in
                var report = report
                let before = agents.first { $0.agent == report.agent }
                report.installs = report.installs.map { install in
                    var install = install
                    if let old = before?.install(install.key), old.binary == install.binary, old.location == install.location {
                        install.version = install.version ?? old.version
                        install.bytes = old.bytes
                    }
                    return install
                }
                if report.leftovers?.paths == before?.leftovers?.paths { report.leftovers?.bytes = before?.leftovers?.bytes }
                return report
            }
            let versioned = await AgentInventory.withVersions(found, path: path, environment: env)
            agents = await AgentInventory.withSizes(versioned)
            agentsScanned = Date()
            agentsScanning = false
        }
    }

    /// The vendors' newest versions: the saved answer while it is fresh, asked again when it is not or on `force`.
    func checkAgentUpdates(force: Bool = false) {
        guard !isDemo, !agentsChecking else { return }
        if agentReleases == nil { agentReleases = AgentReleaseInfo.load(from: agentReleasesFile) }
        if !force, agentReleases?.isFresh(at: Date()) == true { return }
        agentsChecking = true
        let previous = agentReleases
        let file = agentReleasesFile
        Task {
            let info = await AgentReleases.check(previous: previous)
            agentReleases = info
            try? info.save(to: file)
            agentsChecking = false
        }
    }

    /// The install AgentSwitch runs for this agent: the saved choice while it is there, else the vendor's own.
    func agentInUse(_ report: AgentReport) -> AgentInstall? {
        AgentSelection.chosen(report, saved: agentUse[report.agent.rawValue])
    }

    /// Chosen in 设置 › Agents: saved, and in the config the service next starts with. Nothing restarts here.
    func useAgent(_ agent: AgentCLI, install: AgentInstall) {
        guard install.selectable, agentUse[agent.rawValue] != install.key else { return }
        agentUse[agent.rawValue] = install.key
        UserDefaults.standard.set(agentUse, forKey: AgentSelection.defaultsKey)
        config.set(makeConfig(ports: ports, path: config.get().path))
    }

    /// The service runs with other programs than the ones now chosen (a choice changed, an install came or went).
    var agentsNeedRestart: Bool {
        guard daemonState.isRunning, !agents.isEmpty else { return false }
        let planned = AgentSelection.binaries(agents, saved: agentUse)
        return planned.contains { agentsApplied[$0.key] != $0.value }
    }

    /// The number beside `Agents` in the sidebar.
    var agentUpdateCount: Int { AgentUpdates.count(agents, info: agentReleases) }

    func newerVersion(for install: AgentInstall) -> String? {
        AgentUpdates.newer(for: install, channels: agentReleases?.channels(install.agent))
    }

    #if DEBUG
    /// `-designPreview`: this Mac as it was on 2026-10-06 (docs/design/concepts/agents.html), or an empty one.
    func loadDemoAgents(fresh: Bool = false, full: Bool = false) {
        let home = paths.userHome.path
        agents = fresh ? AgentCLI.allCases.map { AgentReport(agent: $0, installs: []) } : full ? DemoData.agentsFull(home: home) : DemoData.agents(home: home)
        agentReleases = DemoData.agentReleases
        // Everything installed: Codex's beta was chosen after the service started, so the page asks for a restart.
        agentsApplied = AgentSelection.binaries(agents, saved: [:])
        agentUse = full ? ["codex": "beta"] : [:]
    }
    #else
    func loadDemoAgents(fresh: Bool = false, full: Bool = false) {}
    #endif
}
