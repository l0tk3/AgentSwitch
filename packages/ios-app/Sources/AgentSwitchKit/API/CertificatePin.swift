import CryptoKit
import Foundation
import Security

/// Trust in the Mac is one fact learned at pairing: the SHA-256 of its certificate's DER. No CA, no hostname check
/// (the certificate is self-signed and the Mac is reached by LAN IP, Tailscale IP or MagicDNS name alike).
public enum CertificatePin {
    public enum Decision: Equatable, Sendable {
        case accept
        /// The leaf's actual fingerprint (nil when the server sent no certificate).
        case reject(seen: String?)
    }

    /// SHA-256 of DER bytes, lowercase hex: the daemon's fingerprint format.
    public static func fingerprint(ofDER der: Data) -> String {
        Data(SHA256.hash(data: der)).hexString
    }

    /// Lowercase, `:` and spaces removed; nil unless 64 hex digits remain.
    public static func normalize(_ fingerprint: String) -> String? {
        let s = fingerprint.lowercased().filter { $0 != ":" && $0 != " " }
        guard s.count == 64, s.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        return s
    }

    /// Constant-time comparison of the leaf's fingerprint with the pinned one.
    public static func matches(der: Data, pinned: String) -> Bool {
        guard let pinned = normalize(pinned) else { return false }
        let actual = Array(fingerprint(ofDER: der).utf8)
        let expected = Array(pinned.utf8)
        guard actual.count == expected.count else { return false }
        return zip(actual, expected).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// The leaf certificate (first in the chain) as DER.
    public static func leafDER(of trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }

    public static func evaluate(trust: SecTrust, pinned: String) -> Decision {
        guard let der = leafDER(of: trust) else { return .reject(seen: nil) }
        return matches(der: der, pinned: pinned) ? .accept : .reject(seen: fingerprint(ofDER: der))
    }
}

/// URLSession delegate that accepts a server only when its leaf certificate matches the paired fingerprint.
/// Every other challenge gets default handling; a mismatch cancels the connection and is remembered per host so the
/// transport can report it as a pin failure rather than a generic network error.
public final class PinnedTrustDelegate: NSObject, URLSessionDelegate, Sendable {
    public let fingerprint: String
    private let mismatches = LockedBox<[String: String]>([:])

    public init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        switch CertificatePin.evaluate(trust: trust, pinned: fingerprint) {
        case .accept:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject(let seen):
            let host = Self.bare(space.host)
            mismatches.withLock { $0[host] = seen ?? "" }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// The fingerprint a host presented on its last rejected handshake, cleared on read.
    public func takeMismatch(host: String) -> String? {
        let key = Self.bare(host)
        return mismatches.withLock { $0.removeValue(forKey: key) }
    }

    private static func bare(_ host: String) -> String {
        host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    }
}
