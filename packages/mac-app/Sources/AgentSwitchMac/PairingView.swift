import AgentSwitchMacCore
import SwiftUI

/// 配对: the link from `POST /pairing` as a QR code, the code with a countdown, and the result once a phone pairs.
struct PairingView: View {
    @Environment(AppModel.self) private var model

    private var session: PairingSession { model.pairingSession }

    var body: some View {
        if !model.remoteEnabled {
            EmptyPage(title: "iPhone off", symbol: "iphone.slash", message: "配对和使用 iPhone 需要打开此连接。") {
                Button("turn on") { model.setRemoteAccess(true) }
            }
        } else if !model.daemonReady {
            EmptyPage(title: "service not ready", symbol: "hourglass", message: model.daemonLine.text)
        } else {
            Form {
                Section {
                    PairingCodeView()
                } footer: {
                    Footer("使用 iPhone 上的 AgentSwitch 扫描二维码。配对码 5 分钟内有效，仅可使用一次。")
                }
                if let paired = session.paired {
                    Section {
                        Label("paired \(paired.name) (\(platformName(paired.platform)))", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } footer: {
                        Footer("如非本人设备，请在「devices」中吊销。")
                    }
                }
                if let problem = session.problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.attention).textSelection(.enabled)
                    }
                }
                if let payload = session.pairing?.payload {
                    Section {
                        LabeledContent("name", value: payload.name)
                        LabeledContent("port", value: String(payload.port))
                        LabeledContent("LAN", value: payload.lan.isEmpty ? "none" : payload.lan.joined(separator: ", "))
                        LabeledContent("Tailscale", value: payload.tailnet.isEmpty ? "none · same LAN only" : payload.tailnet.joined(separator: ", "))
                        LabeledContent("cert fingerprint", value: String(payload.fp.prefix(16)) + "…")
                        LabeledContent("gateway key", value: payload.gate.map { "\($0.keypair) · \($0.publicKey.prefix(12))…" } ?? "none")
                    } header: {
                        SectionLabel("QR contents")
                    } footer: {
                        Footer("仅包含地址、证书指纹和公钥，不含密码。")
                    }
                    .textSelection(.enabled)
                }
            }
            .formStyle(.grouped)
        }
    }
}

/// The pairing code: QR on the left; code, countdown and the two buttons on the right. Also the wizard's 配对手机 step.
struct PairingCodeView: View {
    @Environment(AppModel.self) private var model
    /// Return presses 生成配对码; off inside the wizard, where Return is 继续.
    var returnGenerates = true

    private var session: PairingSession { model.pairingSession }

    var body: some View {
        HStack(alignment: .center, spacing: 24) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white)
                if let qr = session.qr {
                    Image(decorative: qr, scale: 1).interpolation(.none).resizable().padding(12)
                } else {
                    Image(systemName: "qrcode").font(.system(size: 64, weight: .light)).foregroundStyle(Color.gray.opacity(0.35))
                }
            }
            .frame(width: 184, height: 184)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
            VStack(alignment: .leading, spacing: 12) {
                if let pairing = session.pairing {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let left = Countdown.remaining(until: pairing.expiresAt, now: context.date)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(PairingLink.displayCode(pairing.code))
                                .font(.system(size: 28, weight: .semibold, design: .monospaced))
                                .textSelection(.enabled)
                                .foregroundStyle(left > 0 ? .primary : .tertiary)
                            Text(left > 0 ? "expires in \(Countdown.format(left))" : "expired")
                                .monospacedDigit()
                                .foregroundStyle(left > 60 ? Color.secondary : Color.attention)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("no pairing code").font(.title3.weight(.semibold))
                        Text("生成后使用 iPhone 扫描。").foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    Button(session.pairing == nil ? "generate" : "regenerate") { Task { await session.start(model: model) } }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(returnGenerates ? .defaultAction : nil)
                        .disabled(session.busy)
                    if session.pairing != nil {
                        Button("copy link") { session.copyLink() }
                            .help("仅复制到这台 Mac，不同步到其他设备；配对码过期时自动清除")
                    }
                    if session.busy { ProgressView().controlSize(.small) }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}
