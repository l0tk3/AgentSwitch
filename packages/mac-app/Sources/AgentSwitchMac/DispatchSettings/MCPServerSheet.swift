import AgentSwitchMacCore
import SwiftUI

/// `+ Add MCP Server…` / `Edit…` (the web's MCP form): name, kind, what it runs or where it is, its variables or headers,
/// whether Claude Code asks before its tools are called, who gets it and the router's note. The daemon's rules are
/// checked as typed (DispatchMCPServerDraft) and Save stays off until they pass; credentials only as `enc:v1:`
/// ciphertexts. An existing server can be deleted here too.
struct MCPServerSheet: View {
    /// After a save or a delete: the page reads the list again.
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DispatchMCPServerDraft
    private let original: DispatchMCPServerDraft
    /// The servers there are: a new one may not take one of their names (`PUT` would replace that one).
    private let existing: Set<String>
    @State private var saving = false
    @State private var problem: String?
    @State private var confirmDelete = false

    init(server: DispatchMCPServer?, existing: Set<String>, done: @escaping () -> Void) {
        let draft = DispatchMCPServerDraft(server)
        _draft = State(initialValue: draft)
        original = draft
        self.existing = existing
        self.done = done
    }

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    static let size = CGSize(width: 540, height: 540)

    var body: some View {
        let problems = draft.problems(existing: existing)
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $draft.name, prompt: Text("github"))
                        .font(.system(size: 12.5, design: .monospaced))
                        .disabled(!draft.isNew)
                    Picker("Kind", selection: $draft.kind) {
                        Text("stdio").tag("stdio")
                        Text("HTTP").tag("http")
                    }
                    .pickerStyle(.radioGroup)
                    .horizontalRadioGroupLayout()
                } header: {
                    SectionLabel(draft.isNew ? "New MCP Server" : "MCP Server")
                } footer: {
                    Footer(draft.kind == "http" ? "远程服务，通过 URL 连接。" : "本地进程，由执行器启动，继承凭据网关的代理环境。")
                }
                if draft.kind == "http" { httpFields } else { stdioFields }
                Section {
                    Picker("Approval", selection: $draft.approval) {
                        Text("Ask").tag("ask")
                        Text("Allowed").tag("allow")
                    }
                    .pickerStyle(.radioGroup)
                    .horizontalRadioGroupLayout()
                    LabeledContent("Executors") { SettingsHarnessCheckboxes(selection: $draft.harnesses) }
                    TextField("Note", text: $draft.note, prompt: Text("可选：调度模型读到的一句说明"))
                } footer: {
                    Footer("Approval 仅对 Claude Code 生效：Ask 表示调用此服务的工具前需要审批。")
                }
                if draft != original && !problems.isEmpty {
                    Section {
                        ForEach(problems, id: \.self) { SettingsNoteLine(text: $0) }
                    }
                }
                if let problem {
                    Section { SettingsProblemLine(text: problem) }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack(spacing: 10) {
                if !draft.isNew {
                    SettingsDeleteButton("Delete…") { confirmDelete = true }
                        .disabled(saving)
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!problems.isEmpty || saving || (!draft.isNew && draft == original))
            }
            .padding(16)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .tint(.brand)
        .confirmationDialog("删除 MCP 服务 \(draft.name)？", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text(ExtensionRemoval.server(draft.name).detail)
        }
    }

    private var stdioFields: some View {
        Section {
            TextField("Command", text: $draft.command, prompt: Text("npx"))
                .font(.system(size: 12.5, design: .monospaced))
            StackedEditor(title: "Arguments", text: $draft.arguments, prompt: "-y\n@modelcontextprotocol/server-github")
            StackedEditor(title: "Environment", text: $draft.environment, prompt: "GITHUB_TOKEN=enc:v1:…")
        } footer: {
            Footer("参数与环境变量每行一个，环境变量的格式为 KEY=VALUE。" + Self.ciphertextRule)
        }
    }

    private var httpFields: some View {
        Section {
            TextField("URL", text: $draft.url, prompt: Text("https://mcp.example.com/sse"))
                .font(.system(size: 12.5, design: .monospaced))
            StackedEditor(title: "Headers", text: $draft.headers, prompt: "Authorization: Bearer enc:v1:…")
        } footer: {
            Footer("请求头每行一个，格式为 Key: Value。" + Self.ciphertextRule)
        }
    }

    /// Credentials only as ciphertexts (the gate's network layer swaps them on the way out).
    private static let ciphertextRule = "密钥仅填写 enc:v1: 密文，出网请求中的密文由凭据网关在网络层替换；名称含 TOKEN、KEY、SECRET、PASSWORD 等词的变量、请求头与参数，以及网址中的密码，值须为完整的密文。"

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            // A new server's name taken meanwhile (another window, the web console): not replaced.
            if draft.isNew, try await source.service.mcpServers().contains(where: { $0.name == draft.trimmedName }) {
                problem = DispatchMCPServerDraft.nameTaken
                return
            }
            _ = try await source.service.saveMCPServer(draft.server())
            done()
            dismiss()
        } catch {
            problem = "未保存：" + DispatchSettingsProblem.text(error)
        }
    }

    private func delete() async {
        saving = true
        defer { saving = false }
        do {
            try await source.service.deleteMCPServer(name: draft.name)
            done()
            dismiss()
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }
}

/// A label over a short editor across the row (one entry per line): the row is the editor's box.
private struct StackedEditor: View {
    let title: String
    @Binding var text: String
    let prompt: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
            SettingsTextEditor(text: $text, fontSize: 12)
                .frame(height: 50)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(prompt).mono(12).foregroundStyle(.tertiary).padding(.top, 4).padding(.leading, 5).allowsHitTesting(false)
                    }
                }
        }
    }
}
