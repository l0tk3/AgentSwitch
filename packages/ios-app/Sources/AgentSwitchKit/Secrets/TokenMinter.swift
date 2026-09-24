import Foundation
import Sodium

public enum TokenError: Error, Equatable, LocalizedError {
    case badPublicKey
    case sealFailed

    public var errorDescription: String? {
        switch self {
        case .badPublicKey: return "gate 公钥无效（应为 32 字节 base64url）"
        case .sealFailed: return "加密失败"
        }
    }
}

/// Mints `enc:v1:` tokens on the phone, compatible with `secret-gate enc`: the payload JSON sealed with libsodium
/// `crypto_box_seal` to the gate's X25519 public key, then base64url without padding. The plaintext never leaves the
/// device; only the Mac's gate can open the result.
public struct TokenMinter: Sendable {
    public static let prefix = "enc:v1:"
    public static let publicKeyBytes = 32

    public let publicKey: [UInt8]

    public init(publicKey: [UInt8]) throws {
        guard publicKey.count == Self.publicKeyBytes else { throw TokenError.badPublicKey }
        self.publicKey = publicKey
    }

    /// The key as the pairing payload and `GET /gate/pubkey` carry it.
    public init(publicKeyBase64URL text: String) throws {
        guard let data = Base64URL.decode(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw TokenError.badPublicKey }
        try self.init(publicKey: [UInt8](data))
    }

    public func mint(_ payload: SecretPayload) throws -> String {
        guard let sealed = Sodium().box.seal(message: [UInt8](payload.jsonData), recipientPublicKey: publicKey) else {
            throw TokenError.sealFailed
        }
        return Self.prefix + Base64URL.encode(sealed)
    }

    /// `enc:v1:[A-Za-z0-9_-]{16,}={0,2}` (constants.TOKEN_PATTERN), the whole string.
    public static func looksLikeToken(_ text: String) -> Bool {
        guard text.hasPrefix(prefix) else { return false }
        var body = Substring(text.dropFirst(prefix.count))
        var padding = 0
        while body.hasSuffix("=") { body = body.dropLast(); padding += 1 }
        return padding <= 2 && body.count >= 16 && Base64URL.decode(String(body)) != nil
    }
}
