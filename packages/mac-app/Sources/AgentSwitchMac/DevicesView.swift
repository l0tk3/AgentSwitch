import AgentSwitchMacCore
import SwiftUI

/// 设备: every paired device, newest first; revoking cuts it off at once (401 on its next request).
struct DevicesView: View {
    @Environment(AppModel.self) private var model
    @State private var pendingRevoke: Device?
    @State private var busy = false

    private var rows: [Device] {
        model.devices.sorted { ($0.isRevoked ? 1 : 0, -($0.createdAt?.timeIntervalSince1970 ?? 0)) < ($1.isRevoked ? 1 : 0, -($1.createdAt?.timeIntervalSince1970 ?? 0)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("已配对的设备").font(.title3.weight(.semibold))
                Spacer()
                Button { Task { await model.refreshDevices() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新")
            }
            if rows.isEmpty {
                ContentUnavailableView("还没有配对的设备", systemImage: "iphone.slash",
                                       description: Text(model.daemonReady ? "在「配对」里生成二维码，用 iPhone 扫描。" : model.daemonLine.text))
            } else {
                Table(rows) {
                    TableColumn("名称") { d in Text(d.name).foregroundStyle(d.isRevoked ? .secondary : .primary) }
                    TableColumn("平台") { d in Text(d.platform) }.width(70)
                    TableColumn("配对时间") { d in Text(Formatters.dateTime(d.createdAt)) }
                    TableColumn("最近连接") { d in Text(Formatters.relative(d.lastSeenAt)) }
                    TableColumn("状态") { d in status(d) }.width(70)
                    TableColumn("") { d in
                        if !d.isRevoked {
                            Button("吊销", role: .destructive) { pendingRevoke = d }.disabled(busy)
                        }
                    }
                    .width(60)
                }
            }
            Text("吊销后这台设备立刻无法访问，要再用只能重新配对。手机丢了就在这里吊销。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .task { await model.refreshDevices() }
        .confirmationDialog("吊销「\(pendingRevoke?.name ?? "")」？", isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } })) {
            Button("吊销", role: .destructive) {
                if let device = pendingRevoke { Task { await revoke(device) } }
            }
        } message: {
            Text("这台设备的令牌会立刻失效，正在进行的连接也会断开。")
        }
    }

    @ViewBuilder
    private func status(_ d: Device) -> some View {
        if d.isRevoked {
            Text("已吊销").foregroundStyle(.secondary)
        } else if d.online == true {
            Label("在线", systemImage: "circle.fill").foregroundStyle(.green).labelStyle(.titleAndIcon).font(.caption)
        } else {
            Text("离线").foregroundStyle(.secondary)
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
