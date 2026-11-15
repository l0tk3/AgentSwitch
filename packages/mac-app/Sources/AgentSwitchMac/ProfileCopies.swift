import AgentSwitchMacCore
import SwiftUI

// What a Claude Code profile of its own takes from `Default` (docs/profiles-v0.md §3.8): one list, ticked by kind or
// by item, in the new-profile sheet and — for a profile that exists — in `Copies…`.

/// The list: a line per kind (`▸ [–] Skills  2 of 8`), its items under it when opened, then the three that are one
/// thing each. Everything starts at the same left edge; a kind `Default` has nothing of is said and cannot be ticked.
struct ProfileCopyChoices: View {
    /// What `Default` has.
    let options: ClaudeProfileCopyOptions
    /// What the profile holds already (nil: a new one). What it holds that `Default` has not is listed too, so it can
    /// be given up.
    var held: ClaudeProfileCopyOptions? = nil
    @Binding var selection: ClaudeProfileCopies
    @State private var opened: Set<String>

    /// `open`: the kinds shown opened at first (the design preview's).
    init(options: ClaudeProfileCopyOptions, held: ClaudeProfileCopyOptions? = nil, selection: Binding<ClaudeProfileCopies>, open: Set<String> = []) {
        self.options = options
        self.held = held
        _selection = selection
        _opened = State(initialValue: open)
    }

    private struct Kind: Identifiable {
        let title: String
        let list: WritableKeyPath<ClaudeProfileCopies, [String]>
        let names: [String]
        let offered: Set<String>
        var id: String { title }
    }
    private struct Item { let on: Binding<Bool> }

    private static let row: CGFloat = 24

    private var kinds: [Kind] {
        let all: [(String, WritableKeyPath<ClaudeProfileCopies, [String]>, KeyPath<ClaudeProfileCopyOptions, [String]>)] = [
            ("Skills", \.skills, \.skills), ("Plugins", \.plugins, \.plugins), ("MCP Servers", \.mcpServers, \.mcpServers),
            ("Commands", \.commands, \.commands), ("Agents", \.agents, \.agents),
        ]
        return all.map { title, list, from in
            let offered = options[keyPath: from], own = (held?[keyPath: from] ?? []).filter { !offered.contains($0) }
            return Kind(title: title, list: list, names: offered + own, offered: Set(offered))
        }
    }

    var body: some View {
        let kinds = kinds
        let rows = kinds.reduce(3) { $0 + 1 + (opened.contains($1.id) ? $1.names.count : 0) }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(kinds) { kind in
                    line(kind)
                    if opened.contains(kind.id) { ForEach(kind.names, id: \.self) { item(kind, $0) } }
                }
                flag("Instructions", note: "CLAUDE.md", \.instructions, offered: options.instructions, held: held?.instructions,
                     help: "Default 的全局指令，只读的一份。")
                flag("Preferences", note: "Model, Effort, Language, Theme", \.preferences, offered: options.preferences, held: held?.preferences,
                     help: "模型、思考强度、语言、输出风格与主题。环境变量、登录信息和 hooks 不在其中。")
                flag("Status Line", note: "statusLine", \.statusLine, offered: options.statusLine, held: held?.statusLine,
                     help: "状态栏的命令原样复制。它由某个插件提供时（例如 claude-hud），需同时勾选那个插件。")
            }
            .toggleStyle(.checkbox)
            .padding(.vertical, 6).padding(.horizontal, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: min(CGFloat(rows) * Self.row + 12, 252))
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
    }

    private func binding(_ kind: Kind, _ name: String) -> Binding<Bool> {
        Binding(get: { selection[keyPath: kind.list].contains(name) }, set: { on in
            var names = selection[keyPath: kind.list].filter { $0 != name }
            if on { names.append(name) }
            selection[keyPath: kind.list] = names
        })
    }

    /// `▸ [–] Skills                2 of 8`: all of a kind at once (mixed while only some are ticked), opened for each.
    private func line(_ kind: Kind) -> some View {
        let open = opened.contains(kind.id), count = selection[keyPath: kind.list].filter { kind.names.contains($0) }.count
        return HStack(spacing: 6) {
            Button { if open { opened.remove(kind.id) } else { opened.insert(kind.id) } } label: {
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
                    .foregroundStyle(kind.names.isEmpty ? .quaternary : .secondary).frame(width: 14, height: Self.row).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(kind.names.isEmpty)
            .accessibilityLabel(open ? "Collapse \(kind.title)" : "Expand \(kind.title)")
            // Nothing of this kind: an empty box (a toggle over no sources reads as ticked).
            if kind.names.isEmpty { Toggle(kind.title, isOn: .constant(false)).disabled(true) }
            else { Toggle(sources: kind.names.map { Item(on: binding(kind, $0)) }, isOn: \.on) { Text(kind.title) } }
            Spacer(minLength: 8)
            Text(kind.names.isEmpty ? "None" : "\(count) of \(kind.names.count)").font(.callout).monospacedDigit().foregroundStyle(kind.names.isEmpty ? .tertiary : .secondary)
        }
        .frame(height: Self.row)
    }

    private func item(_ kind: Kind, _ name: String) -> some View {
        // A plugin is read as its name; where it came from stands to the right.
        let plugin = kind.list == \ClaudeProfileCopies.plugins ? PluginKey.parts(name) : nil
        return HStack(spacing: 6) {
            Toggle(isOn: binding(kind, name)) { Text(verbatim: plugin?.name ?? name).lineLimit(1).truncationMode(.middle) }
            Spacer(minLength: 8)
            if !kind.offered.contains(name) {
                Text("Not in Default").font(.callout).foregroundStyle(.tertiary).help("这一项只在这个配置里有。取消勾选后会被删除，之后不能从 Default 复制回来。")
            } else if let market = plugin?.market {
                Text(verbatim: market).font(.callout).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.leading, 40)
        .frame(height: Self.row)
    }

    private func flag(_ title: String, note: String, _ flag: WritableKeyPath<ClaudeProfileCopies, Bool>, offered: Bool, held: Bool?, help: String) -> some View {
        // Something the profile holds can be given up even when `Default` has none of it any more.
        let usable = offered || held == true
        return HStack(spacing: 6) {
            Color.clear.frame(width: 14, height: Self.row)
            Toggle(title, isOn: Binding(get: { selection[keyPath: flag] }, set: { selection[keyPath: flag] = $0 })).disabled(!usable)
            Spacer(minLength: 8)
            Text(usable ? note : "None").font(.callout).foregroundStyle(.tertiary).lineLimit(1)
        }
        .frame(height: Self.row)
        .help(help)
    }
}

/// Said under the list while an MCP server is ticked: its whole entry goes along.
struct ProfileCopyMCPNote: View {
    var body: some View {
        Text("所选 MCP 服务的完整配置会一并复制，其中可能包含该服务的凭据。").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

/// `Copies…` of a profile that exists (2026-11-15, user: profile新建完成后应该也可以选择这些选项才行，加一个编辑选项):
/// the same list, ticked as the profile holds; saving copies what was ticked from `Default` as it is now and removes
/// what was unticked from the profile.
struct ProfileCopiesSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.profileNodeID) private var profileNodeID
    @Environment(\.dismiss) private var dismiss
    let profile: AgentProfile
    @State private var state: ClaudeProfileCopyState?
    @State private var selection = ClaudeProfileCopies()
    @State private var problem: String?
    @State private var busy = false

    private var change: (add: ClaudeProfileCopies, remove: ClaudeProfileCopies)? { state.map { selection.change(from: $0.held.all) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(profile.name) · Copies").font(.headline)
            if let state {
                ProfileCopyChoices(options: state.options, held: state.held, selection: $selection)
                if let change, !change.add.mcpServers.isEmpty { ProfileCopyMCPNote() }
            } else if problem == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 80)
            }
            Text("新勾选的内容按 Default 现在的样子复制一份；取消勾选的从这个配置里删除，Default 不受影响。对之后在它名下新开的终端生效。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if state == nil, problem != nil { Button("Retry") { Task { await load() } }.disabled(busy) }
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save", action: save).keyboardShortcut(.defaultAction)
                    .disabled(busy || change.map { $0.add.isEmpty && $0.remove.isEmpty } ?? true)
            }
        }
        .padding(20)
        .frame(width: 540)
        .task { await load() }
    }

    private func load() async {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            let got = try await model.client(on: profileNodeID).claudeProfileCopies(id: profile.id)
            state = got
            selection = got.held.all
        } catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
    }

    private func save() {
        guard let change else { return }
        let client = model.client(on: profileNodeID), id = profile.id
        busy = true
        problem = nil
        Task {
            do {
                _ = try await client.changeClaudeProfileCopies(id: id, add: change.add, remove: change.remove)
                dismiss()
            } catch {
                problem = (error as? DaemonError)?.reason ?? error.localizedDescription
                // Part of it may have been done: what the profile holds is read again.
                if let got = try? await client.claudeProfileCopies(id: id) { state = got; selection = got.held.all }
            }
            busy = false
        }
    }
}

#if DEBUG
/// The design preview's: the list as it stands in a sheet, some of it ticked, one kind opened.
struct ProfileCopiesDemo: View {
    @State private var selection: ClaudeProfileCopies = {
        var copies = ClaudeProfileCopies()
        copies.skills = ["docx", "pdf"]; copies.plugins = ["claude-hud@claude-hud", "codex@openai-codex", "old-tool@gone"]; copies.statusLine = true
        return copies
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("work · Copies").font(.headline)
            ProfileCopyChoices(options: ClaudeProfileCopyOptions(skills: ["docx", "humanizer", "pdf", "pptx", "xlsx"], mcpServers: ["browser", "figma"], commands: [], agents: ["planner", "reviewer"],
                                                                 plugins: ["claude-hud@claude-hud", "codex@openai-codex", "swift-lsp@claude-plugins-official"], instructions: true, preferences: true, statusLine: true),
                               held: ClaudeProfileCopyOptions(plugins: ["old-tool@gone"]), selection: $selection, open: ["Plugins"])
            Text("新勾选的内容按 Default 现在的样子复制一份；取消勾选的从这个配置里删除，Default 不受影响。对之后在它名下新开的终端生效。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack { Spacer(); Button("Cancel") {}; Button("Save") {}.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 540)
    }
}
#endif
