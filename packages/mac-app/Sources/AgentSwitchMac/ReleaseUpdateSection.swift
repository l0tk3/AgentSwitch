import AgentSwitchMacCore
import SwiftUI

struct ReleaseUpdateSection: View {
    @Environment(AppModel.self) private var model
    @State private var checking = false
    @State private var release: ReleaseCheck.Release?
    @State private var message: String?
    @State private var problem = false
    @State private var checkedAt: Date?

    private var current: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? model.runtimeVersions["daemon"] ?? "Unknown"
    }

    var body: some View {
        Section {
            LabeledContent("AgentSwitch", value: current)
            HStack {
                Button(checking ? "Checking…" : "Check for Updates") {
                    checking = true
                    Task {
                        defer { checking = false }
                        do {
                            let latest = try await ReleaseCheck.latest()
                            let newer = try ReleaseCheck.newer(latest.version, than: current)
                            release = latest
                            message = newer ? "有新版本 \(latest.version)。" : "当前已是最新版本（最新正式版 \(latest.version)）。"
                            problem = false
                            checkedAt = Date()
                        } catch {
                            release = nil
                            message = error.localizedDescription
                            problem = true
                            checkedAt = nil
                        }
                    }
                }.disabled(checking)
                Link("View Releases…", destination: release?.page ?? ReleaseCheck.releasesURL)
            }
            if let message { Text(message).foregroundStyle(problem ? Color.red : Color.secondary) }
            if let checkedAt { Text("检查于 " + checkedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
        } header: {
            SectionLabel("App Updates")
        } footer: {
            Footer("检查 GitHub 正式发布版本。仅提示更新，不自动下载、安装或切换；打开发布页可查看说明和下载安装包。")
        }
    }
}
