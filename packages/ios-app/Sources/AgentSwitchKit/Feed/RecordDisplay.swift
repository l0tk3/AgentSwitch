import Foundation

/// How the simple view words a session's record (docs/simple-view-v0.md §2, §5): a run of work as one line, each step's
/// label, how full the context is, the mode. Short English words in title case (ui-v0 §7.2.7).
public enum RecordDisplay {
    /// What a picture is, by its first bytes: the extension the system's viewer opens it by (`png` when unknown).
    public static func pictureExtension(_ data: Data) -> String {
        let head = [UInt8](data.prefix(12))
        func starts(_ bytes: [UInt8], at offset: Int = 0) -> Bool { head.count >= offset + bytes.count && Array(head[offset..<(offset + bytes.count)]) == bytes }
        if starts([0xFF, 0xD8, 0xFF]) { return "jpg" }
        if starts([0x47, 0x49, 0x46, 0x38]) { return "gif" }
        if starts([0x52, 0x49, 0x46, 0x46]), starts([0x57, 0x45, 0x42, 0x50], at: 8) { return "webp" }
        if starts([0x66, 0x74, 0x79, 0x70], at: 4) { return "heic" }
        return "png"
    }

    /// A run of work on one line: `Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 1`, the kinds in the order they
    /// first came. Thinking and updates of the task list are not counted. `running`: it is the one still going.
    public static func summary(_ item: RecordItem, running: Bool = false) -> String {
        var counts: [(String, Int)] = []
        for step in item.steps {
            guard let word = counted(step.kind) else { continue }
            if let i = counts.firstIndex(where: { $0.0 == word }) { counts[i].1 += 1 } else { counts.append((word, 1)) }
        }
        let lead = running ? "Working" : "Worked"
        let head = item.seconds > 0 ? "\(lead) \(duration(item.seconds))" : lead
        return ([head] + counts.map { word, n in "\(plural(word, n)) \(n)" }).joined(separator: " · ")
    }

    private static func counted(_ kind: RecordStep.Kind) -> String? {
        switch kind {
        case .read: "Read"
        case .search: "Searched"
        case .list: "Listed"
        case .run: "Ran"
        case .edit, .write: "Edited"
        case .web: "Web"
        case .agent: "Agent"
        case .tool: "Tool"
        case .todo, .think: nil
        }
    }

    private static func plural(_ word: String, _ n: Int) -> String {
        n > 1 && (word == "Agent" || word == "Tool") ? word + "s" : word
    }

    /// `8s`, `1m 12s`, `1h 03m`.
    public static func duration(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h \(String(format: "%02d", s % 3600 / 60))m"
    }

    /// A clock for what is going on now: `0:41`, `12:05`, `1:02:25`.
    public static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return s < 3600 ? "\(s / 60):\(String(format: "%02d", s % 60))" : "\(s / 3600):\(String(format: "%02d", s % 3600 / 60)):\(String(format: "%02d", s % 60))"
    }

    /// Lines in and out over a run's steps; nil when it changed no file.
    public static func stat(_ steps: [RecordStep]) -> (added: Int, removed: Int)? {
        let added = steps.reduce(0) { $0 + ($1.added ?? 0) }, removed = steps.reduce(0) { $0 + ($1.removed ?? 0) }
        return steps.contains { $0.added != nil || $0.removed != nil } ? (added, removed) : nil
    }

    /// What a step is, before what it worked on: `Read`, `Run`, or the tool's own name.
    public static func label(_ step: RecordStep) -> String {
        switch step.kind {
        case .read: "Read"
        case .search: "Search"
        case .list: "List"
        case .run: "Run"
        case .edit: "Edit"
        case .write: "Write"
        case .web: "Web"
        case .agent: "Agent"
        case .todo: "Tasks"
        case .think: "Thought"
        case .tool: step.tool.map { $0.isEmpty ? "Tool" : $0 } ?? "Tool"
        }
    }

    /// A kind of step as a small picture before its line, in the classic look (the pixel look says it in its word): one
    /// picture, one kind (2026-10-07, user, of Codex's own app: 这种小图标…能不能加上). The system's symbol names.
    public static func symbol(_ kind: RecordStep.Kind) -> String {
        switch kind {
        case .read: "doc.text"
        case .search: "magnifyingglass"
        case .list: "folder"
        case .run: "terminal"
        case .edit: "pencil"
        case .write: "doc.badge.plus"
        case .web: "globe"
        case .agent: "arrow.triangle.branch"
        case .todo: "checklist"
        case .think: "sparkle"   // not a brain: it stood out of the line (2026-10-07, user: 这个脑子太突兀了)
        case .tool: "wrench.and.screwdriver"
        }
    }

    /// The picture for what the agent is doing now, by the tool it uses: the one a step of that kind has. None while
    /// it uses no tool — at work, and no more to say: the star that stood there read as another product's mark
    /// (2026-10-07, user: Work提示的星星图标去掉吧，看上去像是gemini，work这个动作就别加图标了).
    public static func toolSymbol(_ tool: String?) -> String? {
        guard let tool else { return nil }
        switch ToolDisplay.word(tool) {
        case "Run": return symbol(.run)
        case "Read": return symbol(.read)
        case "Edit": return symbol(.edit)
        case "Search": return symbol(.search)
        case "Web": return symbol(.web)
        case "Agents": return symbol(.agent)
        case "Plan": return symbol(.todo)
        case "Compact": return compactSymbol
        default: return symbol(.tool)
        }
    }

    /// It compacts its context (docs/simple-view-v0.md §5.7): two arrows meeting, for that alone.
    public static let compactSymbol = "arrow.down.right.and.arrow.up.left"

    /// The steps a run shows when opened: its thinking only in the verbose transcript.
    public static func shown(_ steps: [RecordStep], verbose: Bool) -> [RecordStep] {
        verbose ? steps : steps.filter { $0.kind != .think }
    }

    /// How full the context is: `62%` when the record says how much it holds, else the tokens in it (`238k`).
    public static func context(_ usage: RecordUsage?) -> String? {
        guard let used = usage?.used, used > 0 else { return nil }
        if let window = usage?.window, window > 0 { return "\(min(100, Int((Double(used) / Double(window) * 100).rounded())))%" }
        return used >= 1_000_000 ? String(format: "%.1fM", Double(used) / 1_000_000) : "\(max(1, Int((Double(used) / 1000).rounded())))k"
    }

    /// The agent's own word for how it asks, as the screens say it; nil for one this app does not know.
    public static func mode(_ raw: String?) -> String? {
        switch raw {
        case "default", "manual", "untrusted": "Ask"
        case "acceptEdits": "Edits"
        case "plan": "Plan"
        case "auto": "Auto"
        case "bypassPermissions", "bypass": "Bypass"
        case "dontAsk": "Don't Ask"
        case "on-request": "On Request"
        case "on-failure": "On Failure"
        case "never": "Never Ask"
        default: nil
        }
    }

    /// The task list on one line: how many are done, and the one in progress (else the next).
    public static func plan(_ plan: [PlanEntry]) -> (done: Int, total: Int, now: String)? {
        guard !plan.isEmpty else { return nil }
        let now = plan.first { $0.state == .doing } ?? plan.first { $0.state == .todo }
        return (plan.filter { $0.state == .done }.count, plan.count, now?.text ?? "")
    }

    /// A tool's kind by its name alone, for a record read coarsely (OpenCode, pi, an older Mac).
    public static func coarseKind(_ tool: String) -> RecordStep.Kind {
        switch tool.lowercased() {
        case "read", "view", "cat", "notebookread": .read
        case "grep", "glob", "search", "find", "rg": .search
        case "ls", "list": .list
        case "bash", "shell", "exec", "run", "local_shell", "exec_command", "commandexecution": .run
        case "edit", "multiedit", "patch", "apply_patch", "notebookedit", "filechange": .edit
        case "write": .write
        case "webfetch", "websearch", "web_search", "fetch": .web
        case "task", "agent": .agent
        case "todowrite", "todoread", "update_plan": .todo
        default: .tool
        }
    }
}

extension RecordDisplay {
    /// Characters of a long answer shown before `Show More`, and how long one is before it is folded at all.
    public static let previewChars = 1600
    public static let foldChars = 2400

    /// The start of a long text, cut where a paragraph ends when one does near the limit, with a code fence left open
    /// by the cut closed; nil when the text is short enough to show whole.
    public static func preview(_ text: String, fold: Int = foldChars, keep: Int = previewChars) -> String? {
        guard text.count > fold else { return nil }
        var head = String(text.prefix(keep))
        if let cut = head.range(of: "\n\n", options: .backwards), head.distance(from: head.startIndex, to: cut.lowerBound) > keep / 2 {
            head = String(head[..<cut.lowerBound])
        } else if let cut = head.lastIndex(of: "\n"), head.distance(from: head.startIndex, to: cut) > keep / 2 {
            head = String(head[..<cut])
        }
        let fences = head.components(separatedBy: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        return fences % 2 == 1 ? head + "\n```" : head
    }
}

extension RecordDisplay {
    /// Claude Code's command for another model, typed as a reply: `/model opus`. A model id is letters, digits and
    /// `. _ : / [ ] -` (what the Mac lists); anything else is left out, so nothing after it reads as more input.
    public static func modelCommand(_ model: String) -> String {
        "/model " + String(model.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._:/[]-".unicodeScalars.contains($0) })
    }

    /// The command that opens an agent's own model picker, typed for the user who then chooses on its screen.
    public static func modelPicker(_ harness: String) -> String { harness == "opencode" ? "/models" : "/model" }

    /// The model a terminal is on, as far as anything says: what the agent last reported, else the model of its last
    /// answer in the record, else the one it was started with.
    public static func model(now: String?, record: String?, started: String?) -> String? { now ?? record ?? started }

    /// Which of the listed models is the one in use: by its id, else by the name people read (`opus` is listed for
    /// `claude-opus-5-5`, both read "Opus 5.5").
    public static func isCurrent(_ option: TerminalModelOption, model: String?) -> Bool {
        guard let model else { return false }
        return option.id == model || option.name == ModelName.display(model)
    }
}
