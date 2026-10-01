import AgentSwitchKit
import SwiftUI

/// Adding a Mac, or pairing again with one that no longer knows this phone (app-v0 §5 多台 Mac): the scanner, then
/// the same confirmation as the first pairing, in one sheet.
struct AddMacSheet: View {
    @Environment(AppModel.self) private var model
    @State private var link: String?

    var body: some View {
        if let link {
            PairConfirmView(link: link)
        } else {
            ScannerSheet { code in link = code }
                .safeAreaInset(edge: .bottom) {
                    Button("Paste Pairing Link") { paste() }
                        .controlSize(.large)
                        .padding(.bottom, Theme.Space.l)
                }
        }
    }

    private func paste() {
        let text = Clipboard.pastedText()?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty { model.banner = "剪贴板中无配对链接" } else { link = text }
    }
}

/// The current Mac as the home screen's title, with the other paired Macs to switch to.
struct MacSwitcher: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            ForEach(model.macs.servers, id: \.fingerprint) { mac in
                Button { model.switchTo(mac.fingerprint) } label: {
                    if mac.fingerprint == model.profile?.fingerprint {
                        Label(mac.name, systemImage: "checkmark")
                    } else {
                        Text(mac.name)
                    }
                }
            }
            Divider()
            Button("Add Mac", systemImage: "plus") { model.sheet = .addMac }
        } label: {
            HStack(spacing: 4) {
                Text(model.profile?.name ?? "AgentSwitch").font(.headline)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
        }
        .accessibilityLabel("切换 Mac，当前为 \(model.profile?.name ?? "Mac")")
    }
}
