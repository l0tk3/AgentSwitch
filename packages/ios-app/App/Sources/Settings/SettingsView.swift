import AgentSwitchKit
import SwiftUI

/// Where 设置 can lead by value: the Mac's details, the task log, the Mac's coding sessions and one of them. The demo
/// screens open straight onto them (`-uiDemoScreen mac|tasks|search|sessions|transcript`).
enum SettingsRoute: Hashable {
    case mac, tasks, sessions
    case session(SessionSummary)
}

/// Everything behind the gear (app-v0 §5, docs/ui-v0.md): the Mac and its connection on top, then the executors' usage
/// (§4.2); what every task reads (CONTEXT.md, ciphertexts); sounds and reading; the Mac app's new version; the
/// threads, the task log, the Mac's coding sessions and the models (delete and read only); the permission mode
/// (changed on the Mac); the Face ID lock; re-pairing. Rows carry no icons (the usage rows' tiles are content, not
/// row icons); footers are one sentence. Pull to refresh re-reads the usage.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false
    @State private var addingMac = false
    @State private var path: [SettingsRoute] = SettingsView.initialPath
    @State private var policy: ApprovalPolicyInfo?

    private static var initialPath: [SettingsRoute] {
        #if DEBUG
        return DemoData.settingsPath(UserDefaults.standard.string(forKey: "uiDemoScreen"))
        #else
        return []
        #endif
    }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                if let current = model.profile {
                    Section {
                        NavigationLink(value: SettingsRoute.mac) { MacHeader() }
                        ForEach(model.macs.servers.filter { $0.fingerprint != current.fingerprint }, id: \.fingerprint) { mac in
                            Button { model.switchTo(mac.fingerprint) } label: {
                                LabeledContent(mac.name) { Text("切换").foregroundStyle(.secondary) }
                            }
                            .foregroundStyle(.primary)
                        }
                        Button("添加 Mac") { addingMac = true }
                    } footer: {
                        if model.macs.servers.count > 1 { Text("同一时间只连接一台 Mac。") }
                    }
                    if let quota = model.quota { UsageSection(readings: quota) }
                }
                Section {
                    NavigationLink("环境说明") { ContextEditorView() }
                    NavigationLink("密文") { CiphertextsView() }
                } header: {
                    Text("任务")
                } footer: {
                    Text("环境说明记录站点、账号和偏好，供每个任务参考。")
                }
                .disabled(!connected)
                FeedbackSection()
                if connected { MacAppSection() }
                Section {
                    NavigationLink("会话") { ThreadsManageView() }
                    NavigationLink("任务记录", value: SettingsRoute.tasks)
                    NavigationLink("编码会话", value: SettingsRoute.sessions)
                    NavigationLink("模型") { ModelsView() }
                } header: {
                    Text("管理")
                } footer: {
                    Text("编码会话是 Mac 上 Claude Code、Codex 和 OpenCode 的会话，仅供查看。")
                }
                .disabled(!connected)
                if let policy {
                    Section {
                        LabeledContent("权限", value: policy.policy.mode.label)
                    } footer: {
                        Text(policy.policy.mode.explanation + "。在 Mac 上修改。")
                    }
                }
                Section {
                    Toggle("用 \(lock.biometryName) 解锁", isOn: Binding(get: { lock.enabled },
                                                                        set: { on in Task { await lock.setEnabled(on) } }))
                    if let error = lock.lastError { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                } header: {
                    Text("安全")
                } footer: {
                    Text("设备丢失时，可在 Mac 上移除此设备。")
                }
                Section {
                    Button("移除此 Mac", role: .destructive) { confirmForget = true }
                } footer: {
                    Text("删除此 iPhone 与这台 Mac 的配对，已保存的密文不受影响。")
                }
            }
            .tint(.accentColor)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            // Task pages opened from 任务记录 link on to other tasks (a hand-off) by id.
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .navigationDestination(for: SettingsRoute.self) { route in destination(route) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .confirmationDialog("移除「\(model.profile?.name ?? "Mac")」？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("移除", role: .destructive) { model.forget() }
            } message: {
                Text(model.macs.servers.count > 1 ? "将切换到其他已配对的 Mac。" : "之后需要重新扫码配对。")
            }
            .sheet(isPresented: $addingMac) { AddMacSheet() }
            .task(id: connected) {
                async let usage: Void = model.refreshQuota()
                await loadPolicy()
                await usage
            }
            .refreshable {
                async let usage: Void = model.refreshQuota(force: true)
                await loadPolicy()
                await usage
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .mac:
            if let profile = model.profile { MacDetailsView(profile: profile) }
        case .tasks: TasksManageView()
        case .sessions: SessionsView()
        case .session(let session): SessionTranscriptView(session: session)
        }
    }

    /// The permission mode, read-only here (control-v0 §1); a Mac without the route shows no row.
    private func loadPolicy() async {
        guard let api = model.api else {
            #if DEBUG
            policy = DemoData.policy
            #endif
            return
        }
        guard connected else { return }
        policy = try? await api.approvalPolicy()
    }

    private var connected: Bool {
        if case .connected = model.connection { return true }
        return false
    }
}

/// The paired Mac on top of 设置: its name and how it is reached right now, in the connection line's words.
private struct MacHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Theme.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(model.profile?.name ?? "Mac").font(.headline)
                HStack(spacing: 5) {
                    Circle().fill(color).frame(width: 7, height: 7)
                    Text(model.connectionPhase.text).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, Theme.Space.xs)
    }

    private var color: Color {
        switch model.connectionPhase {
        case .connected: return Theme.done
        case .connecting, .reconnecting: return .secondary
        case .failing, .lost: return Theme.waiting
        case .unpaired, .certificateChanged: return Theme.failed
        }
    }
}

/// 提示与朗读 (assistant-v0 §3, §4): sounds, haptics, sounding with the silent switch on, reading replies aloud, the
/// reading voice, and the Live Activity on the lock screen and in the Dynamic Island.
private struct FeedbackSection: View {
    @Environment(AppModel.self) private var model
    @State private var liveOn = true

    var body: some View {
        @Bindable var settings = model.feedback.settings
        Section {
            Toggle("提示音", isOn: $settings.sound)
            Toggle("振动", isOn: $settings.haptics)
            Toggle("静音模式下播放", isOn: $settings.audibleInSilent).disabled(!settings.sound)
            Toggle("自动朗读", isOn: $settings.voiceMode)
            NavigationLink("朗读声音") { SpeechVoiceView() }
            Toggle("实时活动", isOn: Binding(get: { liveOn }, set: { on in
                liveOn = on
                model.live.enabled = on
                if on { model.syncLive() }
            }))
            if liveOn && !model.live.allowed {
                Text("已在系统设置中关闭：设置 › AgentSwitch › 实时活动").font(.footnote).foregroundStyle(Theme.waiting)
            }
        } header: {
            Text("提示与朗读")
        } footer: {
            Text("自动朗读用于朗读回复和任务通知；实时活动显示在锁定屏幕和灵动岛上。")
        }
        .onAppear { liveOn = model.live.enabled }
    }
}
