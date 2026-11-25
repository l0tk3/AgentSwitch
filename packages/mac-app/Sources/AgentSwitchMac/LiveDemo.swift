#if DEBUG
import AgentSwitchMacCore
import Foundation

/// `-liveDemo YES` (debug builds): the menu bar's Live Activity alone, answering from made-up work instead of the
/// service — nothing else of the app starts (no lock, no daemon), so it runs beside an installed AgentSwitch.
/// Two terminals work; another asks at 4 s, one's turn ends at 14 s, a second request comes at 20 s; allowing and
/// denying act on it as the service would.
final class LiveDemoTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let start = Date()
    private var answered: [String: Date] = [:]

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        var body: Any = ["ok": true]
        if request.httpMethod == "POST" {
            let json = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            _ = json
            let id = path.split(separator: "/").last.map(String.init) ?? ""
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
        /// `doing`: the capsule's word; a row that asks says `Allow?`, as the service does.
        func row(_ id: String, _ title: String, _ step: String, doing: String = "Run", model: String = "Claude Code", agent: String = "claude-code",
                 since: Date, ask: Any = NSNull()) -> [String: Any] {
            ["id": id, "kind": "terminal", "title": title, "step": step, "doing": ask is NSNull ? doing : "Allow?",
             "model": model, "agent": agent, "startedAt": ms(since), "needsYou": !(ask is NSNull), "ask": ask]
        }
        func end(_ id: String, _ title: String, _ line: String, at: Date) -> [String: Any] {
            ["kind": "terminal", "id": id, "title": title, "line": line, "ok": true, "at": ms(at)]
        }
        var rows: [[String: Any]] = []
        var ended: [[String: Any]] = []
        if t >= 4, answered["p1"] == nil {
            rows.append(row("k1", "fix-login", "Bash: npm test -- --watch=false", since: start.addingTimeInterval(4),
                            ask: ["kind": "permission", "id": "p1", "tool": "Bash", "target": "npm test -- --watch=false", "where": "~/Projects/web"]))
        }
        if t >= 20 {
            if let at = answered["p2"] {
                if now.timeIntervalSince(at) < 4 {
                    rows.append(row("k7", "清理旧构建", "Bash: rm -rf build", model: "Codex", agent: "codex", since: start.addingTimeInterval(20)))
                } else {
                    ended.append(end("k7", "清理旧构建", "删掉了 build/ 里的旧产物，腾出 3.2 GB。", at: at.addingTimeInterval(4)))
                }
            } else {
                rows.append(row("k7", "清理旧构建", "Bash: rm -rf build", model: "Codex", agent: "codex", since: start.addingTimeInterval(20),
                                ask: ["kind": "permission", "id": "p2", "tool": "Bash", "target": "rm -rf build", "where": "~/Projects/web"]))
            }
        }
        // `-liveDemoChurn YES`: the work changes its step and its word every five seconds, for as long as it runs — what a
        // terminal at work does with every tool call — so what each change costs the app can be watched from outside.
        let churn = UserDefaults.standard.bool(forKey: "liveDemoChurn") ? Int(t / 5) + 2 : 0
        rows.append(row("k3", "修 AgentSwitch 的 bug", "Bash: npx vitest run tests/projects.test.ts", doing: churn % 2 == 1 ? "Working" : "Run",
                        since: start.addingTimeInterval(-640)))
        if churn > 0 {
            rows.append(row("k2", "AgentSwitch", churn % 2 == 1 ? "Edit host.ts" : "Bash: npm test", doing: churn % 2 == 1 ? "Edit" : "Run",
                            since: start.addingTimeInterval(-900)))
        }
        if t < 14 {
            rows.append(row("k4", "整理下载目录", "Bash: ls ~/Downloads", model: "OpenCode", agent: "opencode", since: start.addingTimeInterval(-40)))
        } else {
            ended.append(end("k4", "整理下载目录", "下载目录整理好了，一共四十二个文件，重复的放进了“重复”文件夹。", at: start.addingTimeInterval(14)))
        }
        ended = ended.filter { now.timeIntervalSince1970 * 1000 - ($0["at"] as? Double ?? 0) < 60_000 }
        ended.sort { ($0["at"] as? Double ?? 0) > ($1["at"] as? Double ?? 0) }
        let waiting = rows.filter { $0["needsYou"] as? Bool == true }.count
        return ["rows": rows, "running": rows.count - waiting, "waiting": waiting, "ended": ended, "now": ms(now)]
    }
}
#endif
