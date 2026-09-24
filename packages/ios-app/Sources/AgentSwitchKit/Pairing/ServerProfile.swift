import Foundation

/// Where a paired Mac can be reached: what endpoint selection needs, from either a fresh pairing payload or a saved
/// profile.
public protocol ServerAddressBook: Sendable {
    var port: Int { get }
    var fingerprint: String { get }
    var lan: [String] { get }
    var tailnet: [String] { get }
    var bonjour: String { get }
}

extension PairingPayload: ServerAddressBook {
    public var fingerprint: String { fp }
}

/// The paired Mac, saved on the phone. Holds no secret: the device token lives in the Keychain, keyed by `fingerprint`.
public struct ServerProfile: Codable, Sendable, Equatable, ServerAddressBook {
    public let name: String
    public let port: Int
    /// SHA-256 of the server certificate's DER, lowercase hex: the only certificate the phone accepts.
    public let fingerprint: String
    public let lan: [String]
    public let tailnet: [String]
    public let bonjour: String
    public let gate: GateKey?
    public let deviceId: String
    public let pairedAt: Date

    public init(name: String, port: Int, fingerprint: String, lan: [String], tailnet: [String], bonjour: String,
                gate: GateKey?, deviceId: String, pairedAt: Date) {
        self.name = name
        self.port = port
        self.fingerprint = fingerprint
        self.lan = lan
        self.tailnet = tailnet
        self.bonjour = bonjour
        self.gate = gate
        self.deviceId = deviceId
        self.pairedAt = pairedAt
    }

    public init(payload: PairingPayload, deviceId: String, gate: GateKey?, pairedAt: Date = Date()) {
        self.init(name: payload.name, port: payload.port, fingerprint: payload.fp, lan: payload.lan,
                  tailnet: payload.tailnet, bonjour: payload.bonjour, gate: gate ?? payload.gate, deviceId: deviceId,
                  pairedAt: pairedAt)
    }

    /// A copy with a new gate key (the user switched keypairs on the Mac).
    public func with(gate: GateKey?) -> ServerProfile {
        ServerProfile(name: name, port: port, fingerprint: fingerprint, lan: lan, tailnet: tailnet, bonjour: bonjour,
                      gate: gate, deviceId: deviceId, pairedAt: pairedAt)
    }

    /// Keychain account for this server's device token.
    public var tokenAccount: String { fingerprint }

    /// `ab12 cd34 …` for showing the fingerprint to a human.
    public static func grouped(_ fingerprint: String) -> String {
        stride(from: 0, to: fingerprint.count, by: 4).map { i -> String in
            let start = fingerprint.index(fingerprint.startIndex, offsetBy: i)
            let end = fingerprint.index(start, offsetBy: 4, limitedBy: fingerprint.endIndex) ?? fingerprint.endIndex
            return String(fingerprint[start..<end])
        }.joined(separator: " ")
    }
}
