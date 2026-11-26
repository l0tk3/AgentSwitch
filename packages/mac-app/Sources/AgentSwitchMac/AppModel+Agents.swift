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
        guard !isDemo else { return }
        guard !agentsScanning else {
            if force { agentsRescan = true }
            return
        }
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
            refreshAgentExtras()
            if agentsRescan {
                agentsRescan = false
                refreshAgents(force: true)
            }
        }
    }

    /// The vendors' newest versions: the saved answer while it is fresh, asked again when it is not or on `force`.
    func checkAgentUpdates(force: Bool = false) {
        guard !isDemo, !agentsChecking else { return }
        if agentReleases == nil { agentReleases = AgentReleaseInfo.load(from: agentReleasesFile) }
        if !force, agentReleases?.isDue(at: Date()) == false { return }
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

    /// While the app runs (agents-v0 §4): the vendors are asked at launch when the last answer is older than twelve
    /// hours, and again whenever it has aged that much — looked at once an hour, which asks nobody while the answer
    /// is fresh. Nothing is installed by this: the page, the sidebar and the checklist say what is newer.
    func watchAgentUpdates() {
        guard !isDemo, agentWatch == nil else { return }
        agentWatch = Task {
            while !Task.isCancelled {
                checkAgentUpdates()
                refreshAgentExtras()
                try? await Task.sleep(for: .seconds(3600))
            }
        }
    }

    /// Grok's and Antigravity's own programs (docs/agents-v0.md §13): where their commands are and what they say. What
    /// Grok says the newest is is a call of its own, asked at most every twelve hours, or now when asked.
    func refreshAgentExtras(force: Bool = false) {
        guard !isDemo else { return }
        let home = paths.userHome.path, path = config.get().path, env = baseEnvironment, before = agentExtras
        Task {
            agentExtras = await AgentExtras.scan(home: home, path: path, environment: env, before: before)
            if force || agentExtrasChecked == nil || Date().timeIntervalSince(agentExtrasChecked!) >= 12 * 3600 { await checkAgentExtras() }
        }
    }

    /// What Grok says the newest version is, asked of Grok itself (Antigravity does not say).
    func checkAgentExtras() async {
        guard !isDemo else { return }
        let path = config.get().path, env = baseEnvironment
        var extras = agentExtras
        for i in extras.indices where extras[i].canCheck && extras[i].binary != nil {
            extras[i] = await AgentExtras.check(extras[i], environment: env, path: path)
        }
        agentExtras = extras
        agentExtrasChecked = Date()
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

    /// The agents the service runs another program for than the one now chosen (a choice changed, an install came
    /// or went): each says so in its own group, where the choice was made.
    var agentsPending: Set<AgentCLI> {
        guard daemonState.isRunning, !agents.isEmpty else { return [] }
        return AgentSelection.pending(agents, saved: agentUse, applied: agentsApplied)
    }

    var agentsNeedRestart: Bool { !agentsPending.isEmpty }

    // MARK: installing, updating, deleting (agents-v0 §5, §6)

    /// AgentSwitch's own store: the betas and the pinned versions.
    var agentStore: AgentStore {
        AgentStore(layout: agentLayout, environment: baseEnvironment.merging(["PATH": config.get().path]) { _, new in new })
    }

    /// The vendors' own installers and updaters, run with the PATH a terminal of the user's has — so each does what
    /// it would do run there by hand, to the adding of its folder to the shell profile when the PATH lacks it.
    var agentNative: AgentNative {
        AgentNative(layout: agentLayout, environment: baseEnvironment.merging(["PATH": loginPath?.shell ?? config.get().path]) { _, new in new })
    }

    /// The agent's last operation, one file each (agents-v0 §6).
    func agentLogFile(_ agent: AgentCLI) -> URL { paths.logsDir.appendingPathComponent("agent-\(agent.rawValue).log") }

    /// At launch: what an interrupted download or update left behind goes.
    func sweepAgentStore() {
        guard !isDemo else { return }
        let store = agentStore
        Task.detached(priority: .utility) { await store.sweep() }
    }

    func agentJob(_ agent: AgentCLI) -> AgentJob? { agentJobs[agent.rawValue] }

    /// One operation for an agent, shown on `row`: its phases reach the row, what it did goes to the agent's log, and
    /// a failure stays on the row until it is read. One at a time per agent.
    private func runAgentJob(_ agent: AgentCLI, row: String, source: AgentSource, version: String?, first: AgentStore.Phase, title: String,
                             pathMayChange: Bool = false,
                             _ work: @escaping @Sendable (@escaping @Sendable (AgentStore.Phase) -> Void, @escaping @Sendable (String) -> Void) async throws -> Void) {
        guard !isDemo, agentTasks[agent.rawValue] == nil else { return }
        agentJobs[agent.rawValue] = AgentJob(agent: agent, row: row, source: source, version: version, phase: first)
        let gate = AgentProgressGate()
        let log = AgentLog(file: agentLogFile(agent), title: title)
        agentTasks[agent.rawValue] = Task {
            do {
                try await work({ phase in
                    guard gate.pass(phase) else { return }
                    Task { @MainActor [weak self] in self?.agentProgress(agent, phase) }
                }, { log.add($0) })
                log.add("done")
                agentJobs[agent.rawValue] = nil
            } catch is CancellationError {
                log.add("cancelled")
                agentJobs[agent.rawValue] = nil
            } catch {
                log.add("failed: \(error.localizedDescription)")
                agentJobs[agent.rawValue]?.error = error.localizedDescription
            }
            agentTasks[agent.rawValue] = nil
            // A vendor's installer may have put its folder on the PATH: asked of the shell again.
            if pathMayChange { await reloadLoginPath() }
            agentsChanged()
        }
    }

    private func agentProgress(_ agent: AgentCLI, _ phase: AgentStore.Phase) {
        // Reports cross to the main actor one by one; one that arrives after the job ended or failed is dropped.
        guard agentTasks[agent.rawValue] != nil, agentJobs[agent.rawValue]?.failed == false else { return }
        agentJobs[agent.rawValue]?.phase = phase
    }

    /// Installs a source that is not there: the vendor's own install by the vendor's installer, a beta or a pinned
    /// version into the store. `row` is the line it shows on.
    func installAgent(_ agent: AgentCLI, _ source: AgentSource, version: String?, row: String) {
        let title = "Install \(agent.title) \(source.title) \(version ?? "")"
        if source == .stable {
            let native = agentNative
            runAgentJob(agent, row: row, source: source, version: version, first: .resolving, title: title, pathMayChange: true) { report, log in
                var native = native
                native.log = log
                try await native.install(agent, version: version, report: report)
            }
        } else if let version {
            let store = agentStore
            runAgentJob(agent, row: row, source: source, version: version, first: .resolving, title: title) { report, log in
                var store = store
                store.log = log
                try await store.install(agent, source, version: version, report: report)
            }
        }
    }

    /// `Update → <version>`: the vendor's install by its own updater, the beta by a new download that replaces it.
    func updateAgent(_ install: AgentInstall, to version: String) {
        let agent = install.agent
        let title = "Update \(agent.title) \(install.source.title) \(install.version ?? "") → \(version)"
        switch install.source {
        case .stable:
            let native = agentNative
            runAgentJob(agent, row: install.key, source: .stable, version: version, first: .updating, title: title, pathMayChange: true) { report, log in
                var native = native
                native.log = log
                try await native.update(install, to: version, report: report)
            }
        case .beta:
            let store = agentStore
            runAgentJob(agent, row: install.key, source: .beta, version: version, first: .resolving, title: title) { report, log in
                var store = store
                store.log = log
                try await store.install(agent, .beta, version: version, report: report)
            }
        case .pinned, .app, .other:
            break
        }
    }

    /// After the question: a stored version deleted, or the vendor's own install uninstalled.
    func deleteAgent(_ install: AgentInstall) {
        let agent = install.agent
        switch install.source {
        case .stable:
            let native = agentNative
            runAgentJob(agent, row: install.key, source: .stable, version: install.version, first: .removing, title: "Uninstall \(agent.title) Stable \(install.version ?? "")") { report, log in
                var native = native
                native.log = log
                try await native.uninstall(install, report: report)
            }
        case .beta, .pinned:
            let store = agentStore
            runAgentJob(agent, row: install.key, source: install.source, version: install.version, first: .removing,
                        title: "Delete \(agent.title) \(install.source.title) \(install.version ?? "")") { report, log in
                var store = store
                store.log = log
                report(.removing)
                try await store.remove(install)
            }
        case .app, .other:
            break
        }
    }

    /// After the question: the versions the vendor keeps beside the current one, cleared.
    func cleanAgent(_ agent: AgentCLI) {
        let native = agentNative
        runAgentJob(agent, row: AgentRow.leftoversID, source: .stable, version: nil, first: .removing, title: "Clean Up \(agent.title) Old Versions") { report, log in
            var native = native
            native.log = log
            try await native.clean(agent, report: report)
        }
    }

    /// What uninstalling the vendor's install would remove, for the question.
    func agentUninstallPaths(_ agent: AgentCLI) -> [String] { AgentNative.uninstallPaths(agent, layout: agentLayout) }

    func cancelAgentJob(_ agent: AgentCLI) { agentTasks[agent.rawValue]?.cancel() }
    /// A failed job's line, read and put away.
    func dismissAgentJob(_ agent: AgentCLI) {
        if agentJobs[agent.rawValue]?.failed == true { agentJobs[agent.rawValue] = nil }
    }

    // MARK: Grok and Antigravity (agents-v0 §13)

    /// The agent's last operation, one file each.
    func agentExtraLogFile(_ id: String) -> URL { paths.logsDir.appendingPathComponent("agent-\(id).log") }

    /// `Update`: the program's own updater at work on the row, its phases reaching the row, what it did to its log, a
    /// failure staying until it is read. One at a time for each.
    func updateAgentExtra(_ extra: AgentExtra) {
        guard !isDemo, agentExtraTasks[extra.id] == nil else { return }
        let path = config.get().path, env = baseEnvironment
        agentExtraJobs[extra.id] = AgentExtraJob(id: extra.id)
        let gate = AgentProgressGate()
        let log = AgentLog(file: agentExtraLogFile(extra.id), title: "Update \(extra.title) \(extra.version ?? "")")
        agentExtraTasks[extra.id] = Task {
            do {
                try await AgentExtras.update(extra, environment: env, path: path, log: { log.add($0) }, report: { phase in
                    guard gate.pass(phase) else { return }
                    Task { @MainActor [weak self] in self?.agentExtraProgress(extra.id, phase) }
                })
                log.add("done")
                agentExtraJobs[extra.id] = nil
            } catch {
                log.add("failed: \(error.localizedDescription)")
                agentExtraJobs[extra.id]?.error = error.localizedDescription
            }
            agentExtraTasks[extra.id] = nil
            refreshAgentExtras(force: true)
        }
    }

    private func agentExtraProgress(_ id: String, _ phase: AgentStore.Phase) {
        guard agentExtraTasks[id] != nil, agentExtraJobs[id]?.failed == false else { return }
        agentExtraJobs[id]?.phase = phase
    }

    /// A failed updater's line, read and put away.
    func dismissAgentExtraJob(_ id: String) {
        if agentExtraJobs[id]?.failed == true { agentExtraJobs[id] = nil }
    }

    /// Something was installed or deleted: the page reads the Mac again, and the next start of the service gets what
    /// is now chosen (a deleted choice falls back, agents-v0 §3).
    private func agentsChanged() {
        config.set(makeConfig(ports: ports, path: config.get().path))
        refreshAgents(force: true)
        // The checklist's own look at the three executors: installed now, to be signed in to next.
        detectEnvironment()
    }

    /// The folders whose commands a new terminal does not yet know, each with the line that adds it (agents-v0 §8).
    var agentPathNotes: [String] { AgentText.pathNotes(agents, layout: agentLayout, path: loginPath?.shell) }

    /// The number beside `Agents` in the sidebar.
    var agentUpdateCount: Int { AgentUpdates.count(agents, info: agentReleases) + agentExtras.filter { $0.newer != nil }.count }

    func newerVersion(for install: AgentInstall) -> String? {
        AgentUpdates.newer(for: install, channels: agentReleases?.channels(install.agent))
    }

    // MARK: the page as one thing, for this Mac's screen and another node's (agents-v0 §12)

    /// This Mac's 设置 › Agents as it is now.
    var agentsBoard: AgentsBoard {
        let layout = agentLayout
        var paths: [String: [String]] = [:]
        for report in agents where report.install("stable") != nil { paths[report.agent.rawValue] = AgentNative.uninstallPaths(report.agent, layout: layout) }
        var applied: [String: String] = [:]
        for (agent, binary) in agentsApplied { applied[agent.rawValue] = binary }
        return AgentsBoard(home: self.paths.userHome.path, store: layout.store, storeExists: FileManager.default.fileExists(atPath: layout.store),
                           agents: agents, releases: agentReleases, checking: agentsChecking, use: agentUse, applied: applied,
                           running: daemonState.isRunning, jobs: agentJobs, pathNotes: agentPathNotes, uninstallPaths: paths,
                           extras: agentExtras, extraJobs: agentExtraJobs)
    }

    /// One of the page's buttons, pressed here or on another node's screen. What names an install that is not there
    /// any more does nothing: the board it was pressed on was an old one.
    func performAgents(_ action: AgentsAction) {
        // Grok's and Antigravity's rows (agents-v0 §13): their own id names them.
        if let id = action.extra, let extra = agentExtras.first(where: { $0.id == id }) {
            switch action.kind {
            case .check: refreshAgentExtras(force: true)
            case .update: updateAgentExtra(extra)
            case .dismiss: dismissAgentExtraJob(id)
            default: break
            }
            return
        }
        let report = action.agent.flatMap { agent in agents.first { $0.agent == agent } }
        let install = action.key.flatMap { report?.install($0) }
        switch action.kind {
        case .refresh: refreshAgents(force: true); refreshAgentExtras()
        case .check: refreshAgents(force: true); checkAgentUpdates(force: true); refreshAgentExtras(force: true)
        case .use: if let agent = action.agent, let install { useAgent(agent, install: install) }
        case .install:
            if let agent = action.agent, let source = action.source, source == .stable || source == .beta || source == .pinned {
                installAgent(agent, source, version: action.version, row: action.row ?? AgentRow.missing(source, available: action.version).id)
            }
        case .update: if let install, let version = action.version { updateAgent(install, to: version) }
        case .delete: if let install { deleteAgent(install) }
        case .clean: if let agent = action.agent { cleanAgent(agent) }
        case .cancel: if let agent = action.agent { cancelAgentJob(agent) }
        case .dismiss: if let agent = action.agent { dismissAgentJob(agent) }
        case .restart: restartDaemon()
        }
    }

    /// While the app runs: this Mac's board is handed to its own service whenever it changed (and every few seconds, so
    /// the service knows the app is there), and what another node's screen asked is taken from it and done.
    func shareAgents() {
        guard !isDemo, agentsShare == nil else { return }
        agentsShare = Task {
            var kept = Date.distantPast
            while !Task.isCancelled {
                // A job's progress is worth a quicker look than a page nobody changes.
                try? await Task.sleep(for: .seconds(agentJobs.isEmpty ? 3 : 1))
                guard daemonState.isRunning else { agentsShared = nil; continue }
                if agents.isEmpty { refreshAgents() }
                let encoder = JSONEncoder()
                encoder.outputFormatting = .sortedKeys
                if let data = try? encoder.encode(agentsBoard), data != agentsShared || Date().timeIntervalSince(kept) > 8 {
                    if (try? await client.putAgentsBoard(data)) != nil { agentsShared = data; kept = Date() } else { agentsShared = nil }
                }
                for action in (try? await client.takeAgentsActions()) ?? [] { performAgents(action) }
            }
        }
    }

    #if DEBUG
    /// `-designPreview`: this Mac as it was on 2026-10-06 (docs/design/concepts/agents.html), or an empty one.
    func loadDemoAgents(fresh: Bool = false, full: Bool = false) {
        let home = paths.userHome.path
        agents = fresh ? AgentCLI.allCases.map { AgentReport(agent: $0, installs: []) } : full ? DemoData.agentsFull(home: home) : DemoData.agents(home: home)
        agentReleases = DemoData.agentReleases
        agentExtras = DemoData.agentExtras(home: home, fresh: fresh, full: full)
        agentExtraJobs = [:]
        // Everything installed: Codex's beta was chosen after the service started, so the page asks for a restart.
        agentsApplied = AgentSelection.binaries(agents, saved: [:])
        agentUse = full ? ["codex": "beta"] : [:]
    }
    #else
    func loadDemoAgents(fresh: Bool = false, full: Bool = false) {}
    #endif
}
