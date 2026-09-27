import Foundation

public enum PairingError: Error, Equatable, LocalizedError {
    /// Wrong, expired or already used code (the daemon answers all three the same way).
    case codeRejected
    /// More than 10 attempts a minute from this address (429, Retry-After: 60).
    case rateLimited
    case unreachable
    case pinMismatch(seen: String?)
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .codeRejected: return "配对码无效、已过期或已被使用，请在 Mac 上重新生成二维码"
        case .rateLimited: return "配对尝试过于频繁，请一分钟后重试"
        case .unreachable: return "无法连接此 Mac。请确认 iPhone 与 Mac 在同一局域网，或均已登录 Tailscale。"
        case .pinMismatch: return "Mac 的证书指纹与二维码不一致，已中止配对"
        case .failed(let message): return "配对失败：\(message)"
        }
    }
}

public struct PairingOutcome: Sendable {
    public let profile: ServerProfile
    public let token: String
    public let endpoint: APIEndpoint
}

/// Pairing (app-v0 §2, §5): find a reachable address from the payload, `POST /pair` over the pinned connection, and
/// fill in the gate key from `GET /gate/pubkey` if the QR code had none (`gate: null` when the Mac could not read it;
/// the endpoint then answers 503 and the app asks again later).
public struct PairingService: Sendable {
    public let transport: any HTTPTransport
    public let discovery: (any ServiceDiscovery)?
    public let discoveryTimeout: Duration
    public static let maxDeviceNameLength = 64

    public init(transport: any HTTPTransport, discovery: (any ServiceDiscovery)?, discoveryTimeout: Duration = .milliseconds(1500)) {
        self.transport = transport
        self.discovery = discovery
        self.discoveryTimeout = discoveryTimeout
    }

    public func pair(_ payload: PairingPayload, deviceName: String, platform: String = "ios") async throws -> PairingOutcome {
        let found = await discovery?.discover(timeout: discoveryTimeout) ?? []
        let candidates = EndpointSelector.candidates(for: payload, discovered: found)
        let endpoint: APIEndpoint
        switch await EndpointSelector.select(from: candidates, token: nil, prober: HTTPEndpointProber(transport: transport)) {
        case .selected(let e): endpoint = e
        case .pinMismatch(let seen): throw PairingError.pinMismatch(seen: seen)
        case .unauthorized, .unreachable: throw PairingError.unreachable
        }

        let anonymous = AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: nil)
        // The daemon takes 1-64 characters without control characters.
        let name = String(deviceName.filter { !$0.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxDeviceNameLength))
        let result: PairResult
        do {
            result = try await anonymous.post(["pair"], body: PairRequest(code: payload.code, name: name.isEmpty ? "iPhone" : name, platform: platform))
        } catch APIError.unauthorized {
            throw PairingError.codeRejected
        } catch APIError.http(status: 429, _) {
            throw PairingError.rateLimited
        } catch APIError.pinMismatch(let seen) {
            throw PairingError.pinMismatch(seen: seen)
        } catch {
            throw PairingError.failed(error.localizedDescription)
        }
        guard !result.token.isEmpty, !result.deviceId.isEmpty else { throw PairingError.failed("empty token") }

        var gate = payload.gate
        if gate == nil {
            let authed = AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: result.token)
            gate = try? await authed.gatePubkey()
            if let key = gate, !key.isValid { gate = nil }
        }
        let profile = ServerProfile(payload: payload, deviceId: result.deviceId, gate: gate)
        return PairingOutcome(profile: profile, token: result.token, endpoint: endpoint)
    }
}
