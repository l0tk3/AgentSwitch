import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        Form {
            TextField("secret-gate 命令路径", text: $state.cliPath)
            TextField("Gate home（SECRET_GATE_HOME）", text: $state.gateHome)
            Text("改完后回主窗口点刷新。私钥永远只在 gate home 里，界面不读它。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 560)
    }
}
