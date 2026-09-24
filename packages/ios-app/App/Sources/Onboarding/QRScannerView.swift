@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// Camera QR scanner (AVFoundation). Delivers the first agentswitch:// code it sees, once.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onProblem: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onProblem = onProblem
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onProblem: ((String) -> Void)?

    private let capture = CaptureBox()
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor [weak self] in
                    if granted { self?.configure() } else { self?.onProblem?("没有相机权限。可在「设置 › AgentSwitch」里打开。") }
                }
            }
        default:
            onProblem?("没有相机权限。可在「设置 › AgentSwitch」里打开。")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        capture.stop()
    }

    private func configure() {
        let session = capture.session
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            onProblem?("这台设备没有可用的相机。")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onProblem?("相机无法识别二维码。")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        capture.start()
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let values = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        MainActor.assumeIsolated { deliver(values) }
    }

    private func deliver(_ values: [String]) {
        guard !delivered, let code = values.first(where: { $0.lowercased().hasPrefix("agentswitch://") }) else { return }
        delivered = true
        capture.stop()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(code)
    }
}

/// AVCaptureSession start/stop block, so they run on a private serial queue (Apple's guidance), never the main thread.
private final class CaptureBox: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "agentswitch.camera")

    func start() { queue.async { if !self.session.isRunning { self.session.startRunning() } } }
    func stop() { queue.async { if self.session.isRunning { self.session.stopRunning() } } }
}
