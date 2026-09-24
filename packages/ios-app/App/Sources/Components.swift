import AgentSwitchKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct StatusBadge: View {
    let task: AgentTask

    var body: some View {
        Text(task.statusLabel)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch task.status {
        case .done: return .green
        case .failed: return .red
        case .partial, .blocked: return .orange
        case .waitingApproval: return .purple
        case .cancelled: return .gray
        default: return .blue
        }
    }
}

/// The connection line shown on top of the lists: where we are connected, or why not.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.connection {
        case .connected:
            EmptyView()
        case .idle, .selecting:
            Label("正在连接 \(model.profile?.name ?? "Mac")…", systemImage: "antenna.radiowaves.left.and.right")
                .font(.footnote).foregroundStyle(.secondary)
        case .unreachable:
            HStack {
                Label("连不上 Mac", systemImage: "wifi.exclamationmark").foregroundStyle(.orange)
                Spacer()
                Button("重试") { model.reconnect() }
            }.font(.footnote)
        case .unauthorized:
            HStack {
                Label("此设备已被吊销或令牌失效", systemImage: "person.crop.circle.badge.xmark").foregroundStyle(.red)
                Spacer()
                Button("重新配对") { model.forget() }
            }.font(.footnote)
        case .pinMismatch:
            Label("服务器证书与配对时不一致，已拒绝连接", systemImage: "exclamationmark.shield")
                .font(.footnote).foregroundStyle(.red)
        }
    }
}

/// Dismissable error line.
struct ErrorText: View {
    @Binding var message: String?

    var body: some View {
        if let message {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(message).font(.footnote)
                Spacer()
                Button { self.message = nil } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
    }
}

enum Keyboard {
    /// Before a push or a sheet: a text field that is still first responder gets its focus back when the home screen
    /// returns, and the keyboard then comes up mid-transition with the input bar left underneath it.
    @MainActor
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

enum Clipboard {
    /// Ciphertext only: kept on this device (no Universal Clipboard) and expiring after two minutes. Plaintext secrets
    /// never go through here.
    static func copyToken(_ token: String) {
        UIPasteboard.general.setItems([[UTType.plainText.identifier: token]],
                                      options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    }

    static func pastedText() -> String? { UIPasteboard.general.string }
}

extension Date {
    var relative: String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: self, relativeTo: Date())
    }
}
