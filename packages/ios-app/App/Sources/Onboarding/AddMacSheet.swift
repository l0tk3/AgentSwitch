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

/// The paired Macs as a menu's rows — the current one checked — and `Add Mac` under them.
struct MacSwitchRows: View {
    @Environment(AppModel.self) private var model

    var body: some View {
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
    }
}

/// Which Mac a page shows, as the small line under its title (`@ Mac mini`; `On Mac mini` in the classic look, as the
/// Files pages write it). With more than one Mac paired the line is the menu to switch to another, on every
/// page (docs/mesh-v0.md §5.1; 2026-11-10, user: 手机上现在选择连接的机器只能在dispatch里选，这样不好，在terminal里应该也能选才对). `switches: false`: the line alone (a page that is not a tab's first).
struct MacLine: View {
    var switches = true
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look

    private var name: String { model.profile?.name ?? "Mac" }

    var body: some View {
        if switches, model.macs.servers.count > 1 {
            Menu {
                MacSwitchRows()
            } label: {
                HStack(spacing: 3) {
                    words
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
                }
                // Room for a finger around a line this small.
                .padding(.horizontal, 10).padding(.vertical, 3).contentShape(Rectangle())
            }
            .accessibilityLabel("切换 Mac，当前为 \(name)")
        } else {
            words
        }
    }

    private var words: some View {
        Text(look.isClassic ? "On \(name)" : "@ \(name)").mono(11).foregroundStyle(look.isClassic ? Color.secondary : Theme.signal).lineLimit(1)
    }
}

/// A tab's own title with, when more than one Mac is paired, the Mac it shows under it to switch by. One Mac: the
/// title alone, as before.
struct MacTabTitle<Mark: View>: View {
    let title: String
    @ViewBuilder var mark: Mark
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                mark
                Text(title).font(.headline)
            }
            .accessibilityElement(children: .combine)
            if model.macs.servers.count > 1 { MacLine() }
        }
    }
}

extension MacTabTitle where Mark == EmptyView {
    init(title: String) { self.init(title: title) { EmptyView() } }
}
