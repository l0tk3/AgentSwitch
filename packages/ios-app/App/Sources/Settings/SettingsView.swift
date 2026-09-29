import AgentSwitchKit
import SwiftUI

/// Where 设置 can lead by value: the Mac's details, the history, the Mac's coding sessions and one of them. The demo
/// screens open straight onto them (`-uiDemoScreen mac|tasks|search|sessions|transcript`).
enum SettingsRoute: Hashable {
    case mac, tasks, sessions
    case session(SessionSummary)
}

/// Everything behind the gear (app-v0 §5, docs/ui-v0.md): the Mac and its connection on top, then the executors' usage
/// (§4.2); what every task reads (CONTEXT.md, ciphertexts); sounds and reading; the Mac app's new version; the
/// history (every task; clear history deletes it all) and the models; the permission mode
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
    /// clear history: confirmed first (DeleteRequest), then done or why not.
    @State private var clearing: DeleteRequest?
    @State private var clearError: String?
    @State private var cleared = false

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
                                LabeledContent(mac.name) { Text("switch").mono(13).foregroundStyle(.secondary) }
                            }
                            .foregroundStyle(.primary)
                        }
                        Button("add Mac") { addingMac = true }
                    } footer: {
                        if model.macs.servers.count > 1 { Text("同一时间只连接一台 Mac。") }
                    }
                    if let quota = model.quota { UsageSection(readings: quota) }
                }
                Section {
                    NavigationLink("context") { ContextEditorView() }
                    NavigationLink("ciphertexts") { CiphertextsView() }
                } header: {
                    SectionLabel("tasks")
                } footer: {
                    Text("环境说明记录站点、账号和偏好，供每个任务参考。")
                }
                .disabled(!connected)
                FeedbackSection()
                if connected { MacAppSection() }
                Section {
                    NavigationLink("history", value: SettingsRoute.tasks)
                    NavigationLink("models") { ModelsView() }
                    Button("clear history", role: .destructive) { cleared = false; clearing = .history }
                    if let clearError { Text(clearError).font(.footnote).foregroundStyle(Theme.failed) }
                    if cleared { Text("记录已清空。").font(.footnote).foregroundStyle(.secondary) }
                } header: {
                    SectionLabel("manage")
                } footer: {
                    Text("Mac 上 Claude Code、Codex 和 OpenCode 的会话在 terminals 中，可查看和继续。")
                }
                .disabled(!connected)
                if let policy {
                    Section {
                        LabeledContent("permissions") { Text(policy.policy.mode.label).mono(13) }
                    } footer: {
                        Text(policy.policy.mode.explanation + "。在 Mac 上修改。")
                    }
                }
                Section {
                    Toggle("unlock with \(lock.biometryName)", isOn: Binding(get: { lock.enabled },
                                                                        set: { on in Task { await lock.setEnabled(on) } }))
                    if let error = lock.lastError { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                } header: {
                    SectionLabel("security")
                } footer: {
                    Text("设备丢失时，可在 Mac 上移除此设备。")
                }
                Section {
                    Button("remove this Mac", role: .destructive) { confirmForget = true }
                } footer: {
                    Text("删除此 iPhone 与这台 Mac 的配对，已保存的密文不受影响。")
                }
            }
            .tint(.accentColor)
            .navigationTitle("settings")
            .navigationBarTitleDisplayMode(.inline)
            // Task pages opened from 任务记录 link on to other tasks (a hand-off) by id.
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .navigationDestination(for: SettingsRoute.self) { route in destination(route) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("done") { dismiss() } } }
            .confirmationDialog("移除「\(model.profile?.name ?? "Mac")」？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("remove", role: .destructive) { model.forget() }
            } message: {
                Text(model.macs.servers.count > 1 ? "将切换到其他已配对的 Mac。" : "之后需要重新扫码配对。")
            }
            .sheet(isPresented: $addingMac) { AddMacSheet() }
            .deleteConfirmation($clearing, error: $clearError) { _ in cleared = true }
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
            // The app's mark, with depth (an identity mark of 20 pt and up): lit while connected, dithered while not.
            PixelMarkView(state: model.connection.endpoint == nil ? .off : .idle, pixel: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(model.profile?.name ?? "Mac").font(.headline)
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: color)
                    Text(model.connectionPhase.text).mono(12).foregroundStyle(.secondary)
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
            Toggle("sound", isOn: $settings.sound)
            Toggle("haptics", isOn: $settings.haptics)
            Toggle("sound in silent mode", isOn: $settings.audibleInSilent).disabled(!settings.sound)
            Toggle("read aloud", isOn: $settings.voiceMode)
            NavigationLink("voice") { SpeechVoiceView() }
            Toggle("live activity", isOn: Binding(get: { liveOn }, set: { on in
                liveOn = on
                model.live.enabled = on
                if on { model.syncLive() }
            }))
            if liveOn && !model.live.allowed {
                Text("已在系统设置中关闭：设置 › AgentSwitch › 实时活动").font(.footnote).foregroundStyle(Theme.waiting)
            }
        } header: {
            SectionLabel("alerts & voice")
        } footer: {
            Text("read aloud 开启时自动朗读回复和任务通知；live activity 显示在锁定屏幕和灵动岛上。")
        }
        .onAppear { liveOn = model.live.enabled }
    }
}
