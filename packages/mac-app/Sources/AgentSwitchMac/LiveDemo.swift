#if DEBUG
import AgentSwitchMacCore
import Foundation

/// `-liveDemo YES` (debug builds): the menu bar's Live Activity alone, answering from made-up work instead of the
/// service — nothing else of the app starts (no lock, no gate, no daemon), so it runs beside an installed AgentSwitch.
/// Two tasks run; a terminal asks at 4 s, one task ends at 14 s, a question with options comes at 20 s; allowing,
/// denying and picking act on it as the service would.
final class LiveDemoTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let start = Date()
    private var answered: [String: Date] = [:]

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        var body: Any = ["ok": true]
        if request.httpMethod == "POST" {
            let json = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            let id = json["approval_id"] as? String ?? path.split(separator: "/").last.map(String.init) ?? ""
            lock.withLock { answered[id] = Date() }
            if path == "/local/console-link" { body = ["path": "/ui"] }
        } else if path == "/live" {
            body = snapshot(at: Date())
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    private func snapshot(at now: Date) -> [String: Any] {
        let t = now.timeIntervalSince(start)
        let answered = lock.withLock { self.answered }
        func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
        func row(_ id: String, _ kind: String, _ title: String, _ step: String, model: Any = NSNull(), agent: Any = NSNull(),
                 since: Date, ask: Any = NSNull()) -> [String: Any] {
            ["id": id, "kind": kind, "title": title, "step": step, "model": model, "agent": agent, "startedAt": ms(since),
             "needsYou": !(ask is NSNull), "ask": ask]
        }
        var rows: [[String: Any]] = []
        var ended: [[String: Any]] = []
        if t >= 4, answered["p1"] == nil {
            rows.append(row("k1", "terminal", "fix-login", "Bash: npm test -- --watch=false", model: "Claude Code", agent: "claude-code",
                            since: start.addingTimeInterval(4),
                            ask: ["kind": "permission", "id": "p1", "tool": "Bash", "target": "npm test -- --watch=false", "where": "~/Projects/web"]))
        }
        if t >= 20 {
            if let at = answered["a2"] {
                if now.timeIntervalSince(at) < 4 {
                    rows.append(row("t7", "task", "清理旧构建", "运行 rm -rf build", since: start.addingTimeInterval(20)))
                } else {
                    ended.append(["taskId": "t7", "title": "清理旧构建", "line": "删掉了 build/ 里的旧产物，腾出 3.2 GB。", "ok": true, "at": ms(at.addingTimeInterval(4))])
                }
            } else {
                rows.append(row("t7", "task", "清理旧构建", "build/ 里有 3.2 GB 旧产物，要删掉吗？", since: start.addingTimeInterval(20),
                                ask: ["kind": "question", "id": "a2", "questionId": "q0", "text": "build/ 里有 3.2 GB 旧产物，要删掉吗？",
                                      "options": ["删掉", "保留"], "answerable": true]))
            }
        }
        rows.append(row("t1", "task", "修 AgentSwitch 的 bug", "第 2 步：运行 npx vitest run tests/projects.test.ts", model: "Opus 5.5",
                        since: start.addingTimeInterval(-640)))
        if t < 14 {
            rows.append(row("t2", "task", "整理下载目录", "已交给 DeepSeek Flash", model: "DeepSeek Flash", since: start.addingTimeInterval(-40)))
        } else {
            ended.append(["taskId": "t2", "title": "整理下载目录", "line": "下载目录整理好了，一共四十二个文件，重复的放进了“重复”文件夹。", "ok": true,
                          "at": ms(start.addingTimeInterval(14))])
        }
        ended = ended.filter { now.timeIntervalSince1970 * 1000 - ($0["at"] as? Double ?? 0) < 60_000 }
        ended.sort { ($0["at"] as? Double ?? 0) > ($1["at"] as? Double ?? 0) }
        let waiting = rows.filter { $0["needsYou"] as? Bool == true }.count
        return ["rows": rows, "running": rows.count - waiting, "waiting": waiting, "ended": ended, "now": ms(now)]
    }
}
#endif
