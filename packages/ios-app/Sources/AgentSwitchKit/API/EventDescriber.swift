import Foundation

/// What is left of the task events' describer: the one piece the terminals' lines use.
public enum EventDescriber {
    /// `/bin/zsh -lc 'ps -A | head'` → `ps -A | head`: Codex wraps every command in a login shell.
    public static func unwrapShell(_ command: String) -> String {
        let pattern = #"^(?:/bin/|/usr/bin/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$"#
        guard let match = command.range(of: pattern, options: .regularExpression) else { return command }
        let inner = command[match].replacingOccurrences(of: pattern, with: "$2", options: .regularExpression)
        return inner.isEmpty ? command : inner
    }
}
