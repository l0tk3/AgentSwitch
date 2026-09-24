import AgentSwitchMacCore
import CoreGraphics
import Foundation
import Observation

/// One pairing at a time, kept by the model so the QR survives tab switches: `POST /pairing`, the QR image,
/// then the device list watched until a new phone appears or the code expires.
@MainActor
@Observable
final class PairingSession {
    private(set) var pairing: Pairing?
    private(set) var qr: CGImage?
    private(set) var paired: Device?
    private(set) var problem: String?
    private(set) var busy = false
    @ObservationIgnored private var baseline: Set<String> = []
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var clipboardExpiry: Task<Void, Never>?
    static let watchInterval: Duration = .seconds(2)

    /// A new code (the daemon voids the previous one).
    func start(model: AppModel) async {
        busy = true
        defer { busy = false }
        do {
            await model.refreshDevices()
            let fresh = try await model.client.createPairing()
            baseline = Set(model.devices.map(\.id))
            pairing = fresh
            qr = QRCodeRenderer.image(for: fresh.link)
            paired = nil
            problem = qr == nil ? "二维码生成失败，可以复制链接发给手机" : nil
            watch(model: model, until: fresh.expiresAt)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// 复制链接: this Mac only, hidden from clipboard history, and gone from the clipboard when the code expires
    /// unless something else was copied in the meantime (SensitiveClipboard).
    func copyLink() {
        guard let pairing else { return }
        let written = SensitiveClipboard.copy(pairing.link)
        let expiry = pairing.expiresAt
        clipboardExpiry?.cancel()
        clipboardExpiry = Task {
            try? await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            SensitiveClipboard.clear(ifStill: written)
        }
    }

    /// The code died with the daemon (restart) or the user moved on.
    func reset() {
        watcher?.cancel()
        watcher = nil
        pairing = nil
        qr = nil
    }

    private func watch(model: AppModel, until expiry: Date) {
        watcher?.cancel()
        watcher = Task { [weak self, weak model] in
            while !Task.isCancelled && expiry > Date() {
                try? await Task.sleep(for: PairingSession.watchInterval)
                guard let self, let model, !Task.isCancelled else { return }
                await model.refreshDevices()
                if let device = model.devices.first(where: { !self.baseline.contains($0.id) && !$0.isRevoked }) {
                    self.paired = device
                    self.pairing = nil
                    self.qr = nil
                    return
                }
            }
        }
    }
}
