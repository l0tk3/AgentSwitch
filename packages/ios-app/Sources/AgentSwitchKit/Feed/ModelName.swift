import Foundation

/// Model and executor ids as people say them (docs/ui-v0.md §1.5): `claude-opus-5-5` → Opus 5.5,
/// `deepseek/deepseek-flash` → DeepSeek Flash, `gpt-6-luna` → GPT-6 Luna, `claude-code` → Claude Code.
public enum ModelName {
    private static let brands: [String: String] = [
        "deepseek": "DeepSeek", "gpt": "GPT", "qwen": "Qwen", "glm": "GLM", "kimi": "Kimi", "gemini": "Gemini",
        "llama": "Llama", "mistral": "Mistral", "grok": "Grok", "o3": "o3", "o4": "o4",
    ]

    public static func display(_ id: String) -> String {
        var name = id.split(separator: "/").last.map(String.init) ?? id
        var suffix = ""
        if name.hasSuffix("[1m]") { name.removeLast(4); suffix = " 1M" }
        let parts = name.split(separator: "-").map(String.init)
        // claude-<family>-<major>-<minor>[-<date>]
        if parts.first == "claude", parts.count >= 3 {
            let family = parts[1].prefix(1).uppercased() + parts[1].dropFirst()
            let numbers = parts.dropFirst(2).filter { $0.count <= 2 && Int($0) != nil }
            return ([family, numbers.joined(separator: ".")].filter { !$0.isEmpty }.joined(separator: " ")) + suffix
        }
        // gpt-6-luna → GPT-6 Luna; gpt-5.5 → GPT-5.5
        if parts.first == "gpt", parts.count >= 2 {
            let rest = parts.dropFirst(2).map(capitalized)
            return (["GPT-\(parts[1])"] + rest).joined(separator: " ") + suffix
        }
        return parts.map { brands[$0.lowercased()] ?? capitalized($0) }.joined(separator: " ") + suffix
    }

    public static func harness(_ id: String) -> String {
        switch id {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        case "pi": return "pi"
        case "echo": return "Echo"
        default: return capitalized(id)
        }
    }

    private static func capitalized(_ word: String) -> String {
        word.prefix(1).uppercased() + word.dropFirst()
    }
}

extension TargetRef {
    /// "Opus 5.5 · Claude Code": a choice of model in a menu.
    public var displayName: String { "\(ModelName.display(model)) · \(ModelName.harness(harness))" }
}
