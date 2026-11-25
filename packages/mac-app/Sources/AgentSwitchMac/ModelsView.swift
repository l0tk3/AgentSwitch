import AgentSwitchMacCore
import SwiftUI

/// 模型: usage (docs/ui-v0.md §4.2), read from the service (`GET /quota`).
struct ModelsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if !model.daemonReady {
                EmptyPage(title: "Service Not Ready", symbol: "hourglass", message: model.daemonLine.text)
            } else {
                Form { UsageSection() }.formStyle(.grouped)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await model.refreshUsage(force: true) } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload")
                    .disabled(!model.daemonReady)
            }
        }
        .task(id: model.daemonReady) { await model.refreshUsage() }
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
