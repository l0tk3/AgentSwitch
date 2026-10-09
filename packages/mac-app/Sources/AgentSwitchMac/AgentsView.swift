import AgentSwitchMacCore
import AppKit
import SwiftUI

/// 设置 › Agents (docs/agents-v0.md §8, docs/design/concepts/agents.html): the four agent CLIs — what is installed and
/// where it came from, what the vendors have that is newer, which install AgentSwitch runs — and what can be done with
/// each: installing and updating the vendor's own, a beta or a pinned version; deleting any of them but ChatGPT App's
/// (asked first); clearing the old versions a vendor keeps.
struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRestart = false
    /// Each agent's profiles, as the service has them; what went wrong with the last change, by agent.
    @State private var profiles: [String: AgentProfiles] = [:]
    @State private var profileError: [String: String] = [:]
    /// The agent a new profile is being named for; the name; the profile asked to be removed.
    @State private var naming: AgentCLI?
    @State private var newName = ""
    @State private var removing: (agent: AgentCLI, profile: AgentProfile)?
    /// The profile whose own proxy is being set (docs/profiles-v0.md §4).
    @State private var proxying: ProfileProxyTarget?
    /// The install asked to be deleted, until answered.
    @State private var deleting: AgentInstall?
    /// The agent whose old versions were asked to be cleared, until answered.
    @State private var cleaning: AgentCLI?
    /// `Install Version…` for this agent.
    @State private var pinning: AgentCLI?

    var body: some View {
        Form {
            Section {
                LabeledContent("Updates") {
                    HStack(spacing: 6) {
                        StatusDot(level: model.agentsChecking ? .busy : model.agentUpdateCount > 0 ? .warning : .ok)
                        Text(updatesLine).mono(12).foregroundStyle(.secondary)
                    }
                }
                if model.agentsNeedRestart {
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
                if model.agentsNeedRestart {
                    Footer("已更改 AgentSwitch 使用的版本，重启服务后生效。已打开的终端继续使用原来的程序。")
                } else if let failed = AgentText.failed(model.agentReleases) {
                    Footer(failed)
                }
            }

            ForEach(model.agents) { report in
                AgentSection(report: report, delete: { deleting = $0 }, clean: { cleaning = report.agent }, pin: { pinning = report.agent },
                             restart: { confirmRestart = true })
                profilesSection(report.agent)
            }

            Section {
                LabeledContent("Beta & Pinned") {
                    HStack(spacing: 8) {
                        Text(model.shortPath(model.agentLayout.store)).mono(12).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(AgentText.size(storeBytes)).mono(12).foregroundStyle(.secondary)
                        // With nothing stored there is no folder to show (agents-v0 §6).
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: model.agentLayout.store)]) }
                            .controlSize(.small)
                            .disabled(storeBytes == 0 && !FileManager.default.fileExists(atPath: model.agentLayout.store))
                    }
                }
                ForEach(model.agentPathNotes, id: \.self) { note in
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
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.refreshAgents(force: true); model.checkAgentUpdates(force: true) } label: { Label("Check Now", systemImage: "arrow.clockwise") }
                    .help("Check Now")
                    .disabled(model.agentsChecking)
            }
        }
        .task {
            model.refreshAgents()
            model.checkAgentUpdates()
        }
        .modifier(ProfileDialogs(naming: namingShown, name: $newName, create: create, removing: removingShown, removingName: removing?.profile.name ?? "",
                                 remove: { if let target = removing { delete(target.agent, target.profile) } }))
        .task { profiles = (try? await model.client.profiles()) ?? profiles }
        .sheet(item: $proxying) { target in
            ProfileProxySheet(agent: target.agent, profile: target.profile) { agents in profiles = agents }
        }
        .confirmationDialog("重启服务？", isPresented: $confirmRestart) {
            Button("Restart Service") { model.restartDaemon() }
        } message: {
            Text("服务重启后改用新选择的版本。正在运行的任务和已打开的终端将中断。")
        }
        .confirmationDialog(deleteQuestion?.title ?? "", isPresented: deletingShown, presenting: deleting) { install in
            Button(install.source == .stable ? "Uninstall" : "Delete", role: .destructive) { model.deleteAgent(install) }
        } message: { _ in
            Text(deleteQuestion?.message ?? "")
        }
        .confirmationDialog(cleanQuestion?.title ?? "", isPresented: cleaningShown, presenting: cleaning) { agent in
            Button("Clean Up", role: .destructive) { model.cleanAgent(agent) }
        } message: { _ in
            Text(cleanQuestion?.message ?? "")
        }
        .sheet(item: $pinning) { agent in
            PinSheet(agent: agent) { version in
                model.installAgent(agent, .pinned, version: version, row: AgentInstall.pinnedKey(version))
            }
        }
    }

    private var deletingShown: Binding<Bool> { Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }) }
    private var cleaningShown: Binding<Bool> { Binding(get: { cleaning != nil }, set: { if !$0 { cleaning = nil } }) }

    /// What the dialog asks about the install being deleted: is it the one in use, and what is used after it.
    private var deleteQuestion: (title: String, message: String)? {
        guard let install = deleting, let report = model.agents.first(where: { $0.agent == install.agent }) else { return nil }
        let home = model.paths.userHome.path
        let inUse = model.agentInUse(report)?.key == install.key
        var without = report
        without.installs.removeAll { $0.key == install.key }
        let next = AgentSelection.fallback(without)
        guard install.source == .stable else { return AgentText.deleteQuestion(install, inUse: inUse, next: next, home: home) }
        // The vendor's install goes whole, the versions it keeps beside the current one with it.
        let bytes = install.bytes.map { $0 + (report.leftovers?.bytes ?? 0) }
        return AgentText.uninstallQuestion(install, paths: model.agentUninstallPaths(install.agent), bytes: bytes, inUse: inUse, next: next, home: home)
    }

    private var cleanQuestion: (title: String, message: String)? {
        guard let agent = cleaning, let report = model.agents.first(where: { $0.agent == agent }), let leftovers = report.leftovers else { return nil }
        return AgentText.cleanQuestion(agent, leftovers: leftovers, current: report.install("stable")?.version, home: model.paths.userHome.path)
    }

    private var updatesLine: String {
        let checked = AgentText.checked(model.agentReleases, checking: model.agentsChecking)
        guard !model.agentsChecking, model.agentReleases?.checkedAt != nil else { return checked }
        let count = model.agentUpdateCount
        return "\(count == 0 ? "Up to Date" : "\(count) Available") · \(checked)"
    }

    /// What the store holds: the betas and the pinned versions.
    private var storeBytes: Int64 {
        model.agents.flatMap(\.installs).filter { $0.source == .beta || $0.source == .pinned }.reduce(0) { $0 + ($1.bytes ?? 0) }
    }

    /// Its sign-ins (docs/profiles-v0.md §3): the one new terminals start under, and others to switch to.
    @ViewBuilder private func profilesSection(_ agent: AgentCLI) -> some View {
        if let list = profiles[agent.rawValue] {
            ProfilesSection(agent: agent, profiles: list, error: profileError[agent.rawValue],
                            pick: { id in pick(agent, id) },
                            add: { naming = agent; newName = "" },
                            remove: { profile in removing = (agent, profile) },
                            proxy: { profile in proxying = ProfileProxyTarget(agent: agent, profile: profile) },
                            color: { profile, color in change(agent) { try await $0.setProfileColor(agent: agent.rawValue, id: profile.id, color: color) } })
        }
    }

    private func pick(_ agent: AgentCLI, _ id: String) { change(agent) { try await $0.setCurrentProfile(agent: agent.rawValue, id: id) } }
    private func create() { if let agent = naming { let name = newName; change(agent) { try await $0.createProfile(agent: agent.rawValue, name: name) } } }
    private func delete(_ agent: AgentCLI, _ profile: AgentProfile) { change(agent) { try await $0.deleteProfile(agent: agent.rawValue, id: profile.id) } }
    private var namingShown: Binding<Bool> { Binding(get: { naming != nil }, set: { if !$0 { naming = nil } }) }
    private var removingShown: Binding<Bool> { Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }) }

    /// One change to an agent's profiles, and what the service has afterwards (or why it did not take it).
    private func change(_ agent: AgentCLI, _ call: @escaping (DaemonClient) async throws -> [String: AgentProfiles]) {
        let client = model.client
        Task {
            do { profiles = try await call(client); profileError[agent.rawValue] = nil }
            catch { profileError[agent.rawValue] = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}

/// One agent's group: a line per install, the radio on the left saying which one AgentSwitch runs.
/// The two questions of the profiles sections: a new one's name, and whether to remove one.
private struct ProfileDialogs: ViewModifier {
    let naming: Binding<Bool>
    let name: Binding<String>
    let create: () -> Void
    let removing: Binding<Bool>
    let removingName: String
    let remove: () -> Void

    func body(content: Content) -> some View {
        content
            .alert("New Profile", isPresented: naming) {
                TextField("Name", text: name)
                Button("Create", action: create)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("一份新的登录，放在它自己的目录里。建好后在它名下开一个终端，运行 /login。")
            }
            .confirmationDialog("删除这个配置？", isPresented: removing) {
                Button("Delete \(removingName)", role: .destructive, action: remove)
            } message: {
                Text("它的登录和它自己的目录会被删除；会话记录是共用的，会留着。")
            }
    }
}

/// The profile whose proxy is being set.
struct ProfileProxyTarget: Identifiable {
    let agent: AgentCLI
    let profile: AgentProfile
    var id: String { "\(agent.rawValue)/\(profile.id)" }
}

/// A profile's own proxy (docs/profiles-v0.md §4): its address, a user name, a password — sealed by this Mac's gate for
/// the proxy's own host before anything is sent, as the browser's is. Applied, it is checked at once: where it lets
/// traffic out is shown, or why it let nothing out (it is kept all the same: it may be down for now).
struct ProfileProxySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let agent: AgentCLI
    let profile: AgentProfile
    let done: ([String: AgentProfiles]) -> Void
    @State private var draft: BrowserProxyDraft
    @State private var exit: ProfileExit?
    @State private var problem: String?
    @State private var busy = false

    init(agent: AgentCLI, profile: AgentProfile, problem: String? = nil, done: @escaping ([String: AgentProfiles]) -> Void) {
        self.agent = agent
        self.profile = profile
        self.done = done
        _draft = State(initialValue: BrowserProxyDraft(profile.proxy))
        _exit = State(initialValue: profile.exit)
        _problem = State(initialValue: problem)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(profile.name) · Proxy").font(.headline)
            Text("在这个配置名下开的终端，agent 和它运行的命令发出去的流量都从这个代理走，它的浏览器（一个单独的窗口，/login 的登录页也开在里面）也是；这台 Mac 自己的地址不走。开终端之前会先查一次这个代理，不通就不开，不会改成直连。可以把整条代理地址（http://用户名:密码@主机:端口）直接粘进 Server，用户名和密码会自己分到下面两栏。密码在这台 Mac 上加密后才保存。")
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

    /// The proxy set (nil: none) and checked. With a problem the sheet stays, saying it; without, the exit is shown and
    /// the sheet stays for it to be read (nil closes).
    private func apply(_ draft: BrowserProxyDraft?) {
        let client = model.client, gate = model.gateCLI, agent = agent.rawValue, id = profile.id, current = profile.proxy
        busy = true
        problem = nil
        Task {
            do {
                var request: BrowserProxyRequest?
                if let draft, let site = BrowserIdentityText.proxySite(draft.server) {
                    var ciphertext: String?
                    if !draft.password.isEmpty { ciphertext = try await gate.seal(GateSealRequest(label: "profile/proxy", sites: site, value: draft.password)) }
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
    let agent: AgentCLI
    let profiles: AgentProfiles
    let error: String?
    let pick: (String) -> Void
    let add: () -> Void
    let remove: (AgentProfile) -> Void
    let proxy: (AgentProfile) -> Void
    let color: (AgentProfile, ProfileColor) -> Void

    var body: some View {
        Section {
            ForEach(profiles.profiles) { profile in
                HStack(spacing: 10) {
                    Button { pick(profile.id) } label: {
                        Image(systemName: profile.id == profiles.current ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(profile.id == profiles.current ? Color.accentColor : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(profile.id == profiles.current ? "Current" : "Use \(profile.name)")
                    // Its colour — the dot on the terminals that run under it — and the menu that changes it. `Default`
                    // has none; its place is kept so the names line up.
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
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().frame(width: 16)
                        .help("Color")
                        .accessibilityLabel("Color: \(tint.title)")
                    } else {
                        Color.clear.frame(width: 16, height: 16)
                    }
                    Text(profile.name)
                    Text(profile.account ?? (profile.isDefault ? "This Mac’s own" : "Not Signed In")).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    // Where what runs under it leaves from: this Mac, or where its own proxy lets traffic out.
                    Text(profile.way).font(.callout).monospacedDigit().foregroundStyle(profile.proxy == nil ? .tertiary : .secondary).lineLimit(1)
                    if !profile.isDefault {
                        Button("Proxy…") { proxy(profile) }.controlSize(.small)
                        Button("Delete…") { remove(profile) }.controlSize(.small)
                    }
                }
            }
            if profiles.creatable { Button("New Profile…", action: add) }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
        } header: {
            Text("\(agent.title) Profiles")
        } footer: {
            if profiles.creatable {
                Footer("每个配置是一份单独的登录，放在它自己的目录里，不改这台 Mac 原有的那一份。选中的是新终端使用的配置；已经开着的终端不变。新建之后在它名下开一个终端，没登录的配置会直接从登录开始。每个配置有一个颜色（名字前的圆点，点它可以换）：在它名下运行的终端，列表和底栏里带着同色的亮点。配置可以有自己的代理（Proxy…）：在它名下开终端之前，先经这个代理查一次通不通、从哪里出去，不通就不开；查到的出口写在终端底栏的配置名后面。每个配置还有它自己的浏览器——一个单独的浏览器窗口，登录态和指纹都是它自己的，agent 的浏览器工具和 /login 打开的登录页都在里面；有代理的配置，浏览器和 agent 从同一个代理出去。")
            }
        }
    }
}

private struct AgentSection: View {
    @Environment(AppModel.self) private var model
    let report: AgentReport
    let delete: (AgentInstall) -> Void
    let clean: () -> Void
    let pin: () -> Void
    let restart: () -> Void

    var body: some View {
        let agent = report.agent
        let channels = model.agentReleases?.channels(agent)
        let used = model.agentInUse(report)
        let job = model.agentJob(agent)
        // A job that failed holds only its own line until it is read; the others can be used again.
        let busy = job.map { !$0.failed } ?? false
        let rows = AgentRow.rows(report, channels: channels)
        Section {
            ForEach(rows) { row in
                switch row {
                case .install(let install):
                    let newer = model.newerVersion(for: install)
                    let managed = install.source == .stable || install.source == .beta || install.source == .pinned
                    InstallRow(install: install, used: used?.key == install.key, newer: newer, detail: AgentText.detail(install, home: model.paths.userHome.path),
                               job: job?.row == install.key ? job : nil, busy: busy,
                               use: { model.useAgent(agent, install: install) },
                               update: install.source == .stable || install.source == .beta ? newer.map { version in { model.updateAgent(install, to: version) } } : nil,
                               delete: managed ? { delete(install) } : nil)
                case .missing(let source, let available):
                    // The vendor's installer picks its own newest where the channel was not read; a beta needs its number.
                    let can = source == .stable || available != nil
                    MissingRow(agent: agent, source: source, available: available, job: job?.row == row.id ? job : nil, busy: busy,
                               install: can ? { model.installAgent(agent, source, version: available, row: row.id) } : nil)
                case .leftovers(let leftovers):
                    LeftoversRow(leftovers: leftovers, job: job?.row == row.id ? job : nil, busy: busy, clean: clean)
                }
            }
            // The choice made here is not what the service runs yet: said here, where it was made, with the way to
            // make it so (on 2026-10-06 the line at the top of the page alone went unseen).
            if model.agentsPending.contains(agent) {
                HStack(alignment: .center, spacing: 10) {
                    StatusDot(level: .warning).frame(width: 16)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Applies After Restart")
                        Text(AgentText.pendingRestart(report, chosen: used, applied: model.agentsApplied[agent]))
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
        if AgentSelection.lost(report, saved: model.agentUse[report.agent.rawValue]) {
            let now = model.agentInUse(report).map { "，现改用 \($0.source.title) \($0.version ?? "")" } ?? ""
            return "原先选用的版本已不存在\(now)。"
        }
        guard report.agent == .pi else { return nil }
        return report.install("stable") == nil ? "pi 没有测试通道。需要 Node.js 22.19 或更新的版本。" : "pi 没有测试通道。"
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
    let job: AgentJob

    var body: some View {
        if let error = job.error {
            HStack(spacing: 8) {
                Text(error).font(.caption).foregroundStyle(Color.failed).lineLimit(3).multilineTextAlignment(.trailing)
                    .frame(maxWidth: 280, alignment: .trailing).textSelection(.enabled)
                Button("Show Log") { NSWorkspace.shared.open(model.agentLogFile(job.agent)) }.controlSize(.small)
                Button("OK") { model.dismissAgentJob(job.agent) }.controlSize(.small)
            }
        } else {
            HStack(spacing: 8) {
                Text(AgentText.phase(job.phase)).mono(12).foregroundStyle(.secondary)
                if let fraction = AgentText.fraction(job.phase) {
                    ProgressView(value: fraction).progressViewStyle(.linear).frame(width: 90)
                } else {
                    ProgressView().controlSize(.small)
                }
                Button("Cancel") { model.cancelAgentJob(job.agent) }.controlSize(.small).disabled(!job.cancellable)
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
