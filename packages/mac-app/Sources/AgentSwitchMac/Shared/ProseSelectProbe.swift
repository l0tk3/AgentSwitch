#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly prose-select` (debug builds): an answer of paragraphs, a list, code and a
/// quote in a scrolling column, in a window put on screen behind the others; the pointer pressed in the first
/// paragraph and over the list (2026-10-14, user: 我复制的时候一次只能选一行，怎么拖都不行). Writes `select.txt` — that the
/// pointer meets one text over both, what a selection from the one to the other holds, and that the wheel over the
/// text goes up to the column's scroller — and `select.png`, the selection.
/// Not the drag itself: a window behind the others takes no presses, and a probe does not bring the app forward.
@MainActor
enum ProseSelectProbe {
    static let answer = """
    第一段：这是回答的开头，说明要做什么。
    这一行在同一段里，换了行。

    - 第一项：`codex-beta` 已装好。
    - 第二项：**重启**以后生效。
      1. 里面的一步
    - 第三项：看 [说明](https://example.com/notes)。

    > 引用的一句。
    > 引用的第二行。

    ---

    ## 小标题

    列表后面的一段。

    ```bash
    echo 代码块
    ```

    代码块后面的一段，单独一块。
    """

    static func run(into dir: URL) async throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var lines: [String] = []
        let long = answer + "\n\n" + Array(repeating: "后面还有很多段落，让这一栏能滚动。", count: 40).joined(separator: "\n\n")
        let host = NSHostingView(rootView: ScrollView {
            MarkdownBlocks(text: long, size: 13.5, lineSpacing: 4, blockSpacing: 8).padding(20)
        }
        .frame(width: 640, height: 420)
        .background(Color(nsColor: .dispatchGround)))
        host.frame = NSRect(x: 0, y: 0, width: 640, height: 420)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: 40, y: 40))
        window.orderBack(nil)
        try await Task.sleep(for: .seconds(1))

        let texts = views(ProseTextView.self, in: host)
        lines.append("prose texts: \(texts.count) (code is its own view; the column's tail is one more)")
        guard let first = texts.first, let layout = first.layoutManager, let container = first.textContainer else {
            lines.append("FAIL no ProseTextView")
            try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("select.txt"), atomically: true, encoding: .utf8)
            return
        }
        // What the pointer meets over the first paragraph, and over the list.
        let string = first.string as NSString
        let end = string.range(of: "以后生效").location + 2
        func point(_ index: Int) -> NSPoint {
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
            return first.convert(NSPoint(x: rect.midX, y: rect.midY), to: nil)
        }
        // hitTest takes a point in the superview's space: the window's, for the window's content.
        let at = [point(1), point(end)].map { host.hitTest($0) }
        lines.append("\(at.allSatisfy { $0 === first } ? "ok  " : "FAIL") the pointer over the first paragraph and over the second list item meets the same text: \(at.map { $0.map { String(describing: type(of: $0)) } ?? "nothing" })")
        // A drag from the one to the other selects what lies between in that text; set as the drag would set it (a
        // background window takes no presses, and a probe does not bring the app forward).
        first.setSelectedRange(NSRange(location: 1, length: end - 1))
        let selected = string.substring(with: first.selectedRange())
        // What ⌘C takes is the selection's text (not tried here: it would go on the user's pasteboard, and a window in
        // the background writes none).
        lines.append("\(selected.contains("这一行") && selected.contains("第一项") && selected.contains("第二项") ? "ok  " : "FAIL") selected across the paragraph's two lines and two list items: \(selected.replacingOccurrences(of: "\n", with: "⏎"))")
        try DesignPreview.write(host, to: dir.appendingPathComponent("select.png"))
        // The wheel over the text goes up the responder chain (ProseTextView.scrollWheel) to the column's scroller.
        var chain: [String] = [], responder: NSResponder? = first.nextResponder, reaches = false
        while let next = responder {
            chain.append(String(describing: type(of: next)))
            if next is NSScrollView { reaches = true; break }
            responder = next.nextResponder
        }
        lines.append("\(reaches ? "ok  " : "FAIL") the wheel over the text reaches the column's scroller: \(chain.joined(separator: " → "))")
        try lines.joined(separator: "\n").write(to: dir.appendingPathComponent("select.txt"), atomically: true, encoding: .utf8)
        window.close()
    }

    private static func views<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
    }
}
#endif
