import AgentSwitchKit
import SwiftUI

/// First run: scan the QR code the Mac app shows, or paste its link. One screen, one action (docs/ui-v0.md).
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false

    var body: some View {
        VStack(spacing: Theme.Space.xl) {
            Spacer()
            // The app's mark, with depth (an identity mark of 20 pt and up, §7.2.10), off until a Mac is paired.
            PixelMarkView(state: .idle, pixel: 5)
            VStack(spacing: Theme.Space.s) {
                Text("连接你的 Mac").font(.title2.weight(.semibold))
                Text("在 Mac 上打开 AgentSwitch，点按「配对」，然后用此 iPhone 扫描二维码。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: Theme.Space.m) {
                if let banner = model.banner {
                    Text(banner).font(.footnote).foregroundStyle(Theme.failed).multilineTextAlignment(.center)
                }
                Button { scanning = true } label: { ButtonWord("Scan QR Code") }
                    .buttonStyle(SquareButtonStyle(prominent: true))
                Button("Paste Pairing Link") { paste() }
                    .controlSize(.large)
                Text("iPhone 与 Mac 需在同一局域网，或登录同一 Tailscale 网络。")
                    .font(.footnote).foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, Theme.Space.xl)
        .padding(.bottom, Theme.Space.l)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .sheet(isPresented: $scanning) {
            ScannerSheet { code in
                scanning = false
                model.receivePairingLink(code)
            }
        }
    }

    private func paste() {
        let text = Clipboard.pastedText()?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty { model.banner = "剪贴板中无配对链接" } else { model.receivePairingLink(text) }
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
                        Text("可改用「Paste Pairing Link」。").font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }
}

#Preview {
    OnboardingView().environment(AppModel(store: nil, vault: MemoryTokenVault()))
}
