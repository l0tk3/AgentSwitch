import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }
}

public enum PairingLinkError: LocalizedError, Equatable {
    case notAPairingLink
    case badPayload(String)

    public var errorDescription: String? {
        switch self {
        case .notAPairingLink: return "非 agentswitch://pair 链接"
        case .badPayload(let why): return "配对链接内容无效：\(why)"
        }
    }
}

/// `agentswitch://pair?p=<base64url(JSON)>` (app-v0 §2 配对). The daemon builds it; the app renders it and
/// reads it back to show what the phone will receive.
public enum PairingLink {
    public static let scheme = "agentswitch"
    public static let host = "pair"

    public static func parse(_ link: String) throws -> PairingPayload {
        guard let components = URLComponents(string: link), components.scheme == scheme, components.host == host,
              let p = components.queryItems?.first(where: { $0.name == "p" })?.value else {
            throw PairingLinkError.notAPairingLink
        }
        guard let data = Base64URL.decode(p) else { throw PairingLinkError.badPayload("参数 p 不是 base64url 编码") }
        do {
            return try JSONDecoder().decode(PairingPayload.self, from: data)
        } catch {
            throw PairingLinkError.badPayload(String(describing: error))
        }
    }

    public static func make(_ payload: PairingPayload) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return "\(scheme)://\(host)?p=\(Base64URL.encode(try encoder.encode(payload)))"
    }

    /// `ABCD1234` → `ABCD-1234`; anything already formatted or of another length passes through.
    public static func displayCode(_ code: String) -> String {
        let raw = code.uppercased().filter { $0 != "-" && $0 != " " }
        guard raw.count == 8 else { return code }
        return "\(raw.prefix(4))-\(raw.suffix(4))"
    }
}

public enum Countdown {
    public static func remaining(until deadline: Date, now: Date) -> TimeInterval {
        max(0, deadline.timeIntervalSince(now))
    }

    /// `4:59`, never negative.
    public static func format(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds.rounded(.up)))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// QR codes with CoreImage's generator, scaled by whole modules so the image stays crisp.
public enum QRCodeRenderer {
    public static func image(for text: String, scale: CGFloat = 10, correction: String = "M") -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = correction
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent)
    }

    /// Decodes the first QR code in an image (tests, and a self-check before showing it).
    public static func decode(_ image: CGImage) -> String? {
        let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil,
                                  options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let features = detector?.features(in: CIImage(cgImage: image)) ?? []
        return features.compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }
}
