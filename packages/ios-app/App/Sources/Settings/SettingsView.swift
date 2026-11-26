import AgentSwitchKit
import SwiftUI

/// Where 设置 can lead by value: the Mac's details, the Mac's coding sessions and one of them. The demo
/// screens open straight onto them (`-uiDemoScreen mac|sessions|transcript`).
enum SettingsRoute: Hashable {
    case mac, sessions
    case session(SessionSummary)
    /// Proxies: the Clash page, and a proxy's form (the shared browser's or a profile's).
    case clash
    case proxy(ProxyTarget)
}

/// The Settings tab (app-v0 §5, docs/ui-v0.md): the Mac and its connection on top; the look (Appearance, docs/ui-v0.md
/// §8); the proxies (Clash, the browser's, each profile's; docs/clash-v0.md §9); sounds and reading; the Mac app's new
/// version; the Face ID lock; re-pairing. Rows carry no icons; no footer explains a row (docs/design-rules.md §5.2),
/// only what reports a state or a problem. Pull to refresh re-reads the
/// proxies.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock
    @State private var confirmForget = false
    @State private var addingMac = false
    @State private var path: [SettingsRoute] = SettingsView.initialPath
    /// What the Mac has of proxies; read again when coming back from one of their pages.
    @State private var proxies = ProxiesOverview()

    private static var initialPath: [SettingsRoute] {
        #if DEBUG
        return DemoData.settingsPath(UserDefaults.standard.string(forKey: "uiDemoScreen"))
        #else
        return []
        #endif
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollViewReader { reader in
            Form {
                if let current = model.profile {
                    Section {
                        NavigationLink(value: SettingsRoute.mac) { MacHeader() }
                        ForEach(model.macs.servers.filter { $0.fingerprint != current.fingerprint }, id: \.fingerprint) { mac in
                            Button { model.switchTo(mac.fingerprint) } label: {
                                LabeledContent(mac.name) { Text("Switch").mono(13).foregroundStyle(.secondary) }
                            }
                            .foregroundStyle(.primary)
                        }
                        Button("Add Mac") { addingMac = true }
                    }
                }
                AppearanceSection()
                if connected, !proxies.isEmpty { ProxiesSection(overview: proxies).id("proxies") }
                FeedbackSection()
                if connected { MacAppSection() }
                Section {
                    Toggle("Unlock with \(lock.biometryName)", isOn: Binding(get: { lock.enabled },
                                                                        set: { on in Task { await lock.setEnabled(on) } }))
                    if let error = lock.lastError { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                } header: {
                    SectionLabel("Security")
                }
                Section {
                    Button("Remove This Mac", role: .destructive) { confirmForget = true }
                }
            }
            #if DEBUG
            .onChange(of: proxies) {
                if UserDefaults.standard.string(forKey: "uiDemoScreen") == "proxies" { reader.scrollTo("proxies", anchor: .center) }
            }
            #endif
            }
            .tint(.accentColor)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: SettingsRoute.self) { route in destination(route) }
            .confirmationDialog("移除「\(model.profile?.name ?? "Mac")」？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { model.forget() }
            } message: {
                Text(model.macs.servers.count > 1 ? "将切换到其他已配对的 Mac。" : "之后需要重新扫码配对。")
            }
            .sheet(isPresented: $addingMac) { AddMacSheet() }
            .task(id: connected) { await loadProxies() }
            .refreshable { await loadProxies() }
            // Back from a proxy's page: what it changed is on its row.
            .onChange(of: path) { old, new in
                if new.isEmpty, !old.isEmpty { Task { await loadProxies() } }
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .mac:
            if let profile = model.profile { MacDetailsView(profile: profile) }
        case .sessions: SessionsView()
        case .session(let session): SessionTranscriptView(session: session)
        case .clash: ClashScreen()
        case .proxy(let target): ProxyFormView(target: target)
        }
    }

    private func loadProxies() async {
        guard let api = model.api else {
            #if DEBUG
            proxies = DemoData.proxies
            #endif
            return
        }
        guard connected else { return }
        proxies = await ProxiesOverview.load(api, keeping: proxies)
    }

    private var connected: Bool {
        if case .connected = model.connection { return true }
        return false
    }
}

/// Appearance (docs/ui-v0.md §8, 2026-10-04): `Pixel`, the look of §7 and the default, or `Classic`, a standard app's.
/// Kept on this iPhone (the Mac keeps its own; the user: 设置各记各的) and in force at once: the root draws everything
/// again in the look chosen (Look.swift), this sheet staying open.
private struct AppearanceSection: View {
    @AppStorage(InterfaceLook.key) private var raw = InterfaceLook.pixel.rawValue
    @AppStorage(RecordTextSize.key) private var textStep = 0
    @Environment(AppModel.self) private var model

    var body: some View {
        Section {
            Picker("Appearance", selection: $raw) {
                ForEach(InterfaceLook.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
            }
            .pickerStyle(.segmented)
            // The Live Activity showing now is drawn again in the look chosen.
            .onChange(of: raw) { model.syncLive() }
            // The conversation's text (2026-10-08, user: 手机上没有调整字体大小的地方).
            Stepper(value: $textStep, in: RecordTextSize.steps) {
                LabeledContent("Text Size", value: textStep == 0 ? "Default" : (textStep > 0 ? "+\(textStep)" : "\(textStep)"))
            }
        } header: {
            SectionLabel("Appearance")
        }
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
            Toggle("Sound", isOn: $settings.sound)
            Toggle("Haptics", isOn: $settings.haptics)
            Toggle("Sound in Silent Mode", isOn: $settings.audibleInSilent).disabled(!settings.sound)
            Toggle("Read Aloud", isOn: $settings.voiceMode)
            NavigationLink("Voice") { SpeechVoiceView() }
            Toggle("Live Activity", isOn: Binding(get: { liveOn }, set: { on in
                liveOn = on
                model.live.enabled = on
                if on { model.syncLive() }
            }))
            if liveOn && !model.live.allowed {
                Text("已在系统设置中关闭：设置 › AgentSwitch › 实时活动").font(.footnote).foregroundStyle(Theme.waiting)
            }
        } header: {
            SectionLabel("Alerts & Voice")
        }
        .onAppear { liveOn = model.live.enabled }
    }
}
