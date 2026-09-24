import AgentSwitchKit
import SwiftUI

/// First run: scan the QR code the Mac app shows, or paste its link.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("在 Mac 上打开 AgentSwitch，点「配对」显示二维码，然后用这台 iPhone 扫码。")
                        Text("iPhone 与 Mac 需在同一局域网，或两边都登录了同一个 Tailscale。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    Button {
                        scanning = true
                    } label: {
                        Label("扫描配对二维码", systemImage: "qrcode.viewfinder")
                    }
                }
                Section("或粘贴配对链接") {
                    TextField("agentswitch://pair?p=…", text: $pasted, axis: .vertical)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.footnote.monospaced())
                    HStack {
                        Button("从剪贴板粘贴") { pasted = Clipboard.pastedText() ?? "" }
                        Spacer()
                        Button("继续") { model.receivePairingLink(pasted) }
                            .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .buttonStyle(.borderless)
                }
                if let banner = model.banner {
                    Section { Text(banner).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("连接你的 Mac")
            .sheet(isPresented: $scanning) {
                ScannerSheet { code in
                    scanning = false
                    model.receivePairingLink(code)
                }
            }
        }
    }
}

/// The camera, with a close button and what to do when there is no camera (simulator) or no permission.
struct ScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ZStack {
                QRScannerView(onCode: onCode, onProblem: { problem = $0 })
                    .ignoresSafeArea()
                if let problem {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.fill").font(.largeTitle).foregroundStyle(.secondary)
                        Text(problem).multilineTextAlignment(.center)
                        Text("可以改用「粘贴配对链接」。").font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .navigationTitle("扫描二维码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }
}

#Preview {
    OnboardingView().environment(AppModel(store: nil, vault: MemoryTokenVault()))
}
