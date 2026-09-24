import AgentSwitchMacCore
import SwiftUI

/// 模型: router model and default target via `GET|PUT /settings/models`; the daemon applies them on restart.
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
                ContentUnavailableView("守护进程还没就绪", systemImage: "hourglass", description: Text(model.daemonLine.text))
            } else if let settings {
                form(settings)
            } else if let problem {
                ContentUnavailableView("读不到模型设置", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else {
                ProgressView()
            }
        }
        .task(id: model.daemonReady) { await load() }
    }

    private func form(_ s: ModelSettings) -> some View {
        Form {
            Section {
                Picker("路由模型", selection: $routerModel) {
                    ForEach(options(s.router.options, current: s.router.model), id: \.self) { Text($0).tag($0) }
                }
            } header: { Text("路由") } footer: {
                Text("路由器读你的任务，决定交给哪个执行器、哪个模型。").foregroundStyle(.secondary)
            }
            Section {
                Picker("执行器", selection: $harness) {
                    ForEach(s.harnessNames, id: \.self) { Text($0).tag($0) }
                }
                Picker("模型", selection: $targetModel) {
                    ForEach(options(s.models(for: harness), current: targetModel), id: \.self) { Text($0).tag($0) }
                }
            } header: { Text("默认执行目标") } footer: {
                Text("路由器拿不定主意时用它。").foregroundStyle(.secondary)
            }
            Section {
                HStack {
                    Button("保存并重启守护进程") { Task { await save(s) } }
                        .disabled(busy || ModelSettingsUpdate.diff(current: s, routerModel: routerModel, defaultHarness: harness, defaultModel: targetModel).isEmpty)
                    if busy { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("重新读取") { Task { await load() } }
                }
                if s.restartPending {
                    Label("已保存的设置还没生效：重启守护进程后生效。", systemImage: "info.circle").foregroundStyle(.orange)
                }
                if let saved { Label(saved, systemImage: "checkmark.circle").foregroundStyle(.green) }
                if let problem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                Text("重启会中断正在运行的任务。设置写在 \(model.paths.modelsOverride.path)，叠加在 targets.yaml 之上。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onChange(of: harness) { _, next in
            let models = s.models(for: next)
            if !models.contains(targetModel) { targetModel = s.harnesses[next]?.defaultModel ?? models.first ?? "" }
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
                saved = "已保存，正在重启守护进程…"
                model.restartDaemon()
            } else {
                saved = "已保存"
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}
