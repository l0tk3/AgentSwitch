import Foundation

/// A tool call said as people say it (2026-09-25; ported from the iPhone Kit's ToolDisplay): the tool as a verb and the
/// one thing it works on in the process list ("运行 git log -n 3", "浏览器 · 打开 https://…"), and its input field by
/// field when the call is opened. The three executors name tools differently: Claude `Bash`,
/// `mcp__playwright__browser_click`; Codex `commandExecution`, `playwright.browser_click`; OpenCode `bash`,
/// `playwright_browser_click`.
public enum DispatchToolDisplay {
    /// The list line of a `tool_call` event's payload.
    public static func line(_ payload: DispatchJSON) -> String {
        let label = label(payload["tool"]?.string ?? "?")
        guard let target = target(payload) else { return label }
        return "\(label) \(target)"
    }

    public static func label(_ tool: String) -> String {
        if let verb = verbs[tool] ?? verbs[tool.lowercased()] { return verb }
        let (server, name) = split(tool)
        guard let server else { return tool }
        if server == "playwright" || name.hasPrefix("browser_") {
            let action = String(name.dropFirst(name.hasPrefix("browser_") ? 8 : 0))
            return "浏览器 · \(browser[action] ?? action)"
        }
        if server.contains("secret") { return secret[name] ?? "密文 · \(name)" }
        return "\(server) · \(name)"
    }

    /// The tool in one short word, for the compact island (assistant-v0 §4, 2026-10-01: what it is doing instead of a
    /// clock); title case as ui-v0 §7.2.7.
    public static func word(_ tool: String) -> String {
        if let word = words[tool] ?? words[tool.lowercased()] { return word }
        let (server, name) = split(tool)
        if server == "playwright" || name.hasPrefix("browser_") { return "Web" }
        if server?.contains("secret") == true { return "Sealed" }
        return "Tool"
    }

    private static let words: [String: String] = [
        "bash": "Run", "shell": "Run", "commandexecution": "Run", "exec_command": "Run", "local_shell": "Run",
        "read": "Read", "view": "Read", "notebookread": "Read",
        "write": "Edit", "edit": "Edit", "multiedit": "Edit", "filechange": "Edit", "apply_patch": "Edit", "patch": "Edit", "notebookedit": "Edit",
        "grep": "Search", "glob": "Search", "list": "Search", "ls": "Search",
        "webfetch": "Web", "websearch": "Web", "web_search": "Web",
        "task": "Agents", "agent": "Agents", "subagent": "Agents",
        "todowrite": "Plan", "update_plan": "Plan", "skill": "Skill", "askuserquestion": "Answer",
        // Not a tool: what a terminal is doing while its agent compacts its context (docs/simple-view-v0.md §5.7).
        "compact": "Compact",
    ]

    /// The one thing a call works on: its command (without Codex's shell wrapper), page, file, pattern or query.
    public static func target(_ payload: DispatchJSON) -> String? {
        if let command = payload["command"]?.string ?? payload["input"]?["command"]?.string {
            return clip(DispatchEventDescriber.unwrapShell(command))
        }
        let input = payload["input"]
        for key in targetKeys {
            if let value = input?[key]?.string, !value.isEmpty { return clip(value) }
        }
        if let files = input?["files"]?.array?.compactMap(\.string), !files.isEmpty { return clip(files.joined(separator: ", ")) }
        return nil
    }

    /// The input of an opened call, field by field; a plain string input is one field.
    public static func fields(_ input: DispatchJSON?) -> [(name: String, value: String)] {
        switch input {
        case .object(let fields)?:
            let keys = fields.keys.sorted { (rank($0), $0) < (rank($1), $1) }
            return keys.compactMap { key in
                guard let value = fields[key], value != .null else { return nil }
                return (key, value.string ?? value.compactText)
            }
        case .string(let text)?: return [("输入", text)]
        case nil, .null?: return []
        case let other?: return [("输入", other.compactText)]
        }
    }

    private static let verbs: [String: String] = [
        "Bash": "运行", "bash": "运行", "shell": "运行", "commandExecution": "运行",
        "Read": "读取", "read": "读取", "Write": "写入", "write": "写入",
        "Edit": "修改", "MultiEdit": "修改", "edit": "修改", "fileChange": "修改", "apply_patch": "修改", "patch": "修改",
        "NotebookEdit": "修改笔记本", "Grep": "搜索", "grep": "搜索", "Glob": "查找文件", "glob": "查找文件", "list": "列出目录",
        "WebFetch": "打开网页", "webfetch": "打开网页", "WebSearch": "网页搜索", "webSearch": "网页搜索", "websearch": "网页搜索",
        "Task": "子任务", "Agent": "子任务", "task": "子任务", "subagent": "子任务",
        "TodoWrite": "更新计划", "todowrite": "更新计划", "update_plan": "更新计划", "Skill": "使用技能", "skill": "使用技能",
        "Compact": "压缩上下文", "compact": "压缩上下文",
    ]

    private static let browser: [String: String] = [
        "navigate": "打开", "navigate_back": "后退", "click": "点击", "type": "输入", "fill_form": "填写表单", "press_key": "按键",
        "select_option": "选择", "hover": "悬停", "snapshot": "读取页面", "take_screenshot": "截图", "wait_for": "等待",
        "evaluate": "执行脚本", "tabs": "标签页", "close": "关闭", "file_upload": "上传文件", "handle_dialog": "处理弹窗",
    ]

    private static let secret: [String: String] = [
        "secret_fill": "填入密文", "secret_type": "填入密文", "secret_repair": "修复密文", "credential_repair": "修复密文",
    ]

    private static let targetKeys = ["url", "file_path", "filePath", "notebook_path", "path", "pattern", "query", "element",
                                     "description", "skill", "prompt"]

    /// Where the fields of an opened call come first: what it runs or opens, then the rest by name.
    private static func rank(_ key: String) -> Int {
        targetKeys.firstIndex(of: key).map { $0 + 1 } ?? (key == "command" ? 0 : targetKeys.count + 1)
    }

    /// `mcp__server__name`, `server.name`, `server_name` (a known server only: `apply_patch` is not one).
    private static func split(_ tool: String) -> (server: String?, name: String) {
        if tool.hasPrefix("mcp__") {
            let parts = tool.dropFirst(5).components(separatedBy: "__")
            if parts.count >= 2 { return (parts[0], parts.dropFirst().joined(separator: "__")) }
        }
        if let dot = tool.firstIndex(of: ".") { return (String(tool[..<dot]), String(tool[tool.index(after: dot)...])) }
        for server in ["playwright", "secret-gate", "secret_gate"] where tool.hasPrefix(server + "_") {
            return (server, String(tool.dropFirst(server.count + 1)))
        }
        if tool.hasPrefix("browser_") { return ("playwright", tool) }
        return (nil, tool)
    }

    private static func clip(_ text: String) -> String {
        let line = text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? text
        return line.count > 160 ? String(line.prefix(159)) + "…" : line
    }
}
