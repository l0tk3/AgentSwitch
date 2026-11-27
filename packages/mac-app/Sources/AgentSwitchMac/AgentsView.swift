import AgentSwitchMacCore
import AppKit
import SwiftUI

/// An agent as the Profiles page knows it (docs/profiles-v0.md §3): the four CLIs 设置 › Agents installs and updates
/// (`AgentCLI`, agents-v0), and Grok — which runs in AgentSwitch's terminals and so has profiles, but is not one of the
/// four this page installs. The raw value (`id`) is the daemon's name for it.
struct ProfileAgent: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    init(id: String, title: String) { self.id = id; self.title = title }
    init(_ cli: AgentCLI) { self.init(id: cli.rawValue, title: cli.title) }
    var isClaude: Bool { id == "claude-code" }
    var isCodex: Bool { id == "codex" }
    static let claude = ProfileAgent(AgentCLI.claude)
    static let codex = ProfileAgent(AgentCLI.codex)
    static let opencode = ProfileAgent(AgentCLI.opencode)
    static let pi = ProfileAgent(AgentCLI.pi)
    /// Grok runs in AgentSwitch's terminals (docs/terminal-v0.md §3) but is not installed or updated by Agents.
    static let grok = ProfileAgent(id: "grok", title: "Grok")
    /// Antigravity CLI: its sign-in is in the Mac's keychain, one for the Mac, so it has its `Default` only (the daemon
    /// says it is not `creatable`: no New Profile…); shown so the page lists every agent (user #562).
    static let agy = ProfileAgent(id: "agy", title: "Antigravity")
    /// The page's agents, in order: the ones Agents looks after, then Grok and agy.
    static let shown: [ProfileAgent] = AgentCLI.allCases.map(ProfileAgent.init) + [.grok, .agy]
}

/// 设置 › Agents (docs/agents-v0.md §8, docs/design/concepts/agents.html): the four agent CLIs — what is installed and
/// where it came from, what the vendors have that is newer, which install AgentSwitch runs — and what can be done with
/// each: installing and updating the vendor's own, a beta or a pinned version; deleting any of them but ChatGPT App's
/// (asked first); clearing the old versions a vendor keeps.
struct AgentsView: View {
    var profilesOnly = false
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @State private var confirmRestart = false
    @State private var loadError: String?
    /// The picked node's board, as its app last handed it over (agents-v0 §12); nil until read, and on this Mac.
    @State private var remote: AgentsBoard?
    /// What is shown: another node's installs, not this Mac's.
    private var onNode: Bool { profileNodeID != nil && !profilesOnly }
    private var board: AgentsBoard { onNode ? remote ?? AgentsBoard(home: "", store: "", storeExists: false, agents: [], releases: nil, checking: false, use: [:], applied: [:], running: false, jobs: [:], pathNotes: [], uninstallPaths: [:]) : model.agentsBoard }

    /// One of the page's buttons: done here, or asked of the node's own app.
    private func act(_ action: AgentsAction) {
        guard onNode else { model.performAgents(action); return }
        let client = profileClient
        Task {
            do { try await client.sendAgents(action); loadError = nil }
            catch { loadError = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }

    /// The node's board, read again every moment while the page shows it.
    private func followNode() async {
        guard onNode else { return }
        while !Task.isCancelled {
            do {
                let answer = try await profileClient.agentsBoard()
                remote = answer.board
                loadError = answer.fresh ? nil : "这个节点上的 AgentSwitch 应用没有在运行：显示的是它上一次报来的情况。"
            } catch { loadError = (error as? DaemonError)?.reason ?? error.localizedDescription }
            try? await Task.sleep(for: .seconds(remote?.jobs.isEmpty == false ? 1 : 3))
        }
    }
    /// Each agent's profiles, as the service has them; what went wrong with the last change, by agent.
    @State private var profiles: [String: AgentProfiles] = [:]
    @State private var health: [String: ProfileHealth] = [:]
    @State private var checkingHealth: Set<String> = []
    @State private var profileError: [String: String] = [:]
    /// The agent a new profile is being named for; the name; the profile asked to be removed.
    @State private var naming: ProfileAgent?
    @State private var removing: (agent: ProfileAgent, profile: AgentProfile)?
    /// The profile whose own proxy is being set (docs/profiles-v0.md §4); the one being renamed.
    @State private var proxying: ProfileProxyTarget?
    @State private var renaming: ProfileProxyTarget?
    @State private var importingAuth: AgentProfile?
    @State private var keying: ProfileProxyTarget?
    @State private var copying: AgentProfile?
    @State private var paying: ProfileProxyTarget?
    /// The install asked to be deleted, until answered.
    @State private var deleting: AgentInstall?
    /// The agent whose old versions were asked to be cleared, until answered.
    @State private var cleaning: AgentCLI?
    /// `Install Version…` for this agent.
    @State private var pinning: AgentCLI?

    var body: some View {
        Form {
            if let loadError { Text(loadError).foregroundStyle(.red) }
            if !profilesOnly {
            Section {
                LabeledContent("Updates") {
                    HStack(spacing: 6) {
                        StatusDot(level: board.checking ? .busy : board.updateCount > 0 ? .warning : .ok)
                        Text(updatesLine).mono(12).foregroundStyle(.secondary)
                    }
                }
                if board.needsRestart {
                    LabeledContent {
                        Button("Restart Service…") { confirmRestart = true }
                    } label: {
                        HStack(spacing: 6) {
                            StatusDot(level: .warning)
                            Text("Applies After Restart")
                        }
                    }
                }
            } footer: {
                if board.needsRestart {
                    Footer("已更改 AgentSwitch 使用的版本，重启服务后生效。已打开的终端继续使用原来的程序。")
                } else if let failed = AgentText.failed(board.releases) {
                    Footer(failed)
                }
            }

            }
            if profilesOnly {
                ForEach(ProfileAgent.shown) { agent in profilesSection(agent) }
            } else {
            ForEach(board.agents) { report in
                AgentSection(board: board, report: report, delete: { deleting = $0 }, clean: { cleaning = report.agent }, pin: { pinning = report.agent },
                             restart: { confirmRestart = true })
            }
            // Grok and Antigravity (docs/agents-v0.md §13): what their own programs say, and their own updaters.
            ForEach(board.extras ?? []) { extra in
                AgentExtraSection(extra: extra, job: board.extraJobs?[extra.id]) {
                    act(AgentsAction(.update, extra: extra.id))
                }
            }
            }

            if !profilesOnly {
            Section {
                LabeledContent("Beta & Pinned") {
                    HStack(spacing: 8) {
                        Text(board.short(board.store)).mono(12).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(AgentText.size(storeBytes)).mono(12).foregroundStyle(.secondary)
                        // With nothing stored there is no folder to show (agents-v0 §6).
                        // Another node's folder is not on this Mac to be shown.
                        if !onNode {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: board.store)]) }
                                .controlSize(.small)
                                .disabled(storeBytes == 0 && !board.storeExists)
                        }
                    }
                }
                ForEach(board.pathNotes, id: \.self) { note in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        StatusDot(level: .warning)
                        Text(note).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } header: {
                SectionLabel("Store")
            } footer: {
                Footer("Stable 由各家的官方安装程序安装在官方位置，与自行安装的完全相同：删除 AgentSwitch 后仍可使用并照常更新。Beta 与 Pinned 存放在上面的版本库中，可随时整个删除，不影响 Stable。")
            }
            } else {
                Section {
                    Text("Check Health 检查这个配置的连接状态。订阅配置读取用量；Claude 会发出一次轻量探测，可能消耗少量额度。API 配置只请求模型列表，不生成内容。结果是上次检查的快照，可随时重新检查。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    if profilesOnly { Task { await loadProfiles() } }
                    else { act(AgentsAction(.check)) }
                } label: { Label(profilesOnly ? "Refresh" : "Check Now", systemImage: "arrow.clockwise") }
                    .help("Check Now")
                    .disabled(board.checking)
            }
        }
        .environment(\.agentsAct, AgentsAct(local: !onNode, run: act))
        .task { await followNode() }
        .task {
            model.refreshAgents()
            if !profilesOnly, !onNode { model.checkAgentUpdates() }
        }
        .sheet(item: $naming) { agent in
            ProfileNewSheet(agent: agent, kinds: profiles[agent.id]?.newKinds ?? ["subscription"]) { profiles = $0 }
        }
        .sheet(item: $paying) { target in
            ProfileKeySheet(agent: target.agent, profile: target.profile) { profiles = $0 }
        }
        .modifier(ProfileDialogs(removing: removingShown, removingName: removing?.profile.name ?? "",
                                 remove: { if let target = removing { delete(target.agent, target.profile) } }))
        .task { if profilesOnly { await loadProfiles() } }
        .sheet(item: $keying) { target in
            ProfileSessionKeySheet(agent: target.agent, profile: target.profile) { profiles = $0 }
        }
        .sheet(item: $renaming) { target in
            ProfileRenameSheet(agent: target.agent, profile: target.profile) { profiles = $0 }
        }
        .sheet(item: $copying) { profile in ProfileCopiesSheet(profile: profile) }
        .sheet(item: $importingAuth) { profile in
            CodexAuthSheet(profile: profile) { profiles = $0 }
        }
        .sheet(item: $proxying) { target in
            ProfileProxySheet(agent: target.agent, profile: target.profile) { agents in profiles = agents }
        }
        .confirmationDialog("重启服务？", isPresented: $confirmRestart) {
            Button("Restart Service") { act(AgentsAction(.restart)) }
        } message: {
            Text("服务重启后改用新选择的版本。正在运行的任务和已打开的终端将中断。")
        }
        .confirmationDialog(deleteQuestion?.title ?? "", isPresented: deletingShown, presenting: deleting) { install in
            Button(install.source == .stable ? "Uninstall" : "Delete", role: .destructive) { act(AgentsAction(.delete, agent: install.agent, key: install.key)) }
        } message: { _ in
            Text(deleteQuestion?.message ?? "")
        }
        .confirmationDialog(cleanQuestion?.title ?? "", isPresented: cleaningShown, presenting: cleaning) { agent in
            Button("Clean Up", role: .destructive) { act(AgentsAction(.clean, agent: agent)) }
        } message: { _ in
            Text(cleanQuestion?.message ?? "")
        }
        .sheet(item: $pinning) { agent in
            PinSheet(agent: agent) { version in
                act(AgentsAction(.install, agent: agent, source: .pinned, version: version, row: AgentInstall.pinnedKey(version)))
            }
        }
    }

    private func loadProfiles() async {
        do {
            profiles = try await profileClient.profiles()
            health = (try? await profileClient.profileHealthStates()) ?? [:]
            loadError = nil
        } catch {
            profiles = [:]
            health = [:]
            loadError = "无法读取所选节点的配置：\(error.localizedDescription)。请确认节点在线且已更新到支持远程 Profile 管理的版本。"
        }
    }

    private var deletingShown: Binding<Bool> { Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }) }
    private var cleaningShown: Binding<Bool> { Binding(get: { cleaning != nil }, set: { if !$0 { cleaning = nil } }) }

    /// What the dialog asks about the install being deleted: is it the one in use, and what is used after it.
    private var deleteQuestion: (title: String, message: String)? {
        guard let install = deleting, let report = board.agents.first(where: { $0.agent == install.agent }) else { return nil }
        let home = board.home
        let inUse = board.inUse(report)?.key == install.key
        var without = report
        without.installs.removeAll { $0.key == install.key }
        let next = AgentSelection.fallback(without)
        guard install.source == .stable else { return AgentText.deleteQuestion(install, inUse: inUse, next: next, home: home) }
        // The vendor's install goes whole, the versions it keeps beside the current one with it.
        let bytes = install.bytes.map { $0 + (report.leftovers?.bytes ?? 0) }
        return AgentText.uninstallQuestion(install, paths: board.uninstallPaths[install.agent.rawValue] ?? [], bytes: bytes, inUse: inUse, next: next, home: home)
    }

    private var cleanQuestion: (title: String, message: String)? {
        guard let agent = cleaning, let report = board.agents.first(where: { $0.agent == agent }), let leftovers = report.leftovers else { return nil }
        return AgentText.cleanQuestion(agent, leftovers: leftovers, current: report.install("stable")?.version, home: board.home)
    }

    private var updatesLine: String {
        let checked = AgentText.checked(board.releases, checking: board.checking)
        guard !board.checking, board.releases?.checkedAt != nil else { return checked }
        let count = board.updateCount
        return "\(count == 0 ? "Up to Date" : "\(count) Available") · \(checked)"
    }

    /// What the store holds: the betas and the pinned versions.
    private var storeBytes: Int64 {
        board.agents.flatMap(\.installs).filter { $0.source == .beta || $0.source == .pinned }.reduce(0) { $0 + ($1.bytes ?? 0) }
    }

    /// Its sign-ins (docs/profiles-v0.md §3): the one new terminals start under, and others to switch to.
    @ViewBuilder private func profilesSection(_ agent: ProfileAgent) -> some View {
        if let list = profiles[agent.id] {
            ProfilesSection(agent: agent, profiles: list, error: profileError[agent.id],
                            add: { naming = agent },
                            remove: { profile in removing = (agent, profile) },
                            proxy: { profile in proxying = ProfileProxyTarget(agent: agent, profile: profile) },
                            rename: { profile in renaming = ProfileProxyTarget(agent: agent, profile: profile) },
                            sessionKey: { profile in keying = ProfileProxyTarget(agent: agent, profile: profile) },
                            copies: { profile in copying = profile },
                            apiKey: { profile in paying = ProfileProxyTarget(agent: agent, profile: profile) },
                            resetIdentity: profileNodeID == nil ? { change(.claude) { try await $0.resetDefaultClaudeIdentity() } } : nil,
                            authJSON: { importingAuth = $0 }, health: health, checkingHealth: checkingHealth,
                            checkHealth: { profile in
                                let key = "\(agent.id).\(profile.id)"
                                guard checkingHealth.insert(key).inserted else { return }
                                Task {
                                    defer { checkingHealth.remove(key) }
                                    do { health[key] = try await profileClient.checkProfileHealth(agent: agent.id, id: profile.id); profileError[agent.id] = nil }
                                    catch { profileError[agent.id] = error.localizedDescription }
                                }
                            },
                            telemetry: { profile, on in change(agent) { try await $0.setProfileTelemetry(agent: agent.id, id: profile.id, on: on) } },
                            color: { profile, color in change(agent) { try await $0.setProfileColor(agent: agent.id, id: profile.id, color: color) } })
        }
    }

    private func delete(_ agent: ProfileAgent, _ profile: AgentProfile) { change(agent) { try await $0.deleteProfile(agent: agent.id, id: profile.id) } }
    private var removingShown: Binding<Bool> { Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }) }

    /// One change to an agent's profiles, and what the service has afterwards (or why it did not take it).
    private func change(_ agent: ProfileAgent, _ call: @escaping (DaemonClient) async throws -> [String: AgentProfiles]) {
        let client = profileClient
        Task {
            do { profiles = try await call(client); profileError[agent.id] = nil }
            catch { profileError[agent.id] = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}

/// One agent's group: a line per install, the radio on the left saying which one AgentSwitch runs.
/// The profiles sections' question: whether to remove one.
private struct ProfileDialogs: ViewModifier {
    let removing: Binding<Bool>
    let removingName: String
    let remove: () -> Void

    func body(content: Content) -> some View {
        content
            .confirmationDialog("删除这个配置？", isPresented: removing) {
                Button("Delete \(removingName)", role: .destructive, action: remove)
            } message: {
                Text("它的登录、API key 和专属目录会被删除，包含其中的会话、记忆、技能副本和文件；请先备份需要保留的内容。你选择的外部项目目录、旧版共享的会话不受影响。")
            }
    }
}

struct CodexAuthSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var content = ""
    @State private var problem: String?
    @State private var busy = false
    /// The service refused it while Codex terminals run under the profile: they can be ended with the save.
    @State private var inUse = false

    private func save(endTerminals: Bool) {
        busy = true
        Task {
            defer { busy = false }
            do { let result = try await profileClient.setCodexAuth(id: profile.id, content: content, endTerminals: endTerminals); content = ""; done(result); dismiss() }
            catch {
                if case DaemonError.http(status: 409, _) = error { inUse = true }
                problem = error.localizedDescription
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("auth.json · \(profile.name)").font(.headline)
            Text(profile.isDefault ? "替换 ~/.codex/auth.json。新终端将使用文件中的登录信息。" : "替换这个 Profile 独立目录里的 auth.json。导入后使用文件中的登录信息，替代原有 API Key 配置。")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $content).font(.system(.body, design: .monospaced))
                .frame(height: 230).border(Color.secondary.opacity(0.3))
                .accessibilityLabel("auth.json content")
            if let problem { Text(problem).foregroundStyle(.red).font(.callout) }
            HStack {
                Button("Cancel") { content = ""; dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Spacer()
                let empty = content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if inUse { Button("End Terminals and Save") { save(endTerminals: true) }.disabled(busy || empty) }
                Button(busy ? "Saving…" : "Save") { save(endTerminals: false) }.keyboardShortcut(.defaultAction).disabled(busy || empty)
            }
        }.padding(20).frame(width: 580)
    }
}

/// The profile whose proxy is being set.
struct ProfileProxyTarget: Identifiable {
    let agent: ProfileAgent
    let profile: AgentProfile
    var id: String { "\(agent.id)/\(profile.id)" }
}

/// A profile's own proxy (docs/profiles-v0.md §4): its address, a user name, a password — sealed by this Mac's gate for
/// the proxy's own host before anything is sent, as the browser's is. Applied, it is checked at once: where it lets
/// traffic out is shown, or why it let nothing out (it is kept all the same: it may be down for now).
struct ProfileProxySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var draft: BrowserProxyDraft
    @State private var exit: ProfileExit?
    @State private var problem: String?
    @State private var busy = false
    /// Its `Direct` rules (docs/profiles-v0.md §4.3), saved as each one is added or removed; the one being typed.
    @State private var direct: [String]
    @State private var adding = ""
    @State private var directProblem: String?

    init(agent: ProfileAgent, profile: AgentProfile, problem: String? = nil, done: @escaping ([String: AgentProfiles]) -> Void) {
        self.agent = agent
        self.profile = profile
        self.done = done
        _direct = State(initialValue: profile.direct ?? ProfileDirect.defaults)
        _draft = State(initialValue: BrowserProxyDraft(profile.proxy))
        _exit = State(initialValue: profile.exit)
        _problem = State(initialValue: problem)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(profile.name) · Proxy").font(.headline)
            Text("在这个配置名下开的终端，agent 和它运行的命令发出去的流量都从这个代理走，它的浏览器（一个单独的窗口，登录页也开在里面）也是；这台 Mac 自己的地址不走。开终端之前会先查一次这个代理，不通就不开，不会改成直连。可以把整条代理地址（http://用户名:密码@主机:端口）直接粘进 Server，用户名和密码会自己分到下面两栏。密码在这台 Mac 上加密后才保存。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Server", text: $draft.server, prompt: Text("http://user:pass@host:port"))
                    // A whole proxy pasted in is taken apart at once: its name and password go to their own fields.
                    // (Typed letter by letter it is left alone until `Apply`, so nothing moves under the cursor.)
                    .onChange(of: draft.server) { old, new in
                        let parted = draft.split()
                        if new.count - old.count > 1, parted != draft, parted.username != draft.username || parted.password != draft.password { draft = parted }
                    }
                TextField("User Name", text: $draft.username)
                SecureField("Password", text: $draft.password, prompt: Text(profile.proxy?.sealed == true ? "Kept" : ""))
                if let exit { LabeledContent("Exit") { Text(exit.text).monospacedDigit().textSelection(.enabled) } }
            }
            .formStyle(.columns)
            if let said = draft.split().problem ?? problem { Text(said).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if profile.direct != nil { directRules }
            HStack {
                Button("No Proxy") { apply(nil) }.disabled(busy || profile.proxy == nil)
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Apply & Check") { draft = draft.split(); apply(draft) }.keyboardShortcut(.defaultAction).disabled(busy || !draft.split().canApply)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    /// `Direct`: what is reached straight, past the proxy — one rule a line, each removable; a new one added with Return
    /// or `Add`; `Reset` brings back the default (NetBird).
    private var directRules: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Direct").font(.subheadline.weight(.semibold))
                Spacer()
                Button("Reset") { saveDirect(nil) }.controlSize(.small).disabled(busy || direct == ProfileDirect.defaults)
            }
            VStack(spacing: 0) {
                ForEach(Array(direct.enumerated()), id: \.element) { index, rule in
                    if index > 0 { Divider() }
                    HStack {
                        Text(rule).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        Spacer()
                        Button { saveDirect(direct.filter { $0 != rule }) } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless).help("Remove").disabled(busy)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                }
                if !direct.isEmpty { Divider() }
                HStack {
                    TextField("Add", text: $adding, prompt: Text("*.example.com, 10.0.0.0/8")).textFieldStyle(.plain)
                        .onSubmit(addDirect)
                    Button("Add", action: addDirect).controlSize(.small).disabled(busy || ProfileDirect.rule(adding) == nil)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
            if let said = directProblem { Text(said).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private func addDirect() {
        guard let rule = ProfileDirect.rule(adding) else {
            if !adding.trimmingCharacters(in: .whitespaces).isEmpty { directProblem = "不是可用的直连规则：\(adding.trimmingCharacters(in: .whitespaces))" }
            return
        }
        guard !direct.contains(rule) else { adding = ""; return }
        saveDirect(direct + [rule]) { adding = "" }
    }

    /// The rules from now on (nil: the default); they count at the browser's and the terminals' next request.
    private func saveDirect(_ rules: [String]?, then: @escaping () -> Void = {}) {
        let client = profileClient, agent = agent.id, id = profile.id
        busy = true
        directProblem = nil
        Task {
            do {
                let agents = try await client.setProfileDirect(agent: agent, id: id, rules: rules)
                done(agents)
                direct = agents[agent]?.profiles.first { $0.id == id }?.direct ?? rules ?? ProfileDirect.defaults
                then()
            } catch { directProblem = (error as? DaemonError)?.reason ?? (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }

    /// The proxy set (nil: none) and checked. With a problem the sheet stays, saying it; without, the exit is shown and
    /// the sheet stays for it to be read (nil closes).
    private func apply(_ draft: BrowserProxyDraft?) {
        let client = profileClient, agent = agent.id, id = profile.id, current = profile.proxy
        busy = true
        problem = nil
        Task {
            do {
                var request: BrowserProxyRequest?
                if let draft, let site = BrowserIdentityText.proxySite(draft.server) {
                    var ciphertext: String?
                    if !draft.password.isEmpty { ciphertext = try await model.sealProfile(GateSealRequest(label: "profile/proxy", sites: site, value: draft.password), on: profileNodeID) }
                    request = draft.request(ciphertext: ciphertext, current: current)
                }
                let reply = try await client.setProfileProxy(agent: agent, id: id, proxy: request)
                done(reply.agents)
                exit = reply.agents[agent]?.profiles.first { $0.id == id }?.exit
                problem = reply.problem
                self.draft.password = ""
                if request == nil { dismiss() }
            } catch { problem = (error as? DaemonError)?.reason ?? (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// A profile's claude.ai session key (docs/profiles-v0.md §3.4): sealed by this Mac's gate for claude.ai before anything
/// is sent, kept by the service as a ciphertext, and put into the profile's own browser as claude.ai's sign-in cookie.
struct ProfileSessionKeySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var key = ""
    @State private var problem: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(profile.name) · Session Key").font(.headline)
            Text("claude.ai 网页的登录凭据（sk-ant-sid 开头）。保存后写进这个配置自己的浏览器，那里的 claude.ai 即为已登录；在这个配置名下开终端时，/login 的页面开在同一个浏览器里，只需点一次授权。它在这台 Mac 上加密后才保存，之后不再显示。浏览器里已有登录时，下次启动不会用保存的这一个去覆盖。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                SecureField("Session Key", text: $key, prompt: Text(profile.hasSessionKey ? "Kept" : "sk-ant-sid…"))
            }
            .formStyle(.columns)
            if let said = SessionKeyText.problem(key) ?? problem { Text(said).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Button("Remove") { apply(nil) }.disabled(busy || !profile.hasSessionKey)
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { apply(SessionKeyText.cleaned(key)) }.keyboardShortcut(.defaultAction).disabled(busy || !SessionKeyText.valid(key))
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    /// The key sealed and kept (nil: forgotten). The sheet closes when the service has taken it; it stays, saying why,
    /// when it has not.
    private func apply(_ value: String?) {
        let client = profileClient, agent = agent.id, id = profile.id
        busy = true
        problem = nil
        Task {
            do {
                var ciphertext: String?
                if let value { ciphertext = try await model.sealProfile(GateSealRequest(label: "profile/session-key", sites: SessionKeyText.site, value: value), on: profileNodeID) }
                done(try await client.setProfileSessionKey(agent: agent, id: id, ciphertext: ciphertext))
                key = ""
                dismiss()
            } catch { problem = (error as? DaemonError)?.reason ?? (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// A profile's name, changed (docs/profiles-v0.md §3.3): the same rules as when it is made.
struct ProfileRenameSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var name: String
    @State private var problem: String?
    @State private var busy = false

    init(agent: ProfileAgent, profile: AgentProfile, done: @escaping ([String: AgentProfiles]) -> Void) {
        self.agent = agent
        self.profile = profile
        self.done = done
        _name = State(initialValue: profile.name)
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }
    private var ready: Bool { !trimmed.isEmpty && trimmed != profile.name }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename \(profile.name)").font(.headline)
            Form { TextField("Name", text: $name) }.formStyle(.columns)
            if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Rename", action: save).keyboardShortcut(.defaultAction).disabled(busy || !ready)
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private func save() {
        let client = profileClient, agent = agent.id, id = profile.id, name = trimmed
        busy = true
        problem = nil
        Task {
            do { done(try await client.renameProfile(agent: agent, id: id, name: name)); dismiss() }
            catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
            busy = false
        }
    }
}

/// A new profile (docs/profiles-v0.md §3, §3.6): its name, and how it signs in — with an account (it starts at the
/// agent's own sign-in), or by a key, which is sealed by this Mac's gate for the address it is sent to before anything
/// is sent. Only the ways the service offers for this agent are shown.
struct ProfileNewSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let kinds: [String]
    let done: ([String: AgentProfiles]) -> Void
    @State private var kind: String
    @State private var draft = ApiKeyDraft()
    @State private var problem: String?
    @State private var busy = false
    /// Claude Code's telemetry under it (docs/profiles-v0.md §3.7); off unless asked for (2026-11-22).
    @State private var telemetry = false
    @State private var copies = ClaudeProfileCopies()
    /// A Codex account profile (it has a folder all its own): what of `Default` there is to copy, and what was picked.
    @State private var codexOptions: [String] = []
    @State private var codexCopies: Set<String> = []
    @State private var copyOptions: ClaudeProfileCopyOptions?
    @State private var copyProblem: String?
    @State private var loadingCopies = false

    init(agent: ProfileAgent, kinds: [String], done: @escaping ([String: AgentProfiles]) -> Void) {
        self.agent = agent
        self.kinds = kinds
        self.done = done
        _kind = State(initialValue: kinds.first ?? "subscription")
    }

    private var byKey: Bool { kind == "api" }
    private var ready: Bool {
        if agent.isClaude && copyOptions == nil { return false }
        return byKey ? draft.canSave(agent: agent.id, new: true) : !draft.name.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New \(agent.title) Profile").font(.headline)
            Form {
                TextField("Name", text: $draft.name)
                if kinds.count > 1 {
                    Picker("Sign In With", selection: $kind) {
                        Text("Account").tag("subscription")
                        Text("API Key").tag("api")
                    }
                    .pickerStyle(.segmented)
                }
                if byKey { ApiKeyFields(agent: agent, draft: $draft, kept: false) }
                if agent.isClaude {
                    Toggle("Telemetry", isOn: $telemetry)
                        .help("关掉后，在它名下开的终端里设 DISABLE_TELEMETRY=1，Claude Code 不再上报使用统计。之后可在配置那一行的右键菜单里改。")
                }
            }
            .formStyle(.columns)
            if agent.isClaude { copyChoices }
            if agent.isCodex, !byKey, !codexOptions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Copy from Default").font(.callout.weight(.semibold))
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(codexOptions, id: \.self) { item in
                            Toggle(item, isOn: Binding(get: { codexCopies.contains(item) }, set: { if $0 { codexCopies.insert(item) } else { codexCopies.remove(item) } }))
                        }
                    }
                }
            }
            if let said = (byKey ? draft.problem(agent: agent.id) : nil) ?? problem { Text(said).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create", action: create).keyboardShortcut(.defaultAction).disabled(busy || !ready)
            }
        }
        .padding(20)
        .frame(width: 540)
        .task {
            if agent.isClaude { await loadCopies() }
            if agent.isCodex { codexOptions = (try? await profileClient.codexProfileCopyOptions()) ?? [] }
        }
    }

    private var copyChoices: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Copy from Default").font(.callout.weight(.semibold))
            if let options = copyOptions {
                ProfileCopyChoices(options: options, selection: $copies)
                if !copies.mcpServers.isEmpty { ProfileCopyMCPNote() }
            } else if let copyProblem {
                Text(copyProblem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                Button("Retry") { Task { await loadCopies() } }.disabled(loadingCopies)
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    private func loadCopies() async {
        loadingCopies = true
        copyProblem = nil
        defer { loadingCopies = false }
        do { copyOptions = try await profileClient.claudeProfileCopyOptions() }
        catch { copyProblem = "读不到 Default 里可以复制的内容：" + ((error as? DaemonError)?.reason ?? error.localizedDescription) }
    }

    private func create() {
        let client = profileClient, agent = agent.id, draft = draft, byKey = byKey, telemetry = telemetry
        let name = draft.name.trimmingCharacters(in: .whitespaces)
        // Only Claude Code's telemetry is the service's to turn off; another agent is sent no word of it (its own, left
        // as the agent has it).
        let asked = agent == "claude-code" ? telemetry : nil
        let selection = agent == "claude-code" ? copies : nil
        busy = true
        problem = nil
        Task {
            do {
                if byKey, let site = draft.site(agent: agent) {
                    let ciphertext = try await model.sealProfile(GateSealRequest(label: "profile/api-key", sites: site, value: draft.cleanKey), on: profileNodeID)
                    done(try await client.createKeyProfile(agent: agent, name: name, ciphertext: ciphertext, baseUrl: draft.cleanBaseUrl, model: draft.cleanModel, telemetry: asked, copyFromDefault: selection))
                } else {
                    done(try await client.createProfile(agent: agent, name: name, telemetry: asked, copyFromDefault: selection, copyCodex: agent == "codex" ? codexOptions.filter(codexCopies.contains) : nil))
                }
                dismiss()
            } catch { problem = (error as? DaemonError)?.reason ?? (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// The key a profile pays by, where it is sent and the model it starts on (docs/profiles-v0.md §3.6), changed. The key
/// is never shown: left empty, the one it has is kept.
struct ProfileKeySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var draft: ApiKeyDraft
    @State private var problem: String?
    @State private var busy = false

    init(agent: ProfileAgent, profile: AgentProfile, done: @escaping ([String: AgentProfiles]) -> Void) {
        self.agent = agent
        self.profile = profile
        self.done = done
        _draft = State(initialValue: ApiKeyDraft(profile.api))
    }

    /// The site the key it has was sealed for.
    private var keptSite: String? { ApiKeyDraft(profile.api).site(agent: agent.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(profile.name) · API Key").font(.headline)
            Form { ApiKeyFields(agent: agent, draft: $draft, kept: true) }.formStyle(.columns)
            if let said = draft.problem(agent: agent.id, keptSite: keptSite) ?? problem { Text(said).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save", action: save).keyboardShortcut(.defaultAction).disabled(busy || !draft.canSave(agent: agent.id, new: false, keptSite: keptSite))
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func save() {
        let client = profileClient, agent = agent.id, id = profile.id, draft = draft
        busy = true
        problem = nil
        Task {
            do {
                var ciphertext: String?
                if !draft.cleanKey.isEmpty, let site = draft.site(agent: agent) {
                    ciphertext = try await model.sealProfile(GateSealRequest(label: "profile/api-key", sites: site, value: draft.cleanKey), on: profileNodeID)
                }
                done(try await client.setProfileApi(agent: agent, id: id, ciphertext: ciphertext, baseUrl: draft.cleanBaseUrl, model: draft.cleanModel))
                dismiss()
            } catch { problem = (error as? DaemonError)?.reason ?? (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// The three fields of a profile that pays by a key.
private struct ApiKeyFields: View {
    let agent: ProfileAgent
    @Binding var draft: ApiKeyDraft
    /// It has a key already: the field may stay empty.
    let kept: Bool

    var body: some View {
        SecureField("API Key", text: $draft.key, prompt: Text(kept ? "Kept" : ""))
        TextField("Base URL", text: $draft.baseUrl, prompt: Text(ApiKeyDraft.home(agent.id) ?? ""))
        TextField("Model", text: $draft.model, prompt: Text("Optional"))
    }
}

/// A colour's swatch for a menu (a menu draws pictures, not views): a filled dot, in the colour as this appearance has it.
enum ProfileSwatch {
    static func image(_ color: ProfileColor, side: CGFloat = 10) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor(Color.profile(color)).setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// One agent's profiles: a row each, the current one marked; a new one, and one removed (not `Default`).
struct ProfilesSection: View {
    @Environment(\.profileNodeID) private var profileNodeID
    let agent: ProfileAgent
    let profiles: AgentProfiles
    let error: String?
    let add: () -> Void
    let remove: (AgentProfile) -> Void
    let proxy: (AgentProfile) -> Void
    /// Its name, changed (§3.3).
    var rename: ((AgentProfile) -> Void)? = nil
    var sessionKey: ((AgentProfile) -> Void)? = nil
    /// What a profile of its own holds of `Default`'s, changed (§3.8).
    var copies: ((AgentProfile) -> Void)? = nil
    var apiKey: ((AgentProfile) -> Void)? = nil
    var resetIdentity: (() -> Void)? = nil
    var authJSON: ((AgentProfile) -> Void)? = nil
    var health: [String: ProfileHealth] = [:]
    var checkingHealth: Set<String> = []
    var checkHealth: ((AgentProfile) -> Void)? = nil
    @State private var resettingIdentity = false
    /// Claude Code's telemetry under a profile turned on or off (docs/profiles-v0.md §3.7).
    var telemetry: ((AgentProfile, Bool) -> Void)? = nil
    let color: (AgentProfile, ProfileColor) -> Void

    /// `work@example.com · Isolated · Telemetry Off · Tampa 23.26.109.123`.
    static func detail(_ profile: AgentProfile, onNode: Bool) -> String {
        [ProfileWords.who(profile), profile.isolated == true ? "Isolated" : nil, profile.telemetryOff ? "Telemetry Off" : nil,
         profile.proxy == nil && onNode ? "This Node" : profile.way].compactMap { $0 }.joined(separator: " · ")
    }

    private static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// What is done less often than a row's two buttons, and the row's words to copy whole.
    @ViewBuilder private func rowMenu(_ profile: AgentProfile) -> some View {
        Button("Copy Name") { Self.copy(profile.name) }
        if let account = profile.account { Button("Copy Account") { Self.copy(account) } }
        if profile.proxy != nil { Button("Copy Exit") { Self.copy(profile.way) } }
        if agent.isClaude {
            Divider()
            if profile.isolated == true, let copies {
                Button("Copies…") { copies(profile) }.help("这个配置从 Default 复制了哪些技能、插件、MCP 与设置。")
            }
            // For the terminals started under it from now on: `DISABLE_TELEMETRY=1` when off.
            if !profile.isDefault, let telemetry {
                Toggle("Telemetry", isOn: Binding(get: { !profile.telemetryOff }, set: { telemetry(profile, $0) }))
            }
        }
        if profile.isDefault && agent.isClaude, resetIdentity != nil {
            Divider()
            Button("Reset Identity…", role: .destructive) { resettingIdentity = true }
        } else if !profile.isDefault {
            Divider()
            if let rename { Button("Rename…") { rename(profile) } }
            Button("Delete…", role: .destructive) { remove(profile) }
        }
    }

    var body: some View {
        Section {
            ForEach(profiles.profiles) { profile in
                VStack(alignment: .leading, spacing: 8) {
                // A list row as the system's own are laid out (2026-11-22, user: 排列看上去丑丑的): the name over one
                // line of what it is, both whole — a long name wraps, it is not cut in the middle — and beside them
                // the two things done most, the rest in a menu. Before, four buttons stood in the name's line and
                // names and accounts were shortened to fit ("cvp_ late…gmail.com").
                HStack(alignment: .top, spacing: 10) {
                    // No "current" one to pick here (docs/profiles-v0.md §3.3): a profile is chosen where a terminal
                    // is made or a conversation continued.
                    // Its colour — the dot on the terminals that run under it — and the menu that changes it. `Default`
                    // has none; its place is kept so the names line up.
                    Group {
                        if let tint = profile.tint {
                            Menu {
                                Picker("Color", selection: Binding(get: { tint }, set: { color(profile, $0) })) {
                                    ForEach(ProfileColor.allCases) { choice in
                                        Label { Text(choice.title) } icon: { Image(nsImage: ProfileSwatch.image(choice)) }.tag(choice)
                                    }
                                }
                                .pickerStyle(.inline)
                            } label: {
                                // A menu's button draws a picture, not a view of ours.
                                Image(nsImage: ProfileSwatch.image(tint))
                            }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                            .help("Color")
                            .accessibilityLabel("Color: \(tint.title)")
                        } else {
                            Color.clear
                        }
                    }
                    .frame(width: 16, height: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        // The device Claude Code says it is under it (docs/profiles-v0.md §3.5), once it has run there.
                        Text(profile.name).fixedSize(horizontal: false, vertical: true).help(profile.device.map(DeviceID.help) ?? profile.name)
                        // Who is signed in, what is set for it, and where what runs under it leaves from: this Mac, or
                        // where its own proxy lets traffic out.
                        Text(Self.detail(profile, onNode: profileNodeID != nil)).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if !profile.isDefault || agent.isClaude || agent.isCodex {
                        HStack(spacing: 6) {
                            if agent.isCodex, let authJSON {
                                Button("auth.json…") { authJSON(profile) }
                            }
                            // Claude Code's profiles only: the key signs its own browser in to claude.ai (§3.4).
                            if profile.paysByKey, let apiKey {
                                Button("API Key…") { apiKey(profile) }
                            }
                            // One that pays by a key has nobody to sign in to claude.ai.
                            if agent.isClaude, !profile.paysByKey, let sessionKey {
                                Button("Session Key…") { sessionKey(profile) }
                                    .help(profile.hasSessionKey ? "已保存一个 session key。" : "")
                            }
                            Button("Proxy…") { proxy(profile) }
                            Menu {
                                rowMenu(profile)
                            } label: { Image(systemName: "ellipsis") }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().frame(width: 22)
                            .help("More").accessibilityLabel("More")
                        }
                        .controlSize(.small).fixedSize()
                    }
                }
                .contextMenu { rowMenu(profile) }
                if let checkHealth {
                    let key = "\(agent.id).\(profile.id)"
                    HStack(alignment: .top, spacing: 10) {
                        Button(checkingHealth.contains(key) ? "Checking…" : "Check Health") { checkHealth(profile) }
                            .controlSize(.small).disabled(checkingHealth.contains(key))
                        if let result = health[key] {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(result.title) · \(result.message)").foregroundStyle(result.status == "healthy" ? Color.green : result.status == "unhealthy" ? Color.red : Color.secondary)
                                ForEach(result.windows, id: \.label) { window in
                                    Text(window.summary)
                                }
                                Text("检查于 " + Date(timeIntervalSince1970: result.checkedAt / 1000).formatted(date: .abbreviated, time: .shortened)).foregroundStyle(.secondary)
                            }.font(.caption).textSelection(.enabled)
                        } else { Text("Not Checked").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.leading, 26)
                }
                }
            }
            if profiles.creatable { Button("New Profile…", action: add) }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
        } header: {
            Text("\(agent.title) Profiles")
        }
        .confirmationDialog("重置 Default 的身份信息？", isPresented: $resettingIdentity) {
            Button("Reset Identity", role: .destructive) { resetIdentity?() }
        } message: {
            Text("删除 ~/.claude.json 的 userID、machineID 和 oauthAccount，并清除钥匙串中 Default 的登录凭据；其他配置和历史记录保留。之后需重新登录 Claude Code。请先退出使用 Default 的 Claude Code。")
        }
    }
}

private struct AgentSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.agentsAct) private var act
    let board: AgentsBoard
    let report: AgentReport
    let delete: (AgentInstall) -> Void
    let clean: () -> Void
    let pin: () -> Void
    let restart: () -> Void

    var body: some View {
        let agent = report.agent
        let channels = board.releases?.channels(agent)
        let used = board.inUse(report)
        let job = board.job(agent)
        // A job that failed holds only its own line until it is read; the others can be used again.
        let busy = job.map { !$0.failed } ?? false
        let rows = AgentRow.rows(report, channels: channels)
        Section {
            ForEach(rows) { row in
                switch row {
                case .install(let install):
                    let newer = board.newer(for: install)
                    let managed = install.source == .stable || install.source == .beta || install.source == .pinned
                    InstallRow(install: install, used: used?.key == install.key, newer: newer, detail: AgentText.detail(install, home: board.home),
                               job: job?.row == install.key ? job : nil, busy: busy,
                               use: { act.run(AgentsAction(.use, agent: agent, key: install.key)) },
                               update: install.source == .stable || install.source == .beta ? newer.map { version in { act.run(AgentsAction(.update, agent: agent, key: install.key, version: version)) } } : nil,
                               delete: managed ? { delete(install) } : nil)
                case .missing(let source, let available):
                    // The vendor's installer picks its own newest where the channel was not read; a beta needs its number.
                    let can = source == .stable || available != nil
                    MissingRow(agent: agent, source: source, available: available, job: job?.row == row.id ? job : nil, busy: busy,
                               install: can ? { act.run(AgentsAction(.install, agent: agent, source: source, version: available, row: row.id)) } : nil)
                case .leftovers(let leftovers):
                    LeftoversRow(leftovers: leftovers, job: job?.row == row.id ? job : nil, busy: busy, clean: clean)
                }
            }
            // The choice made here is not what the service runs yet: said here, where it was made, with the way to
            // make it so (on 2026-10-06 the line at the top of the page alone went unseen).
            if board.pending.contains(agent) {
                HStack(alignment: .center, spacing: 10) {
                    StatusDot(level: .warning).frame(width: 16)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Applies After Restart")
                        Text(AgentText.pendingRestart(report, chosen: used, applied: board.applied(agent)))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    Button("Restart Service…", action: restart).controlSize(.small)
                }
                .padding(.vertical, 2)
            }
            // A pinned version on its way has no line of its own yet.
            if let job, !rows.contains(where: { $0.id == job.row }) {
                HStack(spacing: 10) {
                    Image(systemName: "circle").font(.system(size: 14)).foregroundStyle(.secondary).opacity(0.3)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(job.source.title)
                        Text(job.version ?? "").foregroundStyle(.secondary).monospacedDigit()
                    }
                    Spacer(minLength: 12)
                    JobProgress(job: job)
                }
                .padding(.vertical, 2)
            }
        } header: {
            SectionLabel(agent.title)
        } footer: {
            HStack(alignment: .firstTextBaseline) {
                if let note { Footer(note) } else { Spacer() }
                if agent.betaCommand != nil {
                    Button("Install Version…", action: pin).controlSize(.small).disabled(busy)
                }
            }
        }
    }

    private var note: String? {
        if AgentSelection.lost(report, saved: board.use[report.agent.rawValue]) {
            let now = board.inUse(report).map { "，现改用 \($0.source.title) \($0.version ?? "")" } ?? ""
            return "原先选用的版本已不存在\(now)。"
        }
        guard report.agent == .pi else { return nil }
        return report.install("stable") == nil ? "pi 没有测试通道。需要 Node.js 22.19 或更新的版本。" : "pi 没有测试通道。"
    }
}

/// Grok's or Antigravity's group (docs/agents-v0.md §13): `Stable 1.0.92` over `grok · ~/.grok/bin`, and on the right
/// what its own updater can do — `Update → 1.0.93` when Grok says there is one, `Update` for Antigravity (it does not
/// say), `Up to Date` when there is not; `Not Installed` with no button.
private struct AgentExtraSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.agentsAct) private var act
    let extra: AgentExtra
    let job: AgentExtraJob?
    let update: () -> Void

    private var detail: String {
        guard let binary = extra.binary else { return extra.command }
        let folder = DisplayPath.short((binary as NSString).deletingLastPathComponent, home: model.paths.userHome.path)
        return "\(extra.command) · \(folder)"
    }

    var body: some View {
        Section {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "circle").font(.system(size: 14)).foregroundStyle(.secondary).opacity(0.3)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Stable")
                        Text(extra.version ?? (extra.installed ? "…" : "Not Installed")).foregroundStyle(.secondary).monospacedDigit()
                    }
                    Text(detail).font(.caption.monospaced()).foregroundStyle(extra.installed ? .secondary : .tertiary)
                        .lineLimit(1).truncationMode(.middle).help(extra.binary ?? extra.command)
                    if let problem = extra.problem { Text(problem).font(.caption).foregroundStyle(Color.waiting) }
                }
                Spacer(minLength: 12)
                if let job {
                    ExtraJobProgress(job: job)
                } else if extra.installed {
                    if let newer = extra.newer {
                        Button("Update → \(newer)", action: update).controlSize(.small)
                    } else if extra.canCheck {
                        HStack(spacing: 5) {
                            StatusDot(level: .ok)
                            Text("Up to Date").mono(12).foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Update", action: update).controlSize(.small)
                    }
                }
            }
            .padding(.vertical, 2)
        } header: {
            SectionLabel(extra.title)
        }
    }
}

/// Their updater on its row: what it is doing, or why it stopped, with the log of what it did.
private struct ExtraJobProgress: View {
    @Environment(AppModel.self) private var model
    @Environment(\.agentsAct) private var act
    let job: AgentExtraJob

    var body: some View {
        if let error = job.error {
            HStack(spacing: 8) {
                Text(error).font(.caption).foregroundStyle(Color.failed).lineLimit(3).multilineTextAlignment(.trailing)
                    .frame(maxWidth: 280, alignment: .trailing).textSelection(.enabled)
                if act.local { Button("Show Log") { NSWorkspace.shared.open(model.agentExtraLogFile(job.id)) }.controlSize(.small) }
                Button("OK") { act.run(AgentsAction(.dismiss, extra: job.id)) }.controlSize(.small)
            }
        } else {
            HStack(spacing: 8) {
                Text(AgentText.phase(job.phase)).mono(12).foregroundStyle(.secondary)
                ProgressView().controlSize(.small)
            }
        }
    }
}

/// `◉ Stable 2.1.291`, under it `claude · ~/.local/bin · Follows Latest`; on the right its size and what can be done
/// with it, or the job at work on it.
private struct InstallRow: View {
    let install: AgentInstall
    let used: Bool
    let newer: String?
    let detail: String
    let job: AgentJob?
    /// Another job runs for this agent: the buttons wait.
    let busy: Bool
    let use: () -> Void
    let update: (() -> Void)?
    let delete: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Button(action: use) {
                Image(systemName: used ? "circle.inset.filled" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(used ? Color.brand : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(!install.selectable)
            .opacity(install.selectable ? 1 : 0.3)
            .help(used ? "AgentSwitch 使用此版本。" : install.selectable ? "让 AgentSwitch 使用此版本。" : "此版本不可用于 AgentSwitch。")
            .accessibilityLabel("Use \(install.source.title) \(install.version ?? "")")
            .accessibilityAddTraits(used ? .isSelected : [])
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(install.source.title)
                    Text(install.version ?? "…").foregroundStyle(.secondary).monospacedDigit()
                }
                Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    .help(install.location)
                if let caution = AgentText.caution(install) {
                    Text(caution).font(.caption).foregroundStyle(Color.waiting)
                }
            }
            Spacer(minLength: 12)
            if let job {
                JobProgress(job: job)
            } else {
                if let bytes = install.bytes {
                    Text(AgentText.size(bytes)).mono(12).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .trailing)
                }
                if let newer {
                    if let update {
                        Button("Update → \(newer)", action: update).controlSize(.small).disabled(busy)
                    } else {
                        HStack(spacing: 5) {
                            StatusDot(level: .warning)
                            Text("\(newer) Available").mono(12).foregroundStyle(.secondary)
                        }
                        .help("有新版本 \(newer)。")
                    }
                }
                if let delete {
                    SettingsDeleteButton("Delete…", action: delete).controlSize(.small).disabled(busy)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// `Stable  Not Installed`, the command it would answer to, and `Install 2.1.285`.
private struct MissingRow: View {
    let agent: AgentCLI
    let source: AgentSource
    let available: String?
    let job: AgentJob?
    let busy: Bool
    let install: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "circle").font(.system(size: 14)).foregroundStyle(.secondary).opacity(0.3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(source.title)
                    Text("Not Installed")
                }
                .foregroundStyle(.secondary)
                Text(source == .beta ? agent.betaCommand ?? "" : agent.command).font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 12)
            if let job {
                JobProgress(job: job)
            } else if let install {
                Button(available.map { "Install \($0)" } ?? "Install", action: install).controlSize(.small).disabled(busy)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A job on its row: what it is doing and how far, `Cancel` while it can be called off; or why it stopped, with the
/// log of what it did.
private struct JobProgress: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    private var profileClient: DaemonClient { model.client(on: profileNodeID) }
    @Environment(\.agentsAct) private var act
    let job: AgentJob

    var body: some View {
        if let error = job.error {
            HStack(spacing: 8) {
                Text(error).font(.caption).foregroundStyle(Color.failed).lineLimit(3).multilineTextAlignment(.trailing)
                    .frame(maxWidth: 280, alignment: .trailing).textSelection(.enabled)
                // The log is a file on the Mac the job ran on.
                if act.local { Button("Show Log") { NSWorkspace.shared.open(model.agentLogFile(job.agent)) }.controlSize(.small) }
                Button("OK") { act.run(AgentsAction(.dismiss, agent: job.agent)) }.controlSize(.small)
            }
        } else {
            HStack(spacing: 8) {
                Text(AgentText.phase(job.phase)).mono(12).foregroundStyle(.secondary)
                if let fraction = AgentText.fraction(job.phase) {
                    ProgressView(value: fraction).progressViewStyle(.linear).frame(width: 90)
                } else {
                    ProgressView().controlSize(.small)
                }
                Button("Cancel") { act.run(AgentsAction(.cancel, agent: job.agent)) }.controlSize(.small).disabled(!job.cancellable)
            }
        }
    }
}

/// `Old Versions  2.1.288 · 2.1.289`: what the vendor's own install keeps beside the current one, and `Clean Up…`.
private struct LeftoversRow: View {
    let leftovers: AgentLeftovers
    let job: AgentJob?
    let busy: Bool
    let clean: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "circle").font(.system(size: 14)).hidden()
            Text("Old Versions").foregroundStyle(.secondary)
            Text(leftovers.versions.joined(separator: " · ")).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 12)
            if let job {
                JobProgress(job: job)
            } else {
                if let bytes = leftovers.bytes {
                    Text(AgentText.size(bytes)).mono(12).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .trailing)
                }
                Button("Clean Up…", action: clean).controlSize(.small).disabled(busy)
            }
        }
    }
}

/// `Install Version…`: one version by its number, into the store as a pinned version — for AgentSwitch to run, not on
/// the command line, never updated (agents-v0 §2).
private struct PinSheet: View {
    @Environment(\.dismiss) private var dismiss
    let agent: AgentCLI
    let install: (String) -> Void
    @State private var version = ""

    var body: some View {
        let text = version.trimmingCharacters(in: .whitespaces)
        let valid = AgentVersion.isWellFormed(text)
        VStack(alignment: .leading, spacing: 14) {
            Text("Install Version").font(.headline)
            Text("安装 \(agent.title) 的某个指定版本，仅供 AgentSwitch 使用：不出现在命令行中，也不会更新。").font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Version", text: $version, prompt: Text(example))
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .onSubmit { if valid { submit(text) } }
            if !text.isEmpty && !valid {
                Text("版本号的写法如 \(example)。").font(.caption).foregroundStyle(Color.waiting)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Install") { submit(text) }.keyboardShortcut(.defaultAction).disabled(!valid)
            }
        }
        .padding(20)
        .frame(width: 380)
    }

    private var example: String {
        switch agent {
        case .claude: return "2.1.285"
        case .codex: return "0.160.1"
        case .opencode: return "2.0.24"
        case .pi: return "1.0.4"
        }
    }

    private func submit(_ text: String) {
        install(text)
        dismiss()
    }
}

/// The page's buttons, for the rows under it: done on this Mac, or asked of the node whose installs are shown.
struct AgentsAct: @unchecked Sendable {
    var local = true
    var run: (AgentsAction) -> Void = { _ in }
}
private struct AgentsActKey: EnvironmentKey { static let defaultValue = AgentsAct() }
extension EnvironmentValues {
    var agentsAct: AgentsAct {
        get { self[AgentsActKey.self] }
        set { self[AgentsActKey.self] = newValue }
    }
}
