import AgentSwitchKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The status of a task where a small mark is enough (lists, links): the dot and word of StatusLabel.
struct StatusBadge: View {
    let task: AgentTask

    var body: some View {
        StatusLabel(task: task)
    }
}

/// The connection line shown on top of the lists (control-v0 §5): 连接中 → 重连中 → 无法连接（第 N 次）→ 未找到 Mac →
/// 配对已失效, so a blip and a Mac that is gone read differently. The phone keeps retrying on its own; 重试 only does
/// it now.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let phase = model.connectionPhase
        switch phase {
        case .connected:
            EmptyView()
        case .connecting, .reconnecting:
            Label(phase.text, systemImage: "antenna.radiowaves.left.and.right")
                .font(.footnote).foregroundStyle(.secondary)
        case .failing, .lost:
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack {
                    Label(phase.text, systemImage: "wifi.exclamationmark").foregroundStyle(Theme.waiting)
                    Spacer()
                    Button("重试") { model.reconnect() }
                }
                if phase == .lost {
                    Text("Mac 可能处于睡眠状态或已离线。查看 设置 › Mac › 排障。").foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
        case .unpaired:
            HStack {
                Label("配对已失效", systemImage: "person.crop.circle.badge.xmark").foregroundStyle(Theme.failed)
                Spacer()
                Button("重新配对") { model.forget() }
            }.font(.footnote)
        case .certificateChanged:
            Label("Mac 的证书与配对时不一致，已拒绝连接", systemImage: "exclamationmark.shield")
                .font(.footnote).foregroundStyle(Theme.failed)
        }
    }
}

/// Dismissable error line.
struct ErrorText: View {
    @Binding var message: String?

    var body: some View {
        if let message {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.failed)
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
    /// 刚刚 · 3 分钟前 · 今天 14:20 · 9月24日 (docs/ui-v0.md §4).
    var relative: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        let calendar = Calendar.current
        let time = formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDateInToday(self) { return "今天 \(time)" }
        if calendar.isDateInYesterday(self) { return "昨天 \(time)" }
        return formatted(.dateTime.month(.defaultDigits).day())
    }
}
