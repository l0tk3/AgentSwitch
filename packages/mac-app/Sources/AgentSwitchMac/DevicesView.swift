import AgentSwitchMacCore
import SwiftUI

/// 设备: every paired device, newest first; revoking cuts it off at once (401 on its next request).
struct DevicesView: View {
    @Environment(AppModel.self) private var model
    @State private var pendingRevoke: Device?
    @State private var busy = false

    private var sorted: [Device] {
        model.devices.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
    private var active: [Device] { sorted.filter { !$0.isRevoked } }
    private var revoked: [Device] { sorted.filter(\.isRevoked) }

    var body: some View {
        content
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await model.refreshDevices() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                        .help("刷新")
                }
            }
            .task { await model.refreshDevices() }
            .confirmationDialog("吊销「\(pendingRevoke?.name ?? "")」？", isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } })) {
                Button("吊销", role: .destructive) {
                    if let device = pendingRevoke { Task { await revoke(device) } }
                }
            } message: {
                Text("该设备将立即断开连接，再次使用需重新配对。")
            }
    }

    @ViewBuilder
    private var content: some View {
        if model.devices.isEmpty {
            EmptyPage(title: "无已配对设备", symbol: "iphone.slash",
                      message: model.daemonReady ? "在「配对」中生成配对码，然后使用 iPhone 扫描。" : model.daemonLine.text)
        } else {
            Form {
                Section {
                    if active.isEmpty {
                        Text("无可用设备").foregroundStyle(.secondary)
                    }
                    ForEach(active) { device in
                        DeviceRow(device: device) {
                            Button(role: .destructive) { pendingRevoke = device } label: { Text("吊销…").foregroundStyle(.red) }
                                .disabled(busy)
                        }
                    }
                } footer: {
                    Footer("设备丢失时可在此吊销，吊销后立即断开连接。")
                }
                if !revoked.isEmpty {
                    Section("已吊销") {
                        ForEach(revoked) { device in DeviceRow(device: device) { EmptyView() } }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private func revoke(_ device: Device) async {
        busy = true
        defer { busy = false }
        do {
            try await model.client.revokeDevice(id: device.id)
        } catch {
            model.errorMessage = error.localizedDescription
        }
        await model.refreshDevices()
    }
}

/// `[iPhone]  小林的 iPhone                ● 在线  [吊销…]`
///            `iOS · 5 天前配对 · 2 分钟前连接`
private struct DeviceRow<Trailing: View>: View {
    let device: Device
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "iphone").font(.title3).foregroundStyle(.secondary).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name).foregroundStyle(device.isRevoked ? .secondary : .primary)
                Text(details).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            if !device.isRevoked { StatusBadge(line: status) }
            trailing
        }
        .padding(.vertical, 2)
    }

    private var details: String {
        var parts = [platformName(device.platform)].filter { !$0.isEmpty }
        if let created = device.createdAt { parts.append("配对于 \(TimeText.day(created))") }
        if let revokedAt = device.revokedAt {
            parts.append("吊销于 \(TimeText.day(revokedAt))")
        } else {
            parts.append(device.lastSeenAt.map { "最近连接 \(TimeText.moment($0))" } ?? "从未连接")
        }
        return parts.joined(separator: " · ")
    }

    private var status: StatusLine {
        device.online == true ? StatusLine("在线", .ok) : StatusLine("离线", .off)
    }
}
