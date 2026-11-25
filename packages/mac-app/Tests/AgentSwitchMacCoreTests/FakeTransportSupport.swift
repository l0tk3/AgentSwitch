import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// Scripted HTTP for the service's routes: a handler per call and per stream, every request recorded.
final class DispatchFakeTransport: HTTPTransport, DispatchStreamingTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Int) async throws -> (Int, Data)
    typealias StreamHandler = @Sendable (URLRequest, Int) async throws -> (Int, [Data], Error?)

    private let lock = NSLock()
    private var log: [URLRequest] = []
    private var streams = 0
    private let handler: Handler
    private let streamHandler: StreamHandler?

    /// A trailing closure is the HTTP handler (`stream` has a default, `handler` does not).
    init(stream: StreamHandler? = nil, handler: @escaping Handler) {
        self.handler = handler
        self.streamHandler = stream
    }

    /// Streams answered by `stream`; other calls by `handler`.
    static func streaming(_ stream: @escaping StreamHandler,
                          handler: @escaping Handler = { _, _ in (200, Data("{}".utf8)) }) -> DispatchFakeTransport {
        DispatchFakeTransport(stream: stream, handler: handler)
    }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return log }
    /// `METHOD /path?query` of every request, in order.
    var lines: [String] { requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")\($0.url?.query.map { "?" + $0 } ?? "")" } }

    private func record(_ request: URLRequest) -> Int {
        lock.lock()
        defer { lock.unlock() }
        log.append(request)
        return log.count - 1
    }

    private func nextStream() -> Int {
        lock.lock()
        defer { lock.unlock() }
        streams += 1
        return streams - 1
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let n = record(request)
        let (status, body) = try await handler(request, n)
        return (body, Self.response(request, status))
    }

    func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        _ = record(request)
        let n = nextStream()
        guard let streamHandler else { throw DaemonError.unreachable("no stream handler") }
        let (status, chunks, failure) = try await streamHandler(request, n)
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        for chunk in chunks { sink.yield(chunk) }
        sink.finish(throwing: failure)
        return (Self.response(request, status), body)
    }

    static func response(_ request: URLRequest, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url ?? URL(string: "http://127.0.0.1")!, statusCode: status, httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": "application/json"])!
    }
}

enum DispatchFixture {
    static func json(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }

    static func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(text.utf8))
    }

    static func decode<T: Decodable>(_ type: T.Type, object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: json(object))
    }

    /// The JSON body of a request.
    static func body(_ request: URLRequest) -> [String: Any]? {
        request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }
}
