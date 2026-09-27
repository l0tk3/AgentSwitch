import Foundation

/// Model ids as people say them (docs/ui-v0.md §1.5): `claude-opus-5-5` → `Opus 5.5`, `gpt-6-luna` → `GPT-6 Luna`,
/// `deepseek/deepseek-flash` → `DeepSeek Flash`. The id itself is still what gets saved.
public enum ModelName {
    /// Brand spellings for a leading token; anything else is capitalised.
    static let brands = ["deepseek": "DeepSeek", "qwen": "Qwen", "glm": "GLM", "kimi": "Kimi", "gemini": "Gemini",
                         "grok": "Grok", "llama": "Llama", "mistral": "Mistral", "minimax": "MiniMax"]

    public static func display(_ id: String) -> String {
        var rest = id.trimmingCharacters(in: .whitespaces)
        guard !rest.isEmpty else { return id }
        var context = ""
        if let range = rest.range(of: #"\[\d+[kKmM]\]$"#, options: .regularExpression) {
            context = " (" + rest[range].dropFirst().dropLast().uppercased() + ")"
            rest.removeSubrange(range)
        }
        if let slash = rest.lastIndex(of: "/") { rest = String(rest[rest.index(after: slash)...]) }
        let tokens = rest.split(separator: "-").map(String.init).filter { !isDate($0) && $0.lowercased() != "latest" }
        guard let first = tokens.first?.lowercased() else { return id }
        let name: String
        switch first {
        case "claude": name = claude(Array(tokens.dropFirst()))
        case "gpt": name = gpt(Array(tokens.dropFirst()))
        default:
            if first.range(of: #"^o\d"#, options: .regularExpression) != nil { return id }
            name = words([brands[first] ?? capitalised(tokens[0])] + tokens.dropFirst().map(capitalised))
        }
        return name.isEmpty ? id : name + context
    }

    /// `opus-5-5` (current) and `3-5-sonnet` (older ids): family first, then the numbers as one version.
    private static func claude(_ tokens: [String]) -> String {
        let family = tokens.filter { !isNumber($0) }.map(capitalised)
        let version = tokens.filter(isNumber).joined(separator: ".")
        return (family + (version.isEmpty ? [] : [version])).joined(separator: " ")
    }

    /// `6-luna` → `GPT-6 Luna`, `5.6-sol` → `GPT-5.6 Sol`, `4o-mini` → `GPT-4o Mini`.
    private static func gpt(_ tokens: [String]) -> String {
        guard let version = tokens.first else { return "GPT" }
        return (["GPT-" + version] + tokens.dropFirst().map(capitalised)).joined(separator: " ")
    }

    /// Neighbouring numbers are one version: `gemini-2-5-pro` → `Gemini 2.5 Pro`.
    private static func words(_ tokens: [String]) -> String {
        var out: [String] = []
        for token in tokens {
            if isNumber(token), let last = out.last, isNumber(last) {
                out[out.count - 1] = last + "." + token
            } else {
                out.append(token)
            }
        }
        return out.joined(separator: " ")
    }

    private static func capitalised(_ token: String) -> String {
        guard let first = token.first, first.isLowercase else { return token }
        return first.uppercased() + token.dropFirst()
    }

    private static func isNumber(_ token: String) -> Bool {
        !token.isEmpty && token.allSatisfy { $0.isNumber || $0 == "." } && token.first!.isNumber
    }

    /// `20251001`: a snapshot date, not part of the name.
    private static func isDate(_ token: String) -> Bool {
        token.count == 8 && token.allSatisfy(\.isNumber)
    }
}

/// Harness names from the daemon's catalog (`claude-code`, `codex`, `opencode`) as the products call themselves.
public enum HarnessName {
    public static func display(_ name: String) -> String {
        switch name.lowercased() {
        case "claude-code", "claude": return Harness.claude.title
        case "codex": return Harness.codex.title
        case "opencode": return Harness.opencode.title
        default: return name
        }
    }
}

/// Paths under the home folder start with `~` (docs/ui-v0.md §1.5).
public enum DisplayPath {
    public static func short(_ path: String, home: String) -> String {
        let home = home.hasSuffix("/") ? String(home.dropLast()) : home
        guard !home.isEmpty else { return path }
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }
}

/// Times as docs/ui-v0.md §4 writes them: 刚刚, 3 分钟前, 今天 14:20, 昨天 09:05, 9月20日, 2025年9月20日.
public enum TimeText {
    /// A moment: relative within the hour, then the day and the time.
    public static func moment(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 && seconds > -60 { return "刚刚" }
        if seconds > 0 && seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        let time = clock(date, calendar: calendar)
        if calendar.isDate(date, inSameDayAs: now) { return "今天 \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天 \(time)"
        }
        return "\(day(date, now: now, calendar: calendar)) \(time)"
    }

    /// A day: 今天, 昨天, 9月20日, or with the year when it is not this year.
    public static func day(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "今天" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天"
        }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let monthDay = "\(parts.month ?? 0)月\(parts.day ?? 0)日"
        return calendar.component(.year, from: now) == parts.year ? monthDay : "\(parts.year ?? 0)年\(monthDay)"
    }

    /// A clock time, with the day when it is not today: 12:30, 明天 09:00, 昨天 18:05, 9月30日 12:30.
    public static func at(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let time = clock(date, calendar: calendar)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "明天 \(time)"
        }
        return "\(day(date, now: now, calendar: calendar)) \(time)"
    }

    /// `2026-09-25T06:20:00Z` (the `built=` of VERSIONS) as a moment, or the text unchanged when it is not a date.
    public static func build(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        FlexibleDate.parse(iso).map { moment($0, now: now, calendar: calendar) } ?? iso
    }

    private static func clock(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}
