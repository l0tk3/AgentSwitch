import Foundation

// The browser routes a paired phone may use (docs/browser-v0.md §5; the daemon's remote allowlist). `screen` is this
// phone's own id (`phone-…`, the same as the terminals'): what it holds and the size it sets are its own.

private struct TabEnvelope: Decodable { let tab: BrowserTabInfo }
private struct ServerList: Decodable { let servers: [BrowserLocalServer] }
private struct InputBody: Encodable { let screen: String?; let events: [BrowserInput] }
private struct HoldBody: Encodable { let screen: String? }
private struct HistoryBody: Encodable { let action: BrowserHistoryAction; let screen: String? }
private struct ViewportBody: Encodable { let width: Int; let height: Int; let scale: Double; let mobile: Bool; let screen: String? }
private struct FillBody: Encodable { let token: String; let screen: String? }

/// Where to navigate a tab, and from which screen: the target's one field beside `screen`.
private struct NavigateBody: Encodable {
    let target: BrowserTarget
    let screen: String?

    private enum CodingKeys: String, CodingKey { case screen }

    func encode(to encoder: Encoder) throws {
        try target.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(screen, forKey: .screen)
    }
}

/// What a tab's stream asks of the Mac's screencast: JPEG quality, frames a second, an optional cap on the frame's
/// size in pixels (a slow link asks for less), and the frame pixels per CSS pixel the screen shows (`scale`, its device
/// pixels — times the zoom of a page this phone zoomed, BrowserPageZoom.streamScale; docs/browser-v0.md §5,
/// 2026-10-03 — a Mac from before ignores it and sends CSS-size frames).
public struct BrowserStreamOptions: Sendable, Equatable {
    public let quality: Int
    public let fps: Int
    public let maxWidth: Int?
    public let maxHeight: Int?
    public let scale: Double?

    /// The most `scale` the Mac takes: 8 since the page zoom (browser-v0 §1 页面缩放, 2026-10-03: a 3× screen at 200%
    /// shows 6 frame pixels a CSS pixel), 3 before — a Mac from then cuts a larger ask to 3, and the zoomed page still
    /// shows, short of the screen's pixels.
    public static let maxScale = 8.0

    public init(quality: Int, fps: Int, maxWidth: Int? = nil, maxHeight: Int? = nil, scale: Double? = nil) {
        self.quality = min(max(quality, 1), 100)
        self.fps = min(max(fps, 1), 30)
        self.maxWidth = maxWidth.map { min(max($0, 100), 8192) }
        self.maxHeight = maxHeight.map { min(max($0, 100), 8192) }
        self.scale = scale.map { min(max($0, 1), Self.maxScale) }
    }

    public var query: [URLQueryItem] {
        let scaled = scale.flatMap { $0 > 1 ? URLQueryItem(name: "scale", value: String(format: "%g", ($0 * 100).rounded() / 100)) : nil }
        return [URLQueryItem(name: "quality", value: String(quality)), URLQueryItem(name: "fps", value: String(fps))]
            + [maxWidth.map { URLQueryItem(name: "maxWidth", value: String($0)) }, maxHeight.map { URLQueryItem(name: "maxHeight", value: String($0)) }, scaled].compactMap { $0 }
    }
}

extension AgentSwitchAPI {
    /// Whether Chrome is up and the tabs by owner. A Mac without the browser (an older one, or `AGENTSWITCH_BROWSER_HOST=0`)
    /// answers 404.
    public func browserTabs() async throws -> BrowserTabList { try await get(["browser", "tabs"]) }

    public func browserTab(_ id: String) async throws -> BrowserTabInfo { (try await get(["browser", "tabs", id]) as TabEnvelope).tab }

    /// A new tab of yours; a refusal (403), a missing file (404) or an address the Mac cannot read (400) carries its
    /// reason in words.
    public func openBrowserTab(_ target: BrowserTarget) async throws -> BrowserTabInfo {
        (try await send("POST", ["browser", "tabs"], body: target) as TabEnvelope).tab
    }

    public func closeBrowserTab(_ id: String) async throws {
        let _: OKReply = try await perform("DELETE", ["browser", "tabs", id], query: [], body: nil)
    }

    /// Input, in order (at most 50 events a request). A tab held by another screen, or an agent's tab not taken over,
    /// answers 409.
    public func sendBrowserInput(_ id: String, _ events: [BrowserInput], screen: String?) async throws {
        guard !events.isEmpty else { return }
        let _: OKReply = try await post(["browser", "tabs", id, "input"], body: InputBody(screen: screen, events: Array(events.prefix(BrowserInputQueue.batch))))
    }

    public func navigateBrowserTab(_ id: String, to target: BrowserTarget, screen: String?) async throws -> BrowserTabInfo {
        (try await post(["browser", "tabs", id, "navigate"], body: NavigateBody(target: target, screen: screen)) as TabEnvelope).tab
    }

    public func browserHistory(_ id: String, _ action: BrowserHistoryAction, screen: String?) async throws -> BrowserTabInfo {
        (try await post(["browser", "tabs", id, "navigate"], body: HistoryBody(action: action, screen: screen)) as TabEnvelope).tab
    }

    /// This screen takes the tab over (from whoever had it); an agent's calls on it wait meanwhile.
    public func takeBrowserTab(_ id: String, screen: String?) async throws -> BrowserTabInfo {
        (try await post(["browser", "tabs", id, "take"], body: HoldBody(screen: screen)) as TabEnvelope).tab
    }

    /// Hands it back; the size goes back to the Mac's default. Another screen's hold answers 409.
    public func releaseBrowserTab(_ id: String, screen: String?) async throws -> BrowserTabInfo {
        (try await post(["browser", "tabs", id, "release"], body: HoldBody(screen: screen)) as TabEnvelope).tab
    }

    /// The holder's size for the tab (the phone's: its screen area in points, mobile layout); 409 unless held here.
    public func setBrowserViewport(_ id: String, width: Int, height: Int, scale: Double, mobile: Bool, screen: String?) async throws -> BrowserTabInfo {
        let body = ViewportBody(width: min(max(width, 200), 4096), height: min(max(height, 200), 4096), scale: min(max(scale, 0.5), 4),
                                mobile: mobile, screen: screen)
        return (try await post(["browser", "tabs", id, "viewport"], body: body) as TabEnvelope).tab
    }

    /// The servers listening on the Mac, for the new-tab sheet.
    public func browserServers() async throws -> [BrowserLocalServer] { (try await get(["browser", "servers"]) as ServerList).servers }

    /// The speed of the link to the Mac in megabits a second (`GET /browser/speed`, browser-v0 §5): `bytes` that do not
    /// compress, timed from the first chunk (BrowserSpeed.Meter), for at most `limit`. Nil when too little came to tell,
    /// or the Mac has no such route (an older one answers 404).
    public func browserSpeed(bytes: Int = BrowserSpeed.bytes, limit: Duration = BrowserSpeed.limit) async -> Double? {
        guard let endpoint = try? await endpoints.endpoint() else { return nil }
        let req = request("GET", endpoint, ["browser", "speed"], query: [URLQueryItem(name: "bytes", value: String(bytes))], body: nil,
                          accept: "application/octet-stream", timeout: Self.seconds(limit) + 5)
        let clock = ContinuousClock()
        let began = clock.now
        let meter = LockedBox(BrowserSpeed.Meter())
        let transport = self.transport
        let reading = Task { () -> Bool in
            let (response, body) = try await transport.stream(req)
            guard (200..<300).contains(response.statusCode) else { return false }
            for try await chunk in body {
                let at = Self.seconds(began.duration(to: clock.now))
                meter.withLock { $0.add(chunk.count, at: at) }
            }
            // A cancelled read ends its chunks quietly: cut short, not complete.
            return !Task.isCancelled
        }
        let timer = Task {
            try? await Task.sleep(for: limit)
            reading.cancel()
        }
        let complete = (try? await reading.value) ?? false
        timer.cancel()
        if !complete {
            let now = Self.seconds(began.duration(to: clock.now))
            meter.withLock { $0.cut(at: now) }
        }
        return meter.withLock { $0.mbps }
    }

    private static func seconds(_ d: Duration) -> Double { Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18 }

    /// A saved ciphertext into the field that has the focus; the gate checks it against the page's site and only the
    /// Mac sees the value. Only on a person's own tab, and only into a password or one-time-code field (the Mac's 409
    /// and 400 carry the reason in words). False: this Mac cannot fill yet — its fill route is missing (404) while the
    /// tab itself is there; a 404 for a tab that is gone is thrown as such (`BrowserClosedReason.closed`'s words).
    @discardableResult
    public func fillBrowserTab(_ id: String, token: String, screen: String?) async throws -> Bool {
        do {
            let _: OKReply = try await post(["browser", "tabs", id, "fill"], body: FillBody(token: token, screen: screen))
            return true
        } catch APIError.http(status: 404, message: _) {
            do {
                _ = try await browserTab(id)
            } catch APIError.http(status: 404, message: _) {
                throw APIError.http(status: 404, message: BrowserClosedReason.closed.said)
            }
            return false
        }
    }

    /// A tab's picture and what happens to it: `tab`, then frames and changes. Frames are the newest only twice over:
    /// the Mac sends at the rate asked for, and a frame the page has not read yet when the next comes is dropped
    /// (BrowserEventBuffer), so nothing piles up behind a page that draws slowly. On a dropped connection it says
    /// `dropped` and connects again, backing off (the Mac starts each connection with the tab as it is and its latest
    /// frame). Ends after `closed`, or with `closed` when the tab no longer exists.
    public func browserEvents(_ id: String, options: BrowserStreamOptions, policy: ReconnectPolicy = .standard) -> AsyncThrowingStream<BrowserEvent, Error> {
        let buffer = BrowserEventBuffer()
        let worker = Task {
            var failures = 0
            while !Task.isCancelled {
                do {
                    let (ended, delivered) = try await followBrowserOnce(id, options: options, policy: policy) { buffer.push($0) }
                    if ended { break }
                    failures = delivered ? 0 : failures + 1
                } catch is CancellationError {
                    break
                } catch let error as APIError where error.isNetworkFailure {
                    failures += 1
                } catch APIError.http(let status, _) where status == 404 {
                    buffer.push(.closed(.closed))
                    break
                } catch {
                    buffer.finish(throwing: error)
                    return
                }
                guard !Task.isCancelled else { break }
                buffer.push(.dropped)
                try? await Task.sleep(for: policy.delay(afterFailures: max(failures, 1)))
            }
            buffer.finish()
        }
        buffer.whenCancelled { worker.cancel() }
        let lifetime = BrowserStreamLifetime(worker)
        return AsyncThrowingStream {
            withExtendedLifetime(lifetime) {}
            return try await buffer.next()
        }
    }

    /// One connection: (closed, anything delivered).
    private func followBrowserOnce(_ id: String, options: BrowserStreamOptions, policy: ReconnectPolicy,
                                   deliver: (BrowserEvent) -> Void) async throws -> (Bool, Bool) {
        let endpoint = try await endpoints.endpoint()
        let req = request("GET", endpoint, ["browser", "tabs", id, "stream"], query: options.query, body: nil, accept: "text/event-stream",
                          timeout: policy.idleTimeout)
        var delivered = false
        do {
            let (response, body) = try await transport.stream(req)
            if !(200..<300).contains(response.statusCode) {
                var data = Data()
                for try await chunk in body where data.count < 64 * 1024 { data.append(chunk) }
                try AgentSwitchAPI.check(data, response)
            }
            var parser = SSEParser()
            for try await chunk in Self.idleGuarded(body, limit: .milliseconds(Int64(policy.idleTimeout * 1000))) {
                for message in parser.feed(chunk) {
                    guard let event = BrowserEvent.parse(event: message.event, data: message.data) else { continue }
                    delivered = true
                    deliver(event)
                    if case .closed = event { return (true, true) }
                }
            }
        } catch let error as APIError where error.isNetworkFailure {
            await endpoints.reportFailure(endpoint)
            if delivered { return (false, true) }
            throw error
        }
        return (false, delivered)
    }
}
