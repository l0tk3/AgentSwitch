import AgentSwitchKit
import SwiftUI

/// The room's secrets (2026-11-24): what the members log in, call an API or run a command with, each a ciphertext the
/// Mac's gate sealed. Here they are read and removed — a long press copies a token whole, a swipe removes one (asked
/// first); adding one needs the Mac's gate, and is done there.
struct RoomSecretsSheet: View {
    let model: RoomPageModel
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var secrets: [RoomSecret]?
    @State private var error: String?
    @State private var removing: RoomSecret?
    /// The secret whose token was just copied: said for a moment.
    @State private var copied: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let secrets {
                        if secrets.isEmpty { Text("这个房间还没有密文。").foregroundStyle(.secondary) }
                        ForEach(secrets) { row($0) }
                    } else if error == nil {
                        HStack { Spacer(); BrailleSpinner(color: Theme.secondaryInk); Spacer() }
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let error { Text(error).foregroundStyle(Theme.failed) }
                        Text(RoomSecret.addOnMacSays)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Secrets").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .confirmationDialog("删除“\(removing?.name ?? "")”？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button("Delete", role: .destructive) { if let s = removing { Task { await remove(s) } } }
            } message: {
                Text("房间里的成员将不能再用这条密文。其他房间里导入过的同一条不受影响。")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ s: RoomSecret) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(s.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(s.kind.word).mono(11).foregroundStyle(Theme.secondaryInk)
                Spacer(minLength: 0)
                if copied == s.id { Text("Copied").mono(11).foregroundStyle(Theme.done) }
            }
            if let line = s.whereLine { Text(line).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
            Text(s.shortToken()).code(12).foregroundStyle(Theme.inkDim).lineLimit(1)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onLongPressGesture {
            UIPasteboard.general.string = s.token
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            copied = s.id
            Task { try? await Task.sleep(for: .seconds(1.5)); if copied == s.id { copied = nil } }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", role: .destructive) { removing = s }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Copy Token") { UIPasteboard.general.string = s.token }
    }

    private func load() async {
        #if DEBUG
        if DemoRooms.isDemo { secrets = DemoRooms.secrets; return }
        #endif
        guard let api = app.api else { error = "没有连上 Mac。"; return }
        do { secrets = try await api.roomSecrets(model.id); error = nil } catch { self.error = error.localizedDescription }
    }

    private func remove(_ s: RoomSecret) async {
        removing = nil
        #if DEBUG
        if DemoRooms.isDemo { secrets?.removeAll { $0.id == s.id }; return }
        #endif
        let done = await model.run(app.api) { try await $0.deleteRoomSecret(s.id, in: model.id) }
        if done { secrets?.removeAll { $0.id == s.id } } else { error = model.error }
        await load()
    }
}
