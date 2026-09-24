import AgentSwitchMacCore
import SwiftUI

/// 配对: the link from `POST /pairing` as a QR code, the code with a countdown, and the result once a phone pairs.
struct PairingView: View {
    @Environment(AppModel.self) private var model

    private var session: PairingSession { model.pairingSession }

    var body: some View {
        if !model.remoteEnabled {
            ContentUnavailableView {
                Label("远程已关闭", systemImage: "iphone.slash")
            } description: {
                Text("打开「通用 › 允许 iPhone 连接」后才能配对和使用手机。")
            } actions: {
                Button("打开远程") { model.setRemoteAccess(true) }
            }
        } else if !model.daemonReady {
            ContentUnavailableView("守护进程还没就绪", systemImage: "hourglass", description: Text(model.daemonLine.text))
        } else {
            HStack(alignment: .top, spacing: 24) {
                qrPanel
                details
            }
            .padding(8)
        }
    }

    private var qrPanel: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white).frame(width: 260, height: 260)
                if let qr = session.qr {
                    Image(decorative: qr, scale: 1).interpolation(.none).resizable().frame(width: 236, height: 236)
                } else {
                    Image(systemName: "qrcode").font(.system(size: 80)).foregroundStyle(.gray.opacity(0.4))
                }
            }
            if let pairing = session.pairing {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let left = Countdown.remaining(until: pairing.expiresAt, now: context.date)
                    VStack(spacing: 4) {
                        Text(PairingLink.displayCode(pairing.code))
                            .font(.system(size: 30, weight: .semibold, design: .monospaced))
                            .textSelection(.enabled)
                            .opacity(left > 0 ? 1 : 0.35)
                        Text(left > 0 ? "有效期还剩 \(Countdown.format(left))" : "配对码已过期，请重新生成")
                            .foregroundStyle(left > 60 ? Color.secondary : Color.orange)
                    }
                }
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("用 iPhone 上的 AgentSwitch 扫描二维码").font(.title3.weight(.semibold))
            Text("配对码 5 分钟内有效、只能用一次，输错 5 次作废。二维码里有这台 Mac 的地址、证书指纹和凭据网关的公钥（公钥可以公开），没有任何密码。")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(session.pairing == nil ? "生成配对二维码" : "重新生成") { Task { await session.start(model: model) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(session.busy)
                if session.pairing != nil {
                    Button("复制链接") { session.copyLink() }
                        .help("只复制到这台 Mac（不经通用剪贴板同步到其他设备），配对码过期时自动清掉")
                }
                if session.busy { ProgressView().controlSize(.small) }
            }
            if let payload = session.pairing?.payload {
                GroupBox {
                    VStack(alignment: .leading, spacing: 4) {
                        labelled("名称", payload.name)
                        labelled("端口", String(payload.port))
                        labelled("局域网", payload.lan.isEmpty ? "无" : payload.lan.joined(separator: "、"))
                        labelled("Tailscale", payload.tailnet.isEmpty ? "无（只能在同一局域网使用）" : payload.tailnet.joined(separator: "、"))
                        labelled("证书指纹", String(payload.fp.prefix(16)) + "…")
                        labelled("网关公钥", payload.gate.map { "\($0.keypair) · \($0.publicKey.prefix(12))…" } ?? "无")
                    }
                    .font(.caption)
                }
            }
            if let paired = session.paired {
                Label("已配对：\(paired.name)（\(paired.platform)）。不认识这台设备就去「设备」里吊销。", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            if let problem = session.problem {
                Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled)
            }
            Spacer()
        }
    }

    private func labelled(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
            Text(value).textSelection(.enabled)
        }
    }
}
