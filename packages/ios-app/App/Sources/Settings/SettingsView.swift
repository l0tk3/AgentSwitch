import AgentSwitchKit
import SwiftUI

/// Everything behind the gear (app-v0 §5): CONTEXT.md and ciphertexts; under 高级 the threads and task log (delete
/// only; filing stays automatic), executor targets and quota; then the paired Mac, the path in use, the Face ID lock
/// and re-pairing.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink { ContextEditorView() } label: { Label("环境说明（CONTEXT.md）", systemImage: "doc.text") }
                        .disabled(model.api == nil)
                    NavigationLink { CiphertextsView() } label: { Label("密文", systemImage: "lock.doc") }

                } footer: {
                    Text("环境说明告诉路由器你的站点、账号（密码放密文）和偏好，每个任务都会参考。")
                }
                FeedbackSection()
                Section {
                    NavigationLink { ThreadsManageView() } label: { Label("会话", systemImage: "bubble.left.and.bubble.right") }
                    NavigationLink { TasksManageView() } label: { Label("任务日志", systemImage: "list.bullet.rectangle") }
                    NavigationLink { TargetsQuotaView() } label: { Label("执行目标与额度", systemImage: "gauge.with.dots.needle.33percent") }
                } header: {
                    Text("高级")
                } footer: {
                    Text("会话由路由器自动管理：相关的任务归到同一个会话里续接。这里只用来删掉不想要的会话或单条日志，删除不可恢复。")
                }
                .disabled(model.api == nil)
                if model.api != nil { MacAppSection() }
                if let profile = model.profile { serverSection(profile) }
                connectionSection
                Section {
                    Toggle("用 \(lock.biometryName) 解锁", isOn: Binding(get: { lock.enabled },
                                                                        set: { on in Task { await lock.setEnabled(on) } }))
                    if let error = lock.lastError { Text(error).font(.footnote).foregroundStyle(.red) }
                } header: {
                    Text("安全")
                } footer: {
                    Text("手机丢了也可以在 Mac 上吊销这台设备的令牌。")
                }
                Section {
                    Button("重新配对", role: .destructive) { confirmForget = true }
                } footer: {
                    Text("删除这台 iPhone 上的令牌和服务器信息，回到扫码页。已保存的密文会保留。")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            // Task pages opened from 任务日志 link on to other tasks (a hand-off) by id.
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .confirmationDialog("忘记这台 Mac 并重新配对？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("忘记并重新配对", role: .destructive) { model.forget() }
            }
        }
    }

    private func serverSection(_ p: ServerProfile) -> some View {
        Section("Mac") {
            LabeledContent("名称", value: p.name)
            VStack(alignment: .leading, spacing: 4) {
                Text("证书指纹").font(.caption).foregroundStyle(.secondary)
                Text(ServerProfile.grouped(p.fingerprint)).font(.caption.monospaced()).textSelection(.enabled)
            }
            LabeledContent("端口", value: String(p.port))
            if !p.lan.isEmpty { LabeledContent("局域网", value: p.lan.joined(separator: ", ")) }
            if !p.tailnet.isEmpty { LabeledContent("Tailscale", value: p.tailnet.joined(separator: ", ")) }
            LabeledContent("gate 密钥对", value: p.gate?.keypair ?? "未取得")
            LabeledContent("本机设备", value: model.me?.name ?? p.deviceId)
            LabeledContent("配对于", value: p.pairedAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    private var connectionSection: some View {
        Section("连接") {
            switch model.connection {
            case .connected(let endpoint):
                LabeledContent("线路", value: endpoint.kind.title)
                LabeledContent("地址", value: endpoint.authority).font(.body.monospaced())
            case .idle, .selecting:
                HStack { Text("正在选择线路"); Spacer(); ProgressView() }
            case .unreachable:
                Text("所有地址都连不上").foregroundStyle(.orange)
            case .unauthorized:
                Text("令牌已失效，请重新配对").foregroundStyle(.red)
            case .pinMismatch(let seen):
                VStack(alignment: .leading) {
                    Text("有服务器用了不同的证书，已拒绝").foregroundStyle(.red)
                    if let seen { Text(ServerProfile.grouped(seen)).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                }
            }
            Button("重新选择线路") { model.reconnect() }
        }
    }
}

/// `GET /targets` and `GET /quota`, read-only.
struct TargetsQuotaView: View {
    @Environment(AppModel.self) private var model
    @State private var targets: Targets?
    @State private var quota: [QuotaReading] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error { Section { ErrorText(message: $error).id(error) } }
            Section("额度") {
                if quota.isEmpty { Text("暂无读数").foregroundStyle(.secondary) }
                ForEach(quota) { reading in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(reading.harness).font(.headline)
                            Spacer()
                            Text(reading.remaining.map { "剩 \(Int(($0 * 100).rounded()))%" } ?? "未知").foregroundStyle(.secondary)
                        }
                        if let remaining = reading.remaining { ProgressView(value: min(max(remaining, 0), 1)) }
                        Text("\(reading.source) · \(reading.fetched.relative)").font(.caption).foregroundStyle(.secondary)
                        if let err = reading.error { Text(err).font(.caption).foregroundStyle(.orange) }
                    }
                }
            }
            if let targets {
                if let router = targets.router {
                    Section("路由器") {
                        LabeledContent("模型", value: "\(router.harness)/\(router.model)")
                        if let d = router.defaultTarget { LabeledContent("默认执行", value: d.label) }
                    }
                }
                ForEach(targets.harnesses.keys.sorted(), id: \.self) { name in
                    if let spec = targets.harnesses[name] {
                        Section(name) {
                            ForEach(spec.models.keys.sorted(), id: \.self) { model in
                                let m = spec.models[model]
                                HStack {
                                    Text(model)
                                    if model == spec.defaultModel { Text("默认").font(.caption2).foregroundStyle(.blue) }
                                    Spacer()
                                    Text(m?.unavailable == true ? "不可用" : (m?.cost ?? "")).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            LabeledContent("并发上限", value: String(spec.maxConcurrent))
                            LabeledContent("浏览器", value: spec.browser ? "支持" : "不支持")
                        }
                    }
                }
            }
        }
        .navigationTitle("执行目标与额度")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("刷新额度") { Task { await load(refreshQuota: true) } }
            }
        }
        .task { await load(refreshQuota: false) }
        .refreshable { await load(refreshQuota: true) }
    }

    private func load(refreshQuota: Bool) async {
        guard let api = model.api else { return }
        do {
            async let t = api.targets()
            async let q = refreshQuota ? api.refreshQuota() : api.quota()
            (targets, quota) = try await (t, q)
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

/// 提示与朗读 (assistant-v0 §3, §4): sounds, haptics, sounding with the silent switch on, voice mode, the reading
/// voice, and the Live Activity on the lock screen and in the Dynamic Island.
private struct FeedbackSection: View {
    @Environment(AppModel.self) private var model
    @State private var liveOn = true

    var body: some View {
        @Bindable var settings = model.feedback.settings
        Section {
            Toggle("提示音", isOn: $settings.sound)
            Toggle("振动", isOn: $settings.haptics)
            Toggle("静音时也响", isOn: $settings.audibleInSilent).disabled(!settings.sound)
            Toggle("语音模式", isOn: $settings.voiceMode)
            NavigationLink { SpeechVoiceView() } label: { Label("朗读声音", systemImage: "speaker.wave.2") }
            Toggle("实时活动（锁屏与灵动岛）", isOn: Binding(get: { liveOn }, set: { on in
                liveOn = on
                model.live.enabled = on
                if on { model.syncLive() }
            }))
            if liveOn && !model.live.allowed {
                Text("iOS 里关掉了：到「设置 › AgentSwitch › 实时活动」打开。").font(.footnote).foregroundStyle(.orange)
            }
        } header: {
            Text("提示与朗读")
        } footer: {
            Text("发出、已接收、需要你、完成、失败各有提示音和振动。语音模式会念出助理的回复和它主动的汇报（任务结束、需要你回答、你让它盯着的进展），也会在静音时出声。应用没打开时暂时不会响（要等推送），打开后补上。实时活动在任务进行时出现在锁屏和灵动岛上，等你处理的排在最前；应用被系统挂起后停在最后的状态（计时照走），打开应用就更新。")
        }
        .onAppear { liveOn = model.live.enabled }
    }
}
