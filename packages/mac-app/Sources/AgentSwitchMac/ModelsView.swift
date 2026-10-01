import AgentSwitchMacCore
import SwiftUI

/// 模型: usage on top (docs/ui-v0.md §4.2), then router model and default target via `GET|PUT /settings/models`; the
/// daemon applies them on restart. Pickers show model names (Opus 5.5) and save the ids.
struct ModelsView: View {
    @Environment(AppModel.self) private var model
    @State private var settings: ModelSettings?
    @State private var routerModel = ""
    @State private var harness = ""
    @State private var targetModel = ""
    @State private var problem: String?
    @State private var saved: String?
    @State private var busy = false

    var body: some View {
        Group {
            if !model.daemonReady {
                EmptyPage(title: "Service Not Ready", symbol: "hourglass", message: model.daemonLine.text)
            } else if let settings {
                form(settings)
            } else if let problem {
                EmptyPage(title: "Models: Unavailable", symbol: "exclamationmark.triangle", message: problem) {
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
                    .disabled(!model.daemonReady)
            }
        }
        .task(id: model.daemonReady) {
            await load()
            await model.refreshUsage()
        }
    }

    private func form(_ s: ModelSettings) -> some View {
        let changes = ModelSettingsUpdate.diff(current: s, routerModel: routerModel, defaultHarness: harness, defaultModel: targetModel)
        return Form {
            UsageSection()
            Section {
                Picker("Dispatch Model", selection: $routerModel) {
                    ForEach(options(s.router.options, current: s.router.model), id: \.self) { Text(ModelName.display($0)).tag($0) }
                }
            } header: {
                SectionLabel("Dispatch")
            } footer: {
                Footer("根据消息内容选择执行器和模型。")
            }
            Section {
                Picker("Executor", selection: $harness) {
                    ForEach(s.harnessNames, id: \.self) { Text(HarnessName.display($0)).tag($0) }
                }
                Picker("Model", selection: $targetModel) {
                    ForEach(options(s.models(for: harness), current: targetModel), id: \.self) { Text(ModelName.display($0)).tag($0) }
                }
            } header: {
                SectionLabel("Default")
            } footer: {
                Footer("调度模型无法判断、所选模型均不可用或调度出错时，任务交由此模型执行。")
            }
            Section {
            } footer: {
                HStack(alignment: .center, spacing: 8) {
                    status(s, unsaved: !changes.isEmpty)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if busy { ProgressView().controlSize(.small) }
                    Button("Save & Restart") { Task { await save(s) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || changes.isEmpty)
                        .help("保存到 \(model.shortPath(model.paths.modelsOverride))，覆盖 targets.yaml 中的对应设置")
                }
            }
        }
        .formStyle(.grouped)
        .onChange(of: harness) { _, next in
            let models = s.models(for: next)
            if !models.contains(targetModel) { targetModel = s.harnesses[next]?.defaultModel ?? models.first ?? "" }
        }
    }

    /// What the last save did, or whether saved settings still wait for a restart.
    @ViewBuilder
    private func status(_ s: ModelSettings, unsaved: Bool) -> some View {
        if let problem {
            Label(problem, systemImage: "xmark.circle.fill").foregroundStyle(.red).textSelection(.enabled)
        } else if let saved, !unsaved {
            Label(saved, systemImage: "checkmark.circle.fill").foregroundStyle(.secondary)
        } else if s.restartPending && !unsaved {
            HStack(spacing: 6) {
                StatusDot(level: .warning)
                Text("Saved · Applies After Restart").foregroundStyle(.secondary)
            }
        } else {
            Footer("保存后服务将重启，正在运行的任务将中断。")
        }
    }

    /// The list plus the current value when the catalog no longer has it, so the picker never shows blank.
    private func options(_ list: [String], current: String?) -> [String] {
        guard let current, !current.isEmpty, !list.contains(current) else { return list }
        return [current] + list
    }

    private func load() async {
        guard model.daemonReady else { return }
        do {
            let s = try await model.client.modelSettings()
            settings = s
            routerModel = s.router.model ?? s.router.options.first ?? ""
            harness = s.defaultTarget.harness ?? s.harnessNames.first ?? ""
            targetModel = s.defaultTarget.model ?? s.harnesses[harness]?.defaultModel ?? ""
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    private func save(_ s: ModelSettings) async {
        busy = true
        defer { busy = false }
        let update = ModelSettingsUpdate.diff(current: s, routerModel: routerModel, defaultHarness: harness, defaultModel: targetModel)
        do {
            let result = try await model.client.saveModelSettings(update)
            problem = nil
            if result.restartRequired {
                saved = "Saved · Restarting"
                model.restartDaemon()
            } else {
                saved = "Saved"
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// 模型 › 用量: the same rows as the menu panel, roomier, with when they were read and 刷新 (every provider read now).
/// Hidden when the daemon has no readings (not running, or a build without `GET /quota`).
private struct UsageSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let rows = model.usageRows
        if !rows.isEmpty {
            Section {
                ForEach(rows) { UsageRowView(row: $0) }
            } header: {
                SectionLabel("Usage")
            } footer: {
                HStack(alignment: .center, spacing: 8) {
                    Footer(model.usageReadAt.map { "Read \(TimeText.at($0))" } ?? "No Reading")
                    if model.usageRefreshing { ProgressView().controlSize(.small) }
                    Button("Refresh") { Task { await model.refreshUsage(force: true) } }
                        .disabled(model.usageRefreshing)
                }
            }
        }
    }
}
