import XCTest

/// docs/design-rules.md, the part a machine can hold (user #451: 写一个严格的设计规范，开发的时候自动遵守): the app's
/// views take their colours and corners from `Look`, and add no small grey explanations. What was written before the
/// rules stays as a number that may only go down; a new one fails here until it uses a name — or, if it is right,
/// until the rules and this number are changed together, with the reason.
final class DesignRulesTests: XCTestCase {
    private static let sources: [(path: String, text: String)] = {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/AgentSwitchMac")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        return files.map { ($0.path.replacingOccurrences(of: root.path + "/", with: ""), (try? String(contentsOf: $0, encoding: .utf8)) ?? "") }
    }()

    private func count(_ pattern: String, except: Set<String> = []) -> (total: Int, where: [String]) {
        let regex = try! NSRegularExpression(pattern: pattern)
        var total = 0, places: [String] = []
        for (path, text) in Self.sources where !except.contains(path) {
            // Comments are not code.
            let code = text.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            let n = regex.numberOfMatches(in: code, range: NSRange(code.startIndex..., in: code))
            if n > 0 { total += n; places.append("\(path) ×\(n)") }
        }
        return (total, places.sorted())
    }

    func testTheSourcesWereFound() {
        XCTAssertGreaterThan(Self.sources.count, 50)
    }

    /// §1.1: no colour is written as a number in a page; they have names in `Look` and `Color`.
    func testNoNewColourIsWrittenAsANumber() {
        let found = count(#"Color\(white:|Color\(red:|NSColor\(red|NSColor\(white|\.rgb\(0x|Color\(hex"#,
                          except: ["Shared/DispatchStyle.swift", "Components.swift", "MainWindow/PageContainer.swift"])
        XCTAssertLessThanOrEqual(found.total, Self.rawColours, "a colour written as a number; use a name from Look (docs/design-rules.md §1): \(found.where)")
    }

    /// §3.1: corners are `Look.controlRadius`, `cardRadius`, `bubbleRadius` (and `panelRadius`), not a number of one's own.
    func testNoNewCornerIsWrittenAsANumber() {
        let found = count(#"cornerRadius: [0-9]"#, except: ["Shared/DispatchStyle.swift"])
        XCTAssertLessThanOrEqual(found.total, Self.rawCorners, "a corner written as a number; use Look's (docs/design-rules.md §3): \(found.where)")
    }

    /// §5.2: no small grey explanation under a control (user #361: 这种小字说明完全没有必要).
    func testNoNewSmallExplanation() {
        let found = count(#"\bFooter\("#)
        XCTAssertLessThanOrEqual(found.total, Self.footers, "a small explanation under a group; say it in the docs instead (docs/design-rules.md §5): \(found.where)")
    }

    // What stood on 2026-11-26. Lower these as the old ones are cleaned up; never raise them without the rules.
    private static let rawColours = 36
    private static let rawCorners = 32
    private static let footers = 39
}
