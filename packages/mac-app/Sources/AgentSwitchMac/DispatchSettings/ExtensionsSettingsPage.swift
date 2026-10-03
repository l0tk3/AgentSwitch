import AgentSwitchMacCore
import SwiftUI

/// Extensions (docs/dispatch-v0.md §3; demo `mac-window.html?set=ext`, the web's Extensions page): the MCP servers and
/// skills handed to the executors of the tasks Dispatch sends — switched on and off in the row, added and edited in a
/// sheet, deleted after a confirmation. They go into each run's private configuration; the user's own ~/.claude,
/// ~/.codex and OpenCode settings and the agents in Terminals are left alone.
struct ExtensionsSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @State private var servers: [DispatchMCPServer]?
    @State private var skills: [DispatchSkill]?
    @State private var loadProblem: String?
    @State private var problem: String?
    /// Rows being switched (the toggle waits for the daemon).
    @State private var switching: Set<String> = []
    @State private var editingServer: ServerSheetRequest?
    @State private var editingSkill: SkillSheetRequest?
    @State private var importing = false
    @State private var removing: ExtensionRemoval?

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    var body: some View {
        DispatchSettingsGate {
            if let servers, let skills {
                form(servers, skills)
            } else if let loadProblem {
                EmptyPage(title: "Extensions: Unavailable", symbol: "exclamationmark.triangle", message: loadProblem) {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload")
                    .disabled(!source.ready)
            }
        }
        .task(id: source.ready) {
            if source.ready { await load() }
        }
        .sheet(item: $editingServer) { request in
            MCPServerSheet(server: request.server, existing: Set((servers ?? []).map(\.name))) { Task { await load() } }
                .environment(model)
                .environment(\.dispatchSettings, dispatch)
        }
        .sheet(item: $editingSkill) { request in
            SkillSheet(name: request.name, existing: Set((skills ?? []).map(\.name))) { Task { await load() } }
                .environment(model)
                .environment(\.dispatchSettings, dispatch)
        }
        .sheet(isPresented: $importing) {
            SkillImportSheet { Task { await load() } }
                .environment(model)
                .environment(\.dispatchSettings, dispatch)
        }
        .confirmationDialog(removing?.question ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            presenting: removing) { removal in
            Button("Delete", role: .destructive) { Task { await remove(removal) } }
        } message: { removal in
            Text(removal.detail)
        }
    }

    private func form(_ servers: [DispatchMCPServer], _ skills: [DispatchSkill]) -> some View {
        Form {
            if let problem {
                Section { SettingsProblemLine(text: problem) }
            }
            Section {
                if servers.isEmpty { Text("No MCP Servers").foregroundStyle(.secondary) }
                ForEach(servers) { server in serverRow(server) }
            } header: {
                SectionLabel("MCP Servers")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Button("+ Add MCP Server…") { editingServer = ServerSheetRequest(server: nil) }
                    Footer("执行器可调用的工具服务。密钥仅填写 enc:v1: 密文，出网请求中的密文在网络层替换。凭据网关自带的 secret-gate 与 playwright 不在此管理。")
                }
            }
            Section {
                if skills.isEmpty { Text("No Skills").foregroundStyle(.secondary) }
                ForEach(skills) { skill in skillRow(skill) }
            } header: {
                SectionLabel("Skills")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Button("+ New Skill…") { editingSkill = SkillSheetRequest(name: nil) }
                        Button("Import…") { importing = true }
                    }
                    Footer("调度派出的任务运行时，以上服务与 skill 注入执行器的私有配置；不修改 ~/.claude、~/.codex 与 OpenCode 的配置，也不影响终端中的 agent。")
                }
            }
        }
        .formStyle(.grouped)
    }

    // MARK: rows

    private func serverRow(_ server: DispatchMCPServer) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { server.enabled }, set: { _ in Task { await toggle(server) } }))
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .disabled(switching.contains(server.name))
                .help(server.enabled ? "On" : "Off")
            Text(server.name).mono(12.5).lineLimit(1).frame(width: 136, alignment: .leading)
            Text(server.kind == "http" ? "HTTP" : "stdio").mono(12).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
            Text(server.approval == "allow" ? "Allowed" : "Ask").mono(12).frame(width: 56, alignment: .leading)
                .help("Claude Code 调用此服务的工具时" + (server.approval == "allow" ? "无需审批" : "需要审批"))
            Text("\(server.endpoint) · \(DispatchHarnessList.text(server.harnesses))")
                .mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(server.note.isEmpty ? server.endpoint : "\(server.endpoint)\n\(server.note)")
            Button("Edit…") { editingServer = ServerSheetRequest(server: server) }
        }
        .opacity(server.enabled ? 1 : 0.75)
        .contextMenu {
            Button("Edit…", systemImage: "pencil") { editingServer = ServerSheetRequest(server: server) }
            Button("Delete…", systemImage: "trash", role: .destructive) { removing = .server(server.name) }
        }
    }

    private func skillRow(_ skill: DispatchSkill) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { skill.enabled }, set: { _ in Task { await toggle(skill) } }))
                .toggleStyle(.switch)
                .controlSize(.small)
                .labelsHidden()
                .disabled(switching.contains("skill:" + skill.name))
                .help(skill.enabled ? "On" : "Off")
            Text(skill.name).mono(12.5).lineLimit(1).frame(width: 136, alignment: .leading)
            Text([skill.description.isEmpty ? "无描述" : skill.description, DispatchHarnessList.text(skill.harnesses)].joined(separator: " · "))
                .mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(skill.files > 0 ? "\(skill.description)\n+\(skill.files) files" : skill.description)
            Button("Edit…") { editingSkill = SkillSheetRequest(name: skill.name) }
        }
        .opacity(skill.enabled ? 1 : 0.75)
        .contextMenu {
            Button("Edit…", systemImage: "pencil") { editingSkill = SkillSheetRequest(name: skill.name) }
            Button("Delete…", systemImage: "trash", role: .destructive) { removing = .skill(skill.name) }
        }
    }

    // MARK: calls

    private func load() async {
        do {
            async let mcp = source.service.mcpServers()
            async let registry = source.service.skills()
            (servers, skills) = try await (mcp, registry)
            loadProblem = nil
        } catch {
            loadProblem = DispatchSettingsProblem.text(error)
        }
    }

    /// The same server switched (the daemon takes the whole object back, as the web's toggle sends it).
    private func toggle(_ server: DispatchMCPServer) async {
        switching.insert(server.name)
        defer { switching.remove(server.name) }
        do {
            let saved = try await source.service.saveMCPServer(server.toggled())
            servers = servers?.map { $0.name == saved.name ? saved : $0 }
            problem = nil
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }

    private func toggle(_ skill: DispatchSkill) async {
        switching.insert("skill:" + skill.name)
        defer { switching.remove("skill:" + skill.name) }
        do {
            let saved = try await source.service.saveSkill(name: skill.name, DispatchSkillUpdate(enabled: !skill.enabled))
            skills = skills?.map { $0.name == saved.name ? saved : $0 }
            problem = nil
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }

    private func remove(_ removal: ExtensionRemoval) async {
        do {
            switch removal {
            case .server(let name): try await source.service.deleteMCPServer(name: name)
            case .skill(let name): try await source.service.deleteSkill(name: name)
            }
            problem = nil
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
        await load()
    }
}

/// Which sheet: a new server (nil) or one to edit.
private struct ServerSheetRequest: Identifiable {
    let server: DispatchMCPServer?
    var id: String { server?.name ?? "+new" }
}

private struct SkillSheetRequest: Identifiable {
    let name: String?
    var id: String { name ?? "+new" }
}

/// A delete from a row's menu, asked first.
enum ExtensionRemoval: Equatable {
    case server(String)
    case skill(String)

    var question: String {
        switch self {
        case .server(let name): return "删除 MCP 服务 \(name)？"
        case .skill(let name): return "删除 skill \(name)？"
        }
    }

    var detail: String {
        switch self {
        case .server: return "之后的任务不再使用此服务，配置无法恢复。"
        case .skill: return "skill 的文件夹将一并删除，之后的任务不再使用此 skill，且无法恢复。"
        }
    }
}
