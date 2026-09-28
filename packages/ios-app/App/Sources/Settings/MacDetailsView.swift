import AgentSwitchKit
import SwiftUI

/// 设置 › Mac: the connection in use and how the last route choice went, what to check when it fails (排障, control-v0
/// §5), then the details a person rarely needs (fingerprint, addresses, key pair, the default work folder).
struct MacDetailsView: View {
    let profile: ServerProfile
    @Environment(AppModel.self) private var model
    @State private var workdir: WorkdirSetting?

    var body: some View {
        ScrollViewReader { proxy in
            form.task { await demoScroll(proxy) }
        }
        .navigationTitle(profile.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection.endpoint) { await loadWorkdir() }
    }

    private var form: some View {
        Form {
            Section(label: "connection") {
                switch model.connection {
                case .connected(let endpoint):
                    LabeledContent("route", value: endpoint.kind.title)
                    LabeledContent("address") { Text(endpoint.authority).mono(13) }
                case .idle, .selecting:
                    HStack { Text(model.connectionPhase.text).mono(13); Spacer(); BrailleSpinner(color: .secondary) }
                case .unreachable:
                    Text(model.connectionPhase.text).foregroundStyle(Theme.waiting)
                case .unauthorized:
                    Text("配对已失效，请重新配对。").foregroundStyle(Theme.failed)
                case .pinMismatch(let seen):
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        Text("服务器证书与配对时不一致，已拒绝连接").foregroundStyle(Theme.failed)
                        if let seen { Text(ServerProfile.grouped(seen)).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                    }
                }
                Button("choose route again") { model.reconnect() }
            }
            if let report = model.routeReport {
                Section {
                    ForEach(Array(report.reports.enumerated()), id: \.offset) { _, probe in RouteProbeRow(probe: probe) }
                } header: {
                    SectionLabel("last route choice")
                } footer: {
                    Text("\(report.at.formatted(date: .omitted, time: .standard)) · 同时探测所有地址，按顺序选用第一个可用地址。")
                }
            }
            TroubleshootingSection(profile: profile)
            Section("Mac") {
                LabeledContent("name", value: profile.name)
                LabeledContent("port") { Text(String(profile.port)).mono(13) }
                if !profile.lan.isEmpty { LabeledContent("LAN") { Text(profile.lan.joined(separator: ", ")).mono(13) } }
                if !profile.tailnet.isEmpty { LabeledContent("Tailscale", value: profile.tailnet.joined(separator: ", ")) }
                LabeledContent("keypair") { Text(profile.gate?.keypair ?? "—").mono(13) }
                LabeledContent("this device", value: model.me?.name ?? profile.deviceId)
                LabeledContent("paired", value: profile.pairedAt.formatted(date: .abbreviated, time: .shortened))
            }
            if let workdir { WorkdirSection(workdir: workdir) }
            Section {
                Text(ServerProfile.grouped(profile.fingerprint)).font(.caption.monospaced()).textSelection(.enabled)
            } header: {
                SectionLabel("certificate fingerprint")
            } footer: {
                Text("与 Mac 上「配对」页显示的指纹一致，即为同一台 Mac。")
            }
        }
    }

    /// Debug builds with `-uiDemoScroll route`: the page opens scrolled down to the end of 常见原因 (opened), under
    /// 上次选择线路 and 排障, for screenshots.
    private func demoScroll(_ proxy: ScrollViewProxy) async {
        #if DEBUG
        guard UserDefaults.standard.string(forKey: "uiDemoScroll") == "route" else { return }
        try? await Task.sleep(for: .milliseconds(400))
        proxy.scrollTo("cause-\(Troubleshooting.causes.count - 1)", anchor: .bottom)
        #endif
    }

    /// Read-only here (control-v0 §2); a Mac without the route shows nothing.
    private func loadWorkdir() async {
        guard let api = model.api else {
            #if DEBUG
            workdir = DemoData.workdir
            #endif
            return
        }
        guard model.connection.endpoint != nil else { return }
        workdir = try? await api.workdir()
    }
}

/// Where a task works when nobody names a folder.
private struct WorkdirSection: View {
    let workdir: WorkdirSetting

    var body: some View {
        Section {
            LabeledContent("default folder") {
                Text(PathDisplay.short(workdir.path)).monospaced().lineLimit(1).truncationMode(.middle)
            }
            if let problem = workdir.problem {
                Text(problem).font(.footnote).foregroundStyle(Theme.waiting)
            }
        } footer: {
            Text("未指定目录的任务在此目录下各自新建子目录。在 Mac 上修改。")
        }
    }
}

/// 排障: each line of the last route choice as a check, then the usual reasons, most common first (open by default
/// while the Mac cannot be reached).
private struct TroubleshootingSection: View {
    let profile: ServerProfile
    @Environment(AppModel.self) private var model
    /// nil until the user opens or closes the reasons: until then they follow the connection.
    @State private var causesOpen: Bool? = TroubleshootingSection.demoOpen

    private static var demoOpen: Bool? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "uiDemoScroll") == "route" ? true : nil
        #else
        return nil
        #endif
    }

    var body: some View {
        Section {
            ForEach(Troubleshooting.checks(state: model.connection, reports: model.routeReport?.reports, book: profile)) { check in
                CheckRow(check: check)
            }
            DisclosureGroup("常见原因", isExpanded: Binding(get: { causesOpen ?? (model.connection.endpoint == nil) },
                                                           set: { causesOpen = $0 })) {
                ForEach(Array(Troubleshooting.causes.enumerated()), id: \.offset) { index, cause in
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                        Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
                        Text(cause)
                    }
                    .font(.subheadline)
                    .id("cause-\(index)")
                }
            }
        } header: {
            SectionLabel("troubleshooting")
        } footer: {
            Text("连接中断时会自动重试，无需停留在此页面。")
        }
    }
}

private struct CheckRow: View {
    let check: Troubleshooting.Check

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Rectangle().fill(color).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 2) {
                Text(check.title).font(.subheadline)
                Text(check.detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var color: Color {
        switch check.ok {
        case true?: return Theme.done
        case false?: return Theme.failed
        case nil: return Color(.tertiaryLabel)
        }
    }
}

/// One address of the last route choice: which line, where, and what came of it (answered, timed out, refused…).
struct RouteProbeRow: View {
    let probe: ProbeReport

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(probe.endpoint.kind.title)
                Spacer()
                Text(verdict).foregroundStyle(color)
            }
            .font(.subheadline)
            Text(probe.endpoint.authority).font(.caption.monospaced()).foregroundStyle(.secondary)
            if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var seconds: String { String(format: "%.1fs", probe.seconds) }

    private var verdict: String {
        switch probe.outcome {
        case .ok?: return "ok · \(seconds)"
        case nil: return "unused"
        case .unauthorized?: return "unpaired"
        case .pinMismatch?: return "certificate changed"
        case .unreachable?: return "no response · \(seconds)"
        }
    }

    private var detail: String? {
        switch probe.outcome {
        case .unreachable(let reason)?: return reason
        case nil: return "已通过优先级更高的地址连接"
        default: return nil
        }
    }

    private var color: Color {
        switch probe.outcome {
        case .ok?: return Theme.done
        case nil: return .secondary
        default: return Theme.failed
        }
    }
}
