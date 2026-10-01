import AgentSwitchKit
import SwiftUI
import UIKit

/// Shows who the link says it is (Mac name, certificate fingerprint, addresses) before anything is sent, then pairs.
struct PairConfirmView: View {
    let link: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var deviceName = UIDevice.current.name
    @State private var pairing = false
    @State private var error: String?

    private var parsed: Result<PairingPayload, Error> { Result { try PairingLink.parse(link) } }

    var body: some View {
        NavigationStack {
            Group {
                switch parsed {
                case .success(let payload): form(payload)
                case .failure(let failure): invalid(failure)
                }
            }
            .navigationTitle("Pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .interactiveDismissDisabled(pairing)
        }
    }

    private func form(_ payload: PairingPayload) -> some View {
        Form {
            Section("Mac") {
                LabeledContent("Name", value: payload.name)
                VStack(alignment: .leading, spacing: 4) {
                    Text("证书指纹（与 Mac 上显示的一致时再继续）").font(.caption).foregroundStyle(.secondary)
                    Text(ServerProfile.grouped(payload.fp)).font(.footnote.monospaced()).textSelection(.enabled)
                }
                LabeledContent("Code") { Text(payload.code).mono(15) }
            }
            Section(label: "Addresses") {
                ForEach(payload.lan, id: \.self) { address in LabeledContent("LAN") { Text("\(address):\(payload.port)").mono(13) } }
                ForEach(payload.tailnet, id: \.self) { LabeledContent("Tailscale", value: "\($0):\(payload.port)") }
                if !payload.bonjour.isEmpty { LabeledContent("Bonjour", value: payload.bonjour) }
            }
            Section(label: "Gate Key") {
                if let gate = payload.gate {
                    LabeledContent("Keypair") { Text(gate.keypair).mono(13) }
                } else {
                    Text("二维码中无公钥，将在配对后向 Mac 获取").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section(label: "This Device") {
                TextField("设备名称", text: $deviceName)
                if let known = model.macs.server(payload.fp) {
                    Text("已与「\(known.name)」配对，将更新此配对。").font(.footnote).foregroundStyle(.secondary)
                } else if !model.macs.isEmpty {
                    Text("将添加这台 Mac 并切换到它，其他 Mac 的配对保留。").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                Button {
                    Task { await pair(payload) }
                } label: {
                    HStack {
                        Text(pairing ? "配对中" : "配对")
                        if pairing { Spacer(); BrailleSpinner(color: .secondary) }
                    }
                }
                .disabled(pairing)
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
            }
        }
    }

    private func invalid(_ failure: Error) -> some View {
        ContentUnavailableView("无法使用此链接", systemImage: "qrcode", description: Text(failure.localizedDescription))
    }

    private func pair(_ payload: PairingPayload) async {
        pairing = true
        error = nil
        defer { pairing = false }
        do {
            try await model.pair(payload, deviceName: deviceName)
            model.incomingPairingLink = nil
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
