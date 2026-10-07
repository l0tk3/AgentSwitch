import Foundation

/// How hard an agent thinks, as the screens offer and say it (docs/terminal-v0.md §1 思考强度, 2026-10-07; user:
/// 新建终端和当前的模型选择页面都没有思考强度的选择，能不能根据各个 agent 客户端和模型适配一下). Each agent has its own word for it
/// and its own levels, which differ by model; the Mac lists them (what the agent itself says), and the screens offer
/// only those.
public enum EffortDisplay {
    /// The agent's own word for it, as the control's label: Claude Code's effort, Codex's reasoning, OpenCode's variant
    /// of a model, pi's thinking.
    public static func word(_ harness: String) -> String {
        switch harness {
        case "codex": "Reasoning"
        case "opencode": "Variant"
        case "pi": "Thinking"
        default: "Effort"
        }
    }

    /// A level as people read it: `xhigh` → `XHigh`, `low` → `Low`.
    public static func name(_ level: String) -> String {
        switch level {
        case "xhigh": "XHigh"
        case "": ""
        default: level.split(whereSeparator: { $0 == "-" || $0 == "_" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        }
    }

    /// The levels a terminal of this agent may be started at with this model chosen (nil or empty: none chosen, the
    /// agent's default model). Empty: nothing to choose — the model takes no level, the Mac does not list any, or (OpenCode)
    /// a variant needs its model chosen first.
    public static func levels(_ list: TerminalList?, harness: String, model: String?) -> [String] {
        guard let list else { return [] }
        guard let model, !model.isEmpty else { return list.efforts[harness] ?? [] }
        return list.models[harness]?.first { $0.id == model }?.efforts ?? []
    }

    /// The levels of the model a running terminal is on: the listed model that is it (by id, or by the name people
    /// read), else the agent's default model's.
    public static func levels(_ list: TerminalList?, harness: String, current model: String?) -> [String] {
        guard let list else { return [] }
        if let option = list.models[harness]?.first(where: { RecordDisplay.isCurrent($0, model: model) }), let own = option.efforts { return own }
        return list.efforts[harness] ?? []
    }

    /// What "default" is, when the agent says: the chosen model's own, else (none chosen) the agent's default model's.
    public static func defaultLevel(_ list: TerminalList?, harness: String, model: String?) -> String? {
        guard let list else { return nil }
        guard let model, !model.isEmpty else { return list.effortDefaults[harness] }
        return list.models[harness]?.first { $0.id == model }?.defaultEffort
    }

    /// The level kept when the model changes: the one chosen if the new model takes it, else none (its default).
    public static func kept(_ level: String, in levels: [String]) -> String { levels.contains(level) ? level : "" }

    /// The level a terminal is at, as far as anything says: one just asked for, the last turn's in its record, the one
    /// it was started at.
    public static func level(asked: String?, record: String?, started: String?) -> String? { asked ?? record ?? started }

    /// Claude Code's command for another level, typed as a reply: `/effort high`. Letters only.
    public static func command(_ level: String) -> String {
        "/effort " + String(level.unicodeScalars.filter { $0.isASCII && CharacterSet.lowercaseLetters.contains($0) })
    }

    /// The command that opens an agent's own picker for it, when it has one apart from its model picker.
    public static func picker(_ harness: String) -> String? { harness == "opencode" ? "/variants" : nil }
}
