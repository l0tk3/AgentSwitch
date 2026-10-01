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
            HStack(spacing: 6) {
                BrailleSpinner(color: .secondary)
                Text(phase.text).mono(12).foregroundStyle(.secondary)
            }
        case .failing, .lost:
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting)
                    Text(phase.text).mono(12).foregroundStyle(Theme.waiting)
                    Spacer()
                    Button("Retry") { model.reconnect() }.mono(12)
                }
                if phase == .lost {
                    Text("Mac 可能处于睡眠状态或已离线。请查看 Settings › Mac › Troubleshooting。").font(.footnote).foregroundStyle(.secondary)
                }
            }
        case .unpaired:
            HStack(spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.failed)
                Text(phase.text).mono(12).foregroundStyle(Theme.failed)
                Spacer()
                Button("Pair Again") { model.pairAgain() }.mono(12)
            }
        case .certificateChanged:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.failed)
                Text("Mac 的证书与配对时不一致，已拒绝连接。").font(.footnote).foregroundStyle(Theme.failed)
            }
        }
    }
}

/// Dismissable error line.
struct ErrorText: View {
    @Binding var message: String?

    var body: some View {
        if let message {
            HStack(alignment: .top) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.failed).padding(.top, 4)
                Text(message).font(.footnote)
                Spacer()
                Button { self.message = nil } label: { Text("×").mono(15) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("close")
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
    /// Now · 3m ago · Today 14:20 · Yesterday 14:20 · 9/24 (docs/ui-v0.md §7.2.7, as on the Mac).
    var relative: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "Now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        let calendar = Calendar.current
        let time = formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDateInToday(self) { return "Today \(time)" }
        if calendar.isDateInYesterday(self) { return "Yesterday \(time)" }
        let parts = calendar.dateComponents([.month, .day], from: self)
        return "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }
}
