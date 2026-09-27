import AgentSwitchKit
import SwiftUI

/// 设置 › 模型: `GET /targets`, read-only — the scheduling model and its default, then each executor's models. Usage
/// is on the settings root (用量, docs/ui-v0.md §4.2), not here.
struct ModelsView: View {
    @Environment(AppModel.self) private var model
    @State private var targets: Targets?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { ErrorText(message: $error).id(error) } }
            if let targets {
                if let router = targets.router {
                    Section {
                        LabeledContent("模型", value: ModelName.display(router.model))
                        if let fallback = router.defaultTarget { LabeledContent("默认模型", value: fallback.displayName) }
                    } header: {
                        Text("调度")
                    } footer: {
                        Text("调度模型根据消息内容选择执行的模型；无法判断时交由默认模型执行。")
                    }
                }
                ForEach(targets.harnesses.keys.sorted(), id: \.self) { name in
                    if let spec = targets.harnesses[name] { HarnessSection(name: name, spec: spec) }
                }
            }
        }
        .navigationTitle("模型")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            targets = try await api.targets()
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

private struct HarnessSection: View {
    let name: String
    let spec: HarnessSpec

    var body: some View {
        Section(ModelName.harness(name)) {
            ForEach(spec.models.keys.sorted(), id: \.self) { id in
                let m = spec.models[id]
                HStack {
                    Text(ModelName.display(id))
                    if id == spec.defaultModel { Text("默认").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Text(m?.unavailable == true ? "不可用" : (m?.cost ?? "")).font(.caption).foregroundStyle(.secondary)
                }
            }
            LabeledContent("同时运行", value: "最多 \(spec.maxConcurrent) 个")
            LabeledContent("浏览器", value: spec.browser ? "支持" : "不支持")
        }
    }
}
