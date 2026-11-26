import AgentSwitchMacCore
import SwiftUI

/// 设置 › Add-Ons (docs/profiles-v0.md "Add-Ons"; `docs/design/concepts/profile-addons.html`): what each profile has
/// installed — MCP servers, skills, plugins, agents, commands — for as many profiles as there are. Left: the
/// profiles, filtered and ticked. Right: what the ticked ones have — one profile is a list with a switch a row;
/// several, or none ticked (all), is each add-on once with how many of them have it, opening to the profiles
/// themselves. `Install MCP…` takes the agent's own command and runs it under the profiles chosen.
struct AddonsView: View {
    @Environment(AppModel.self) private var model
    @State private var agent: ProfileAgent = AddonsView.firstAgent
    /// The agent the page opens on: Claude, but for the design preview's pictures of the others.
    static var firstAgent: ProfileAgent = .claude
    @State private var profiles: [AgentProfile] = []
    @State private var data: ProfileAddons?
    @State private var selected: Set<String> = []
    @State private var profileFilter = ""
    @State private var search = ""
    @State private var open: Set<String> = []
    @State private var problem: String?
    @State private var note: String?
    @State private var busy = false
    @State private var installing = false
    @State private var copying: ProfileAddon?

    /// Every agent with profiles (user #567): the four Agents looks after, Grok and Antigravity.
    private static let agents: [ProfileAgent] = ProfileAgent.shown

    /// The profiles the right side is about, in the list's order: the ticked ones, or all.
    private var scope: [AgentProfile] { selected.isEmpty ? profiles : profiles.filter { selected.contains($0.id) } }
    private var one: AgentProfile? { selected.count == 1 ? scope.first : nil }
    private func name(_ id: String) -> String { profiles.first { $0.id == id }?.name ?? id }

    var body: some View {
        Group {
            if !model.daemonReady {
                EmptyPage(title: "Service Not Ready", symbol: "hourglass", message: model.daemonLine.text)
            } else if let data {
                VStack(spacing: 0) {
                    // Six agents (user #567): a row of their own across the page — the profile column is too narrow.
                    Picker("Agent", selection: $agent) {
                        ForEach(Self.agents) { Text(AddonWords.agent($0.id)).tag($0) }
                    }
                    .pickerStyle(.segmented).labelsHidden().fixedSize()
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 4)
                    HStack(spacing: 0) {
                        profilePane(data).frame(width: 236)
                        Divider()
                        content(data)
                    }
                }
            } else if let problem {
                EmptyPage(title: "Add-Ons: Unavailable", symbol: "exclamationmark.triangle", message: problem) {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload").disabled(!model.daemonReady || busy)
            }
        }
        .task(id: "\(model.daemonReady)/\(agent.id)") { await load() }
        .sheet(isPresented: $installing) {
            AddonInstallSheet(agent: agent, profiles: profiles, data: data, preselected: Set(scope.map(\.id))) { results in
                note = AddonWords.summary(results, done: "Installed", name: name)
                Task { await load() }
            }
        }
        .sheet(item: $copying) { item in
            AddonTargetsSheet(title: "Copy \(item.name) to Profiles", confirm: "Copy", profiles: profiles.filter { $0.id != one?.id }, blocked: blocked(kind: item.kind)) { targets in
                guard let from = one?.id else { return }
                run("Copied") { try await $0.copyAddon(agent: agent.id, kind: item.kind, name: item.name, from: from, profiles: targets) }
            }
        }
    }

    // MARK: The profiles

    private func profilePane(_ data: ProfileAddons) -> some View {
        let shown = profiles.filter { profileFilter.isEmpty || $0.name.localizedCaseInsensitiveContains(profileFilter) }
        return VStack(alignment: .leading, spacing: 8) {
            TextField(profiles.count == 1 ? "Filter 1 Profile" : "Filter \(profiles.count) Profiles", text: $profileFilter).textFieldStyle(.roundedBorder)
            HStack(spacing: 6) {
                Button(profileFilter.isEmpty ? "Select All" : "Select Shown") { selected = Set(shown.map(\.id)) }
                Button("Isolated") { selected = Set(shown.filter { $0.isolated == true }.map(\.id)) }
                Button("None") { selected = [] }
            }
            .controlSize(.small)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(shown) { profile in
                        profileRow(profile, count: data.kinds.contains("mcp") ? data.items(of: profile.id).filter { $0.kind == "mcp" }.count : nil)
                    }
                    if shown.isEmpty { Text("没有匹配的配置。").font(.callout).foregroundStyle(.secondary).padding(8) }
                }
            }
            Divider()
            HStack {
                Text(selected.isEmpty ? "None Selected · Showing All" : "\(selected.count) Selected").font(.callout).foregroundStyle(.secondary)
                Spacer()
                if !selected.isEmpty { Button("Clear") { selected = [] }.buttonStyle(.link).controlSize(.small) }
            }
        }
        .padding(12)
    }

    private func profileRow(_ profile: AgentProfile, count: Int?) -> some View {
        let on = selected.contains(profile.id)
        return HStack(spacing: 8) {
            Toggle("Select \(profile.name)", isOn: Binding(get: { on }, set: { if $0 { selected.insert(profile.id) } else { selected.remove(profile.id) } }))
                .toggleStyle(.checkbox).labelsHidden()
            Button { selected = [profile.id] } label: {
                HStack(spacing: 8) {
                    AddonDot(profile: profile)
                    Text(profile.name).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let count { Text("\(count) mcp").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help(profile.name)
        }
        .padding(.horizontal, 6).frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 6).fill(on ? Color.brand.opacity(0.16) : Color.clear))
    }

    // MARK: What they have

    private func content(_ data: ProfileAddons) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if let one { AddonDot(profile: one); Text(one.name).font(.headline).lineLimit(1) }
                else { Text(selected.isEmpty ? (profiles.count == 1 ? "1 Profile" : "All \(profiles.count) Profiles") : "\(selected.count) Profiles").font(.headline) }
                Text(subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 20).padding(.top, 14)
            HStack(spacing: 8) {
                TextField("Search Add-Ons", text: $search).textFieldStyle(.roundedBorder).frame(width: 190)
                Spacer()
                if data.kinds.contains("mcp") { Button("Install MCP…") { installing = true }.buttonStyle(.borderedProminent).disabled(busy) }
            }
            .padding(.horizontal, 20).padding(.vertical, 10)
            if let note { noteLine(note) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(data.kinds, id: \.self) { kind in section(kind, data) }
                }
                .padding(.horizontal, 20).padding(.bottom, 20)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var subtitle: String {
        if let one { return one.isDefault ? "This Mac’s Own" : one.isolated == true ? "Isolated" : "Shares Default’s" }
        guard !selected.isEmpty else { return "" }
        let names = scope.prefix(5).map(\.name).joined(separator: ", ")
        return scope.count > 5 ? "\(names) +\(scope.count - 5)" : names
    }

    private func noteLine(_ text: String) -> some View {
        HStack(spacing: 8) {
            Text(text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(2)
            Spacer()
            Button("Dismiss") { note = nil }.buttonStyle(.link).controlSize(.small)
        }
        .padding(.horizontal, 20).padding(.bottom, 6)
    }

    private func matches(_ item: ProfileAddon) -> Bool {
        search.isEmpty || item.name.localizedCaseInsensitiveContains(search) || (item.about ?? "").localizedCaseInsensitiveContains(search)
    }

    @ViewBuilder
    private func section(_ kind: String, _ data: ProfileAddons) -> some View {
        let ids = scope.map(\.id)
        let rows = data.all(in: ids).filter { $0.kind == kind && matches($0) }
        if !(rows.isEmpty && !search.isEmpty) {
            HStack(spacing: 8) {
                SectionLabel(AddonWords.kind(kind))
                Text("\(rows.count)").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary)
            }
            .padding(.top, 14).padding(.bottom, 6).padding(.leading, 2)
            VStack(spacing: 0) {
                if rows.isEmpty { Text("None").font(.callout).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 9) }
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider() }
                    if let one { singleRow(data.item(item.id, in: one.id) ?? item, profile: one) } else { manyRow(item, data, ids: ids) }
                }
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        }
    }

    private func head(_ item: ProfileAddon, off: Bool, @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 10) {
            Button {
                if open.contains(item.id) { open.remove(item.id) } else { open.insert(item.id) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open.contains(item.id) ? 90 : 0))
                    Text(item.name).font(.system(size: 12.5, design: .monospaced)).strikethrough(off).foregroundStyle(off ? .secondary : .primary).lineLimit(1)
                    Text(item.about ?? item.command ?? "").font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            trailing()
        }
        .padding(.horizontal, 12).frame(minHeight: 36)
    }

    private func details(_ item: ProfileAddon) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
            if let transport = item.transport { GridRow { Text("Transport").foregroundStyle(.secondary); Text(transport).font(.system(size: 12, design: .monospaced)) } }
            if let command = item.command, !command.isEmpty { GridRow { Text(item.transport == "stdio" ? "Command" : "Address").foregroundStyle(.secondary); Text(command).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) } }
            if let secrets = item.secrets, secrets > 0 { GridRow { Text("Secrets").foregroundStyle(.secondary); Text("\(secrets) · Hidden").font(.system(size: 12, design: .monospaced)).foregroundStyle(.tertiary) } }
            if let version = item.version { GridRow { Text("Version").foregroundStyle(.secondary); Text(version).font(.system(size: 12, design: .monospaced)) } }
            if let about = item.about, item.command != nil || item.version != nil { GridRow { Text("About").foregroundStyle(.secondary); Text(about) } }
        }
        .font(.callout)
    }

    /// A Codex server is switched off by how its terminal is started, whoever's file it is in.
    private func canSwitch(_ item: ProfileAddon) -> Bool { item.kind == "mcp" && (!item.shared || agent.isCodex) }

    // One profile: a switch a row.
    @ViewBuilder
    private func singleRow(_ item: ProfileAddon, profile: AgentProfile) -> some View {
        head(item, off: !item.isOn) {
            if !item.isOn { AddonTag(text: "Off") }
            AddonTag(text: item.shared ? "Shared" : "Own", tint: item.shared ? .orange : nil)
            if item.kind == "mcp" {
                Toggle("On", isOn: Binding(get: { item.isOn }, set: { on in
                    run(on ? "Turned on" : "Turned off") { try await $0.switchMCP(agent: agent.id, name: item.name, on: on, profiles: [profile.id]) }
                }))
                .toggleStyle(.switch).controlSize(.mini).labelsHidden().disabled(busy || !canSwitch(item))
            }
        }
        if open.contains(item.id) {
            VStack(alignment: .leading, spacing: 10) {
                details(item)
                HStack(spacing: 8) {
                    if item.shared {
                        Text("和 Default 共用，要改请到 Default。").font(.callout).foregroundStyle(.secondary)
                        Button("Show Default") { selected = ["default"] }
                    } else if item.kind == "plugins" {
                        Text("插件由 agent 自己的 /plugin 安装和移除。").font(.callout).foregroundStyle(.secondary)
                    } else {
                        if AddonWords.files.contains(item.kind) { Button("Copy to Profiles…") { copying = item } }
                        Button("Remove", role: .destructive) { remove(item, from: [profile.id]) }
                    }
                }
                .controlSize(.small).disabled(busy)
            }
            .padding(.leading, 31).padding(.trailing, 12).padding(.bottom, 12).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // Several profiles: how many have it.
    @ViewBuilder
    private func manyRow(_ item: ProfileAddon, _ data: ProfileAddons, ids: [String]) -> some View {
        let states = ids.map { ($0, data.item(item.id, in: $0)) }
        let have = states.filter { $0.1 != nil }, off = have.filter { $0.1?.isOn == false }
        let own = have.filter { $0.1?.shared == false }.map(\.0)
        let missing = states.filter { $0.1 == nil }.map(\.0).filter { !blocked(kind: item.kind).contains($0) }
        head(item, off: false) {
            Text("\(have.count) of \(ids.count)" + (off.isEmpty ? "" : " · \(off.count) off")).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.secondary)
        }
        if open.contains(item.id) {
            VStack(alignment: .leading, spacing: 10) {
                details(have.first?.1 ?? item)
                HStack(spacing: 8) {
                    if AddonWords.files.contains(item.kind), let from = have.first?.0 {
                        Button("Add to \(missing.count) Missing") {
                            run("Copied") { try await $0.copyAddon(agent: agent.id, kind: item.kind, name: item.name, from: from, profiles: missing) }
                        }
                        .disabled(missing.isEmpty)
                    }
                    if item.kind == "mcp" {
                        let switchable = have.filter { $0.1.map(canSwitch) == true }
                        Button("Turn Off") { run("Turned off") { try await $0.switchMCP(agent: agent.id, name: item.name, on: false, profiles: switchable.filter { $0.1?.isOn == true }.map(\.0)) } }
                            .disabled(!switchable.contains { $0.1?.isOn == true })
                        Button("Turn On") { run("Turned on") { try await $0.switchMCP(agent: agent.id, name: item.name, on: true, profiles: switchable.filter { $0.1?.isOn == false }.map(\.0)) } }
                            .disabled(!switchable.contains { $0.1?.isOn == false })
                    }
                    if item.kind != "plugins" {
                        Button("Remove from \(own.count)", role: .destructive) { remove(item, from: own) }.disabled(own.isEmpty)
                    }
                    Text(selected.isEmpty ? "作用于全部配置" : "作用于勾中的配置").font(.callout).foregroundStyle(.secondary)
                }
                .controlSize(.small).disabled(busy)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 118, maximum: 200), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
                    ForEach(states, id: \.0) { id, held in chip(item, profile: id, held: held, from: have.first?.0) }
                }
            }
            .padding(.leading, 31).padding(.trailing, 12).padding(.bottom, 12).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// One profile's state of an add-on, with what can be done about it there.
    private func chip(_ item: ProfileAddon, profile id: String, held: ProfileAddon?, from: String?) -> some View {
        Menu {
            if let held {
                if held.shared && !canSwitch(held) { Text("Shares Default’s") }
                if canSwitch(held) {
                    Button(held.isOn ? "Turn Off" : "Turn On") { run(held.isOn ? "Turned off" : "Turned on") { try await $0.switchMCP(agent: agent.id, name: item.name, on: !held.isOn, profiles: [id]) } }
                }
                Button("Show \(name(id))") { selected = [id]; open.insert(item.id) }
                if !held.shared, item.kind != "plugins" {
                    Divider()
                    Button("Remove from \(name(id))", role: .destructive) { remove(item, from: [id]) }
                }
            } else if AddonWords.files.contains(item.kind), let from, !blocked(kind: item.kind).contains(id) {
                Button("Add to \(name(id))") { run("Copied") { try await $0.copyAddon(agent: agent.id, kind: item.kind, name: item.name, from: from, profiles: [id]) } }
            } else {
                Button("Show \(name(id))") { selected = [id] }
            }
        } label: {
            HStack(spacing: 5) {
                if let held { Circle().fill(held.shared ? Color.orange : held.isOn ? Color.green : Color.secondary).frame(width: 6, height: 6) }
                Text(name(id)).strikethrough(held?.isOn == false).lineLimit(1).truncationMode(.middle)
            }
            .font(.callout).foregroundStyle(held == nil ? .tertiary : .primary)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8).frame(height: 22)
        .background(Capsule().strokeBorder(Color.primary.opacity(held == nil ? 0.1 : 0.2), style: StrokeStyle(lineWidth: 0.5, dash: held == nil ? [3, 2] : [])))
        .disabled(busy)
    }

    /// The profiles whose `kind` is `Default`'s, linked: nothing is copied there or removed from there.
    private func blocked(kind: String) -> Set<String> {
        guard let data else { return [] }
        return Set(profiles.map(\.id).filter { id in id != "default" && (data.items(of: id).contains { $0.kind == kind && $0.shared } || (agent.isCodex && profiles.first { $0.id == id }?.isolated != true)) })
    }

    // MARK: Changes

    private func remove(_ item: ProfileAddon, from ids: [String]) {
        guard !ids.isEmpty else { return }
        if item.kind == "mcp" { run("Removed") { try await $0.removeMCP(agent: agent.id, name: item.name, profiles: ids) } }
        else { run("Removed") { try await $0.removeAddon(agent: agent.id, kind: item.kind, name: item.name, profiles: ids) } }
    }

    private func run(_ done: String, _ work: @escaping (DaemonClient) async throws -> [AddonResult]) {
        guard !busy else { return }
        busy = true
        let client = model.client
        Task {
            do { note = AddonWords.summary(try await work(client), done: done, name: name) }
            catch { note = (error as? DaemonError)?.reason ?? error.localizedDescription }
            await load()
            busy = false
        }
    }

    private func load() async {
        guard model.daemonReady else { return }
        do {
            async let listed = model.client.profiles()
            async let addons = model.client.profileAddons(agent: agent.id)
            let (all, got) = try await (listed, addons)
            profiles = all[agent.id]?.profiles ?? []
            data = got
            selected = selected.filter { id in profiles.contains { $0.id == id } }
            problem = nil
        } catch {
            if data == nil || data?.agent != agent.id { data = nil; problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}

/// A profile's colour as a dot; `Default` has none and is a ring.
private struct AddonDot: View {
    let profile: AgentProfile

    var body: some View {
        if let tint = profile.tint { Circle().fill(Color.profile(tint)).frame(width: 9, height: 9) }
        else { Circle().strokeBorder(Color.secondary, lineWidth: 1).frame(width: 9, height: 9) }
    }
}

private struct AddonTag: View {
    let text: String
    var tint: Color? = nil

    var body: some View {
        Text(text).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(tint ?? .secondary)
            .padding(.horizontal, 6).frame(height: 17)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder((tint ?? Color.secondary).opacity(0.4), lineWidth: 0.5))
    }
}

/// Profiles to act on: a list to tick, filtered, with the ones that cannot be chosen saying why.
private struct AddonTargets: View {
    let profiles: [AgentProfile]
    let blocked: Set<String>
    var notes: [String: String] = [:]
    @Binding var targets: Set<String>
    let preselection: Set<String>
    @State private var filter = ""

    var body: some View {
        let shown = profiles.filter { filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter) }
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(targets.count) \(targets.count == 1 ? "Profile" : "Profiles")").font(.callout).foregroundStyle(.secondary)
                Spacer()
                TextField("Filter", text: $filter).textFieldStyle(.roundedBorder).controlSize(.small).frame(width: 130)
                Button("Selection") { targets = preselection.subtracting(blocked) }
                Button("Isolated") { targets = Set(shown.filter { $0.isolated == true }.map(\.id)).subtracting(blocked) }
                Button("All") { targets = Set(shown.map(\.id)).subtracting(blocked) }
                Button("None") { targets = [] }
            }
            .controlSize(.small).buttonStyle(.link)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, profile in
                        if index > 0 { Divider() }
                        let off = blocked.contains(profile.id)
                        Toggle(isOn: Binding(get: { targets.contains(profile.id) }, set: { if $0 { targets.insert(profile.id) } else { targets.remove(profile.id) } })) {
                            HStack(spacing: 8) {
                                AddonDot(profile: profile)
                                Text(profile.name).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text(notes[profile.id] ?? (off ? "Follows Default" : "")).font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.checkbox).disabled(off).padding(.horizontal, 10).frame(height: 28)
                    }
                }
            }
            .frame(height: 210)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        }
    }
}

/// `Install MCP…`: the agent's own command, and the profiles to run it under.
struct AddonInstallSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let agent: ProfileAgent
    let profiles: [AgentProfile]
    let data: ProfileAddons?
    let preselected: Set<String>
    let done: ([AddonResult]) -> Void
    @State private var command = ""
    @State private var targets: Set<String> = []
    @State private var busy = false
    @State private var problem: String?
    @State private var results: [AddonResult]?

    /// Codex's profiles that are not isolated run on `Default`'s config: the server is installed there.
    private var blocked: Set<String> {
        Set(profiles.filter { p in !p.isDefault && (agent.isCodex ? p.isolated != true : false) }.map(\.id))
    }

    private var notes: [String: String] {
        guard let results else { return [:] }
        return Dictionary(uniqueKeysWithValues: results.map { ($0.profile, $0.ok ? "✓ Installed" : $0.said) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Install MCP · \(agent.title)").font(.headline)
            TextField(AddonWords.example(agent.id), text: $command, axis: .vertical)
                .font(.system(size: 12, design: .monospaced)).lineLimit(2...4).textFieldStyle(.roundedBorder).disabled(busy || results != nil)
            AddonTargets(profiles: profiles, blocked: blocked, notes: notes, targets: $targets, preselection: preselected)
                .disabled(busy || results != nil)
            if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                if results != nil {
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                } else {
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                    Button(busy ? "Installing…" : "Install in \(targets.count) \(targets.count == 1 ? "Profile" : "Profiles")", action: install)
                        .keyboardShortcut(.defaultAction).disabled(busy || targets.isEmpty || command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .padding(20).frame(width: 580)
        .onAppear { targets = preselected.subtracting(blocked) }
    }

    private func install() {
        busy = true
        problem = nil
        let client = model.client, order = profiles.map(\.id).filter(targets.contains)
        Task {
            do {
                let got = try await client.installMCP(agent: agent.id, command: command.trimmingCharacters(in: .whitespacesAndNewlines), profiles: order)
                results = got
                done(got)
            } catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
            busy = false
        }
    }
}

/// The profiles to copy something into.
struct AddonTargetsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let confirm: String
    let profiles: [AgentProfile]
    let blocked: Set<String>
    let action: ([String]) -> Void
    @State private var targets: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            AddonTargets(profiles: profiles, blocked: blocked, targets: $targets, preselection: [])
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("\(confirm) to \(targets.count) \(targets.count == 1 ? "Profile" : "Profiles")") {
                    action(profiles.map(\.id).filter(targets.contains))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(targets.isEmpty)
            }
        }
        .padding(20).frame(width: 520)
    }
}
