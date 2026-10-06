import AgentSwitchMacCore
import SwiftUI

/// 设置 › Agents (docs/agents-v0.md §8, docs/design/concepts/agents.html): the four agent CLIs — what is installed and
/// where it came from, what the vendors have that is newer, and which install AgentSwitch runs. This first step shows
/// and chooses; installing, updating and deleting come with the store (agents-v0 §9).
struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmRestart = false

    var body: some View {
        Form {
            Section {
                LabeledContent("Updates") {
                    HStack(spacing: 6) {
                        StatusDot(level: model.agentsChecking ? .busy : model.agentUpdateCount > 0 ? .warning : .ok)
                        Text(updatesLine).mono(12).foregroundStyle(.secondary)
                    }
                }
                if model.agentsNeedRestart {
                    LabeledContent {
                        Button("Restart Service…") { confirmRestart = true }
                    } label: {
                        HStack(spacing: 6) {
                            StatusDot(level: .warning)
                            Text("Applies After Restart")
                        }
                    }
                }
            } footer: {
                if model.agentsNeedRestart {
                    Footer("已更改 AgentSwitch 使用的版本，重启服务后生效。已打开的终端继续使用原来的程序。")
                } else if let failed = AgentText.failed(model.agentReleases) {
                    Footer(failed)
                }
            }

            ForEach(model.agents) { AgentSection(report: $0) }

            Section {
                LabeledContent("Beta & Pinned") {
                    HStack(spacing: 8) {
                        Text(model.shortPath(model.agentLayout.store)).mono(12).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(AgentText.size(storeBytes)).mono(12).foregroundStyle(.secondary)
                    }
                }
            } header: {
                SectionLabel("Store")
            } footer: {
                Footer("Stable 安装在各自的官方位置，与自行安装的完全相同；删除 AgentSwitch 后仍可使用并照常更新。Beta 与 Pinned 存放在上面的版本库中，可随时整个删除，不影响 Stable。")
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.refreshAgents(force: true); model.checkAgentUpdates(force: true) } label: { Label("Check Now", systemImage: "arrow.clockwise") }
                    .help("Check Now")
                    .disabled(model.agentsChecking)
            }
        }
        .task {
            model.refreshAgents()
            model.checkAgentUpdates()
        }
        .confirmationDialog("重启服务？", isPresented: $confirmRestart) {
            Button("Restart Service") { model.restartDaemon() }
        } message: {
            Text("服务重启后改用新选择的版本。正在运行的任务和已打开的终端将中断。")
        }
    }

    private var updatesLine: String {
        let checked = AgentText.checked(model.agentReleases, checking: model.agentsChecking)
        guard !model.agentsChecking, model.agentReleases?.checkedAt != nil else { return checked }
        let count = model.agentUpdateCount
        return "\(count == 0 ? "Up to Date" : "\(count) Available") · \(checked)"
    }

    /// What the store holds: the betas and the pinned versions.
    private var storeBytes: Int64 {
        model.agents.flatMap(\.installs).filter { $0.source == .beta || $0.source == .pinned }.reduce(0) { $0 + ($1.bytes ?? 0) }
    }
}

/// One agent's group: a line per install, the radio on the left saying which one AgentSwitch runs.
private struct AgentSection: View {
    @Environment(AppModel.self) private var model
    let report: AgentReport

    var body: some View {
        let channels = model.agentReleases?.channels(report.agent)
        let used = model.agentInUse(report)
        Section {
            ForEach(AgentRow.rows(report, channels: channels)) { row in
                switch row {
                case .install(let install):
                    InstallRow(install: install, used: used?.key == install.key, newer: model.newerVersion(for: install),
                               detail: AgentText.detail(install, home: model.paths.userHome.path)) {
                        model.useAgent(report.agent, install: install)
                    }
                case .missing(let source, let available):
                    MissingRow(agent: report.agent, source: source, available: available)
                case .leftovers(let leftovers):
                    LeftoversRow(leftovers: leftovers)
                }
            }
        } header: {
            SectionLabel(report.agent.title)
        } footer: {
            if let note { Footer(note) }
        }
    }

    private var note: String? {
        if AgentSelection.lost(report, saved: model.agentUse[report.agent.rawValue]) {
            let now = model.agentInUse(report).map { "，现改用 \($0.source.title) \($0.version ?? "")" } ?? ""
            return "原先选用的版本已不存在\(now)。"
        }
        return report.agent == .pi ? "pi 没有测试通道。" : nil
    }
}

/// `◉ Stable 2.1.291`, under it `claude · ~/.local/bin · Follows Latest`; its size and what is newer on the right.
private struct InstallRow: View {
    let install: AgentInstall
    let used: Bool
    let newer: String?
    let detail: String
    let use: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Button(action: use) {
                Image(systemName: used ? "circle.inset.filled" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(used ? Color.brand : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(!install.selectable)
            .opacity(install.selectable ? 1 : 0.3)
            .help(used ? "AgentSwitch 使用此版本。" : install.selectable ? "让 AgentSwitch 使用此版本。" : "此版本不可用于 AgentSwitch。")
            .accessibilityLabel("Use \(install.source.title) \(install.version ?? "")")
            .accessibilityAddTraits(used ? .isSelected : [])
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(install.source.title)
                    Text(install.version ?? "…").foregroundStyle(.secondary).monospacedDigit()
                }
                Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    .help(install.location)
                if let caution = AgentText.caution(install) {
                    Text(caution).font(.caption).foregroundStyle(Color.waiting)
                }
            }
            Spacer(minLength: 12)
            if let newer {
                HStack(spacing: 5) {
                    StatusDot(level: .warning)
                    Text("\(newer) Available").mono(12).foregroundStyle(.secondary)
                }
                .help("有新版本 \(newer)。")
            }
            if let bytes = install.bytes {
                Text(AgentText.size(bytes)).mono(12).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
    }
}

/// `Stable  Not Installed`, the command it would answer to, and the version the vendor has now.
private struct MissingRow: View {
    let agent: AgentCLI
    let source: AgentSource
    let available: String?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "circle").font(.system(size: 14)).foregroundStyle(.secondary).opacity(0.3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(source.title)
                    Text("Not Installed")
                }
                .foregroundStyle(.secondary)
                Text(source == .beta ? agent.betaCommand ?? "" : agent.command).font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 12)
            if let available {
                Text(available).mono(12).foregroundStyle(.secondary).help("\(source.title) 通道的最新版本。")
            }
        }
        .padding(.vertical, 2)
    }
}

/// `Old Versions  2.1.288 · 2.1.289`: what the vendor's own install keeps beside the current one.
private struct LeftoversRow: View {
    let leftovers: AgentLeftovers

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "circle").font(.system(size: 14)).hidden()
            Text("Old Versions").foregroundStyle(.secondary)
            Text(leftovers.versions.joined(separator: " · ")).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 12)
            if let bytes = leftovers.bytes {
                Text(AgentText.size(bytes)).mono(12).foregroundStyle(.secondary).frame(minWidth: 58, alignment: .trailing)
            }
        }
    }
}
