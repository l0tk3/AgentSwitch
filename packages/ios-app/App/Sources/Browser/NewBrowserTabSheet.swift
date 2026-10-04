import AgentSwitchKit
import SwiftUI

/// `+` in the Browser tab (docs/browser-v0.md §1): the address — a URL, a path of the Mac's (`~/x/index.html`) or a
/// local server (`localhost:5173`, or its port alone) — then what was opened from this phone before and the servers
/// listening on the Mac (read afresh as the sheet opens). The Mac checks every address (its own data, credentials and ports are refused, with why); the
/// tab opens on the Mac and its page here.
struct NewBrowserTabSheet: View {
    let opened: (BrowserTabInfo) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var opening = false
    @State private var error: String?
    @FocusState private var typing: Bool

    var body: some View {
        let store = model.browser
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Address")
                        HStack(spacing: 8) {
                            Text("❯").mono(14).foregroundStyle(Theme.signal)
                            TextField("网址、Mac 上的路径或 localhost:5173", text: $address)
                                .mono(14)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .keyboardType(.URL)
                                .submitLabel(.go)
                                .focused($typing)
                                .onSubmit { Task { await open(BrowserAddress.target(for: address), typed: address) } }
                            if opening { BrailleSpinner(color: .secondary) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .framed(Theme.line, radius: Theme.Radius.control)
                        if let error {
                            Text(error).font(.footnote).foregroundStyle(Theme.failed).fixedSize(horizontal: false, vertical: true)
                                .glitch(on: error, onAppear: true)
                        }
                    }
                    if !store.recent.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            SectionLabel("Recent").padding(.bottom, 4)
                            ForEach(store.recent, id: \.self) { typed in
                                choice { Text(typed).mono(13).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle) } action: {
                                    Task { await open(BrowserAddress.target(for: typed), typed: typed) }
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        SectionLabel("Local Servers on \(model.profile?.name ?? "Mac")").padding(.bottom, 4)
                        if store.servers.isEmpty {
                            Text("Mac 上没有正在监听的本地服务。").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 6)
                        }
                        ForEach(store.servers) { server in
                            choice {
                                HStack(spacing: 8) {
                                    PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done)
                                    Text(verbatim: "localhost:\(server.port)").mono(13).foregroundStyle(Theme.ink)
                                    Text([server.name, MacPath.tilde(server.cwd)].filter { !$0.isEmpty }.joined(separator: " · "))
                                        .mono(11).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                }
                            } action: {
                                Task { await open(.port(server.port), typed: nil) }
                            }
                        }
                    }
                }
                .padding(Theme.Space.l)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationTitle("New Tab")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Open") { Task { await open(BrowserAddress.target(for: address), typed: address) } }
                        .disabled(BrowserAddress.target(for: address) == nil || opening)
                }
            }
            .task { await store.refreshServers(model.api) }
            .onAppear {
                #if DEBUG
                if UserDefaults.standard.bool(forKey: "uiDemo") { return }
                #endif
                typing = true
            }
        }
        .tint(Theme.ink)
    }

    private func choice<Label: View>(@ViewBuilder _ label: () -> Label, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                label()
                Spacer(minLength: 0)
                LookGlyph.onward().foregroundStyle(.tertiary)
            }
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(opening)
    }

    /// Opens it on the Mac; a refusal or a missing file stays here with the Mac's reason.
    private func open(_ target: BrowserTarget?, typed: String?) async {
        guard let target, let api = model.api, !opening else { return }
        opening = true
        defer { opening = false }
        do {
            let tab = try await api.openBrowserTab(target)
            if let typed { model.browser.remember(typed) }
            dismiss()
            opened(tab)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
