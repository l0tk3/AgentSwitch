import Foundation

/// The shared browser's routes on this Mac's local API (127.0.0.1, local token; docs/browser-v0.md §5). Each request is
/// sent once (an open must not open twice); errors as the Dispatch routes report them: the daemon's own words for a
/// refusal (`DaemonError.reason`), `notSupported` when the daemon has no browser (turned off, or older).
extension DaemonClient: BrowserService {
    public func browserTabs() async throws -> BrowserTabList {
        try decode(BrowserTabList.self, try await dispatchCall("GET", "/browser/tabs", timeout: BrowserTimeouts.request))
    }

    public func openTab(_ target: BrowserTarget) async throws -> BrowserTab {
        try decode(BrowserTabReply.self, try await dispatchCall("POST", "/browser/tabs", json: target, timeout: BrowserTimeouts.open)).tab
    }

    public func closeTab(id: String) async throws {
        _ = try await dispatchCall("DELETE", "/browser/tabs/\(Self.segment(id))", timeout: BrowserTimeouts.request)
    }

    public func sendInput(tabId: String, events: [BrowserInputEvent], screen: String) async throws {
        guard !events.isEmpty else { return }
        struct Body: Encodable { let screen: String; let events: [BrowserInputEvent] }
        for batch in stride(from: 0, to: events.count, by: BrowserInputEvent.maxEvents).map({ Array(events[$0..<min($0 + BrowserInputEvent.maxEvents, events.count)]) }) {
            _ = try await dispatchCall("POST", "/browser/tabs/\(Self.segment(tabId))/input", json: Body(screen: screen, events: batch),
                                       timeout: BrowserTimeouts.request)
        }
    }

    public func navigate(tabId: String, to target: BrowserTarget, screen: String) async throws -> BrowserTab {
        try await tabCall(tabId, "navigate", BrowserScreenBody(screen: screen, target: target))
    }

    public func history(tabId: String, _ action: BrowserHistoryAction, screen: String) async throws -> BrowserTab {
        struct Body: Encodable { let action: BrowserHistoryAction; let screen: String }
        return try await tabCall(tabId, "navigate", Body(action: action, screen: screen))
    }

    public func takeOver(tabId: String, screen: String) async throws -> BrowserTab {
        try await tabCall(tabId, "take", BrowserScreenBody(screen: screen))
    }

    public func handBack(tabId: String, screen: String) async throws -> BrowserTab {
        try await tabCall(tabId, "release", BrowserScreenBody(screen: screen))
    }

    public func setViewport(tabId: String, _ viewport: BrowserViewportRequest, screen: String) async throws -> BrowserTab {
        struct Body: Encodable { let width: Int; let height: Int; let scale: Double; let mobile: Bool; let screen: String }
        return try await tabCall(tabId, "viewport", Body(width: viewport.width, height: viewport.height, scale: viewport.scale,
                                                         mobile: viewport.mobile, screen: screen))
    }

    public func localServers() async throws -> [BrowserLocalServer] {
        try decode(BrowserServerList.self, try await dispatchCall("GET", "/browser/servers", timeout: BrowserTimeouts.servers)).servers
    }

    public func fill(tabId: String, token: String, screen: String) async throws -> BrowserFillResult {
        struct Body: Encodable { let token: String; let screen: String }
        let route = "/browser/tabs/\(Self.segment(tabId))/fill"
        return try decode(BrowserFillResult.self, try await dispatchCall("POST", route, json: Body(token: token, screen: screen),
                                                                          timeout: BrowserTimeouts.fill))
    }

    public func showTab(id: String) async throws {
        _ = try await dispatchCall("POST", "/browser/tabs/\(Self.segment(id))/show", json: [String: String](), timeout: BrowserTimeouts.request)
    }

    public func tabPreview(id: String) async throws -> Data {
        try await dispatchCall("GET", "/browser/tabs/\(Self.segment(id))/preview", timeout: BrowserTimeouts.request)
    }

    private func tabCall<B: Encodable>(_ id: String, _ route: String, _ body: B) async throws -> BrowserTab {
        try decode(BrowserTabReply.self, try await dispatchCall("POST", "/browser/tabs/\(Self.segment(id))/\(route)", json: body,
                                                                timeout: BrowserTimeouts.request)).tab
    }

    // MARK: the stream

    public func tabStream(id: String, options: BrowserStreamOptions) -> AsyncThrowingStream<BrowserStreamEvent, Error> {
        tabStream(id: id, options: options, policy: .standard)
    }

    /// The stream with its own reconnect timing (tests use a fast one).
    public func tabStream(id: String, options: BrowserStreamOptions, policy: DispatchReconnectPolicy) -> AsyncThrowingStream<BrowserStreamEvent, Error> {
        let streamer = (transport as? DispatchStreamingTransport) ?? URLSessionChunkTransport.shared
        let client = self
        let (stream, sink) = AsyncThrowingStream<BrowserStreamEvent, Error>.makeStream()
        let worker = Task {
            var failures = 0
            while !Task.isCancelled {
                do {
                    switch try await client.followTab(id: id, options: options, policy: policy, streamer: streamer, deliver: { sink.yield($0) }) {
                    case .closed:
                        sink.finish()
                        return
                    case .dropped(let delivered):
                        failures = delivered ? 0 : failures + 1
                    }
                } catch is CancellationError {
                    break
                } catch let error as DaemonError where error.isNetworkFailure {
                    failures += 1
                } catch {
                    sink.finish(throwing: error)
                    return
                }
                try? await Task.sleep(for: policy.delay(afterFailures: max(failures, 1)))
            }
            sink.finish()
        }
        sink.onTermination = { _ in worker.cancel() }
        return stream
    }

    enum BrowserFollowResult: Equatable {
        /// `closed` arrived: the tab is gone (or Chrome, or the service is stopping).
        case closed
        /// The connection ended early; connect again.
        case dropped(delivered: Bool)
    }

    /// One connection's worth of the stream.
    func followTab(id: String, options: BrowserStreamOptions, policy: DispatchReconnectPolicy, streamer: DispatchStreamingTransport,
                   deliver: (BrowserStreamEvent) -> Void) async throws -> BrowserFollowResult {
        let route = "/browser/tabs/\(Self.segment(id))/stream"
        let request = try dispatchRequest("GET", route + "?" + options.query, accept: "text/event-stream", timeout: policy.idleTimeout)
        var delivered = false
        do {
            let (response, body) = try await streamer.stream(request)
            if !(200..<300).contains(response.statusCode) {
                var data = Data()
                for try await chunk in body where data.count < 64 * 1024 { data.append(chunk) }
                _ = try Self.dispatchCheck(data, response, route: "GET \(route)")
            }
            var parser = BrowserSSEParser()
            for try await chunk in Self.idleGuarded(body, limit: .milliseconds(Int64(policy.idleTimeout * 1000))) {
                for message in parser.feed(chunk) {
                    guard let event = BrowserStreamEvent.decode(event: message.event, data: message.data) else { continue }
                    delivered = true
                    deliver(event)
                    if case .closed = event { return .closed }
                }
            }
        } catch {
            let mapped = dispatchTransportError(error)
            if let failure = mapped as? DaemonError, failure.isNetworkFailure, delivered { return .dropped(delivered: true) }
            throw mapped
        }
        return .dropped(delivered: delivered)
    }
}

/// `{screen}`, with a target's one field beside it for a navigation.
private struct BrowserScreenBody: Encodable {
    let screen: String
    var target: BrowserTarget?

    func encode(to encoder: Encoder) throws {
        try target?.encode(to: encoder)
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(screen, forKey: AnyKey("screen"))
    }
}

/// URLSession's response body handed over as it arrives, a chunk per delivery (not a byte at a time): a tab's frames
/// are a few megabytes a second. Loopback only, never through a system proxy; cancelling the consumer cancels the
/// request.
public final class URLSessionChunkTransport: NSObject, DispatchStreamingTransport, URLSessionDataDelegate, @unchecked Sendable {
    public static let shared = URLSessionChunkTransport()

    private struct Entry {
        var head: CheckedContinuation<HTTPURLResponse, Error>?
        let sink: AsyncThrowingStream<Data, Error>.Continuation
    }

    private let lock = NSLock()
    private var entries: [Int: Entry] = [:]
    private var session: URLSession?

    override public init() {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForResource = 7 * 24 * 3600
        config.urlCache = nil
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }

    public func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        guard let session else { throw DaemonError.unreachable("no session") }
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        let task = session.dataTask(with: request)
        sink.onTermination = { _ in task.cancel() }
        let response: HTTPURLResponse = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (head: CheckedContinuation<HTTPURLResponse, Error>) in
                lock.withLock { entries[task.taskIdentifier] = Entry(head: head, sink: sink) }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
        return (response, body)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let head = lock.withLock { () -> CheckedContinuation<HTTPURLResponse, Error>? in
            let head = entries[dataTask.taskIdentifier]?.head
            entries[dataTask.taskIdentifier]?.head = nil
            return head
        }
        if let http = response as? HTTPURLResponse {
            head?.resume(returning: http)
            completionHandler(.allow)
        } else {
            head?.resume(throwing: DaemonError.unreachable("非 HTTP 响应"))
            completionHandler(.cancel)
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let sink = lock.withLock { entries[dataTask.taskIdentifier]?.sink }
        sink?.yield(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let entry = lock.withLock { entries.removeValue(forKey: task.taskIdentifier) }
        guard let entry else { return }
        let mapped = error.map(URLSessionStreamTransport.mapped)
        if let head = entry.head { head.resume(throwing: mapped ?? DaemonError.unreachable("连接已关闭")) }
        entry.sink.finish(throwing: mapped)
    }
}
