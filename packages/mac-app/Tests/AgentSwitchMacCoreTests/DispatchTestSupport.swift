import Foundation
import XCTest
@testable import AgentSwitchMacCore

/// Scripted HTTP for the Dispatch routes: a handler per call and per stream, every request recorded.
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

    /// Event streams answered by `stream`; other calls (the task check after a closed stream) by `handler`.
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

    static func task(_ id: String, _ status: String = "running", created: Int64 = 0, updated: Int64? = nil, text: String = "x",
                     thread: String? = nil, extra: [String: Any] = [:]) throws -> DispatchTask {
        var object: [String: Any] = ["id": id, "createdAt": created, "updatedAt": updated ?? created, "status": status, "task": text]
        if let thread { object["threadId"] = thread }
        object.merge(extra) { _, new in new }
        return try decode(DispatchTask.self, object: object)
    }

    static func message(_ seq: Int, _ role: String, _ text: String = "", kind: String = "reply", tasks: [String] = [],
                        ts: Int64? = nil, clientId: String? = nil, replyTo: Int? = nil) throws -> DispatchMessage {
        let object: [String: Any] = ["seq": seq, "ts": ts ?? Int64(seq * 1000), "role": role, "text": text.isEmpty ? "m\(seq)" : text,
                                     "kind": kind, "taskIds": tasks, "clientId": clientId.map { $0 as Any } ?? NSNull(),
                                     "replyTo": replyTo.map { $0 as Any } ?? NSNull()]
        return try decode(DispatchMessage.self, object: object)
    }

    static func approval(_ id: String, task: String, kind: String = "approval", status: String = "pending", action: String = "a",
                         evidence: String = "") throws -> DispatchApproval {
        try decode(DispatchApproval.self, object: ["id": id, "taskId": task, "createdAt": 1, "kind": kind, "action": action,
                                                    "evidence": evidence, "status": status])
    }

    static func event(_ seq: Int64, _ type: String, task: String = "t", ts: Int64? = nil, _ payload: [String: DispatchJSON]? = nil) -> DispatchTaskEvent {
        let fallback: [String: DispatchJSON] = type == "text" ? ["text": .string("line \(seq)")] : [:]
        return DispatchTaskEvent(taskId: task, seq: seq, ts: ts ?? seq * 1000, type: type, payload: .object(payload ?? fallback))
    }

    /// A tool call event (`input` as strings).
    static func call(_ seq: Int64, _ tool: String, _ input: [String: String] = [:], denied: Bool = false) -> DispatchTaskEvent {
        var payload: [String: DispatchJSON] = ["tool": .string(tool), "id": .string("c\(seq)"), "input": .object(input.mapValues(DispatchJSON.string))]
        if denied { payload["denied"] = .string("protected") }
        return DispatchTaskEvent(taskId: "t", seq: seq, ts: seq * 1000, type: "tool_call", payload: .object(payload))
    }

    // The iPhone Kit's fixtures (Tests/AgentSwitchKitTests/Fixtures), real daemon JSON.

    static let taskJSON = #"""
    {"id":"t_8f3a2c1d","createdAt":1790000000000,"updatedAt":1790000065000,"status":"running","task":"把 docs 里的表格整理成 CSV","cwd":"/Users/me/Library/Application Support/AgentSwitch/work/8f3a2c1d","pin":null,"needsBrowser":false,"ephemeral":true,"parentId":null,"attachments":[{"name":"shot.png","path":"in/shot.png","size":20480,"type":"image/png"}],"threadId":"th_01","exclude":[],"handoffFrom":null,"approvalPolicy":null,"harness":"claude-code","model":"sonnet","effort":null,"brief":"Convert the tables in docs/ to CSV.","decision":{"harness":"claude-code","model":"sonnet","effort":null,"brief":"Convert the tables in docs/ to CSV.","needs_browser":false,"category":null,"kind":"code-small","thread":"new","thread_confidence":0.9,"expected_size":"small","plan":"single","planner":null,"purpose":"do","risk":null,"fallbacks":[],"reason":"small file edit","confidence":0.82,"action":"redispatch","question":null},"attempts":[{"harness":"codex","model":"gpt-5.5","kind":"transport","excerpt":"app-server exited","sideEffects":{"filesChanged":0,"commandsRun":0,"approvalsGranted":0}}],"routerAsks":0,"result":null,"error":null,"routeLogId":17,"rating":null,"spoken":null,"blockCause":null,"futureField":{"anything":[1,2,3]}}
    """#

    static let taskDetailJSON = #"""
    {"id":"t_q1","createdAt":1790000000000,"updatedAt":1790000001000,"status":"waiting_approval","task":"登录后台导出报表","cwd":"/tmp/w","pin":{"harness":"opencode","model":"deepseek-flash"},"needsBrowser":true,"ephemeral":false,"parentId":null,"attachments":[],"threadId":null,"exclude":[],"handoffFrom":null,"approvalPolicy":{"mode":"manual","human":[]},"harness":null,"model":null,"effort":null,"brief":null,"decision":null,"attempts":[],"routerAsks":1,"result":null,"error":null,"routeLogId":null,"rating":null,"spoken":null,"blockCause":null,
     "approvals":[
      {"id":"ap_1","taskId":"t_q1","createdAt":1790000000500,"kind":"question","action":"用哪个账号？","evidence":"{\"source\":\"router\",\"questions\":[{\"id\":\"clarify\",\"header\":\"路由器\",\"text\":\"用哪个账号？\",\"options\":[],\"multi\":false,\"secret\":false}]}","status":"pending","resolvedAt":null,"answer":null},
      {"id":"ap_2","taskId":"t_q1","createdAt":1790000000600,"kind":"approval","action":"bash: rm -rf build","evidence":"{\"command\":\"rm -rf build\"}","status":"pending","resolvedAt":null,"answer":null}
     ]}
    """#

    static let approvalsJSON = #"""
    [{"id":"ap_9","taskId":"t_x","createdAt":1790000100000,"kind":"question","action":"选择环境","evidence":"{\"source\":\"executor\",\"questions\":[{\"id\":\"env\",\"header\":\"环境\",\"text\":\"部署到哪个环境？\",\"options\":[{\"label\":\"staging\",\"description\":\"预发\"},{\"label\":\"prod\"}],\"multi\":false},{\"id\":\"pw\",\"text\":\"数据库密码\",\"secret\":true}]}","status":"pending","resolvedAt":null,"answer":null},
     {"id":"ap_10","taskId":"t_y","createdAt":1790000200000,"kind":"approval","action":"git push --force","evidence":"not json","status":"pending","resolvedAt":null,"answer":null},
     {"id":"ap_11","taskId":"t_z","createdAt":1790000300000,"kind":"future_kind","action":"?","evidence":"","status":"brand_new","resolvedAt":null,"answer":null}]
    """#

    static let targetsJSON = #"""
    {"harnesses":{"codex":{"quota":"rate-limits","max_concurrent":2,"browser":false,"default_model":"gpt-5.5","timeout_ms":1800000,"models":{"gpt-5.5":{"cost":"high","strengths":["code"]},"gpt-5.5-mini":{"cost":"low","strengths":[],"unavailable":true}}},"claude-code":{"quota":"local-count","max_concurrent":2,"browser":true,"default_model":"sonnet","timeout_ms":1800000,"binary":"claude","models":{"sonnet":{"cost":"mid","strengths":["code","browser"],"efforts":["low","high"]},"opus":{"cost":"top","strengths":["reasoning"]}}},"opencode":{"quota":"balance","max_concurrent":1,"browser":false,"default_model":"deepseek/deepseek-flash","models":{"deepseek/deepseek-flash":{"cost":"low"},"openrouter/*":{"cost":"mid"}}}},"categories":{"security":{"description":"PoC","keywords":["CVE"],"allow":[{"harness":"codex","model":"gpt-5.5"}],"note":""}},"router":{"harness":"opencode","model":"deepseek-flash","timeout_ms":20000,"planner_timeout_ms":120000,"min_confidence":0.5,"quota_threshold":0.05,"thread_confidence":0.6,"supervisor":{},"default":{"harness":"claude-code","model":"sonnet"},"planner":null},"quota":{"codex":0.42}}
    """#

    static let threadsJSON = #"""
    [{"id":"th_01","createdAt":1790000000000,"updatedAt":1790000500000,"title":"CSV 整理","cwd":"/tmp/w","home":"/Users/me/Library/Application Support/AgentSwitch/threads/th_01","status":"open","expiresAt":null,"summary":null,"lastTarget":{"harness":"claude-code","model":"claude-sonnet-5"},"lastActivity":1790000500000,"taskCount":2,"handoffs":0},
     {"id":"th_02","createdAt":1790000000000,"updatedAt":1790000600000,"title":null,"cwd":"/tmp/w","home":"/x","status":"archived","expiresAt":1790604800000,"summary":{"title":"清理磁盘","goal":"删掉旧构建","progress":"已列出 3.2 GB","files":[],"unresolved":[],"decisions":[],"facts":[],"spoken":"x"},"lastTarget":null,"lastActivity":null,"taskCount":1,"handoffs":1}]
    """#

    /// One SSE frame of a task event, as the daemon writes it.
    static func frame(_ seq: Int, _ type: String, task: String = "t1", _ payload: [String: Any] = [:]) -> Data {
        let object: [String: Any] = ["taskId": task, "seq": seq, "ts": seq * 1000, "type": type, "payload": payload]
        return Data("id: \(seq)\nevent: \(type)\ndata: \(String(decoding: json(object), as: UTF8.self))\n\n".utf8)
    }
}
