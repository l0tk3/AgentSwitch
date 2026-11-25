import AgentSwitchMacCore
import AppKit
import SwiftUI

/// A run of an answer's prose — paragraphs, headings, list items, quotes, rules — as one text the pointer can select
/// across (2026-10-14, user: 我复制的时候一次只能选一行，怎么拖都不行). SwiftUI's selectable texts each keep a selection
/// to themselves, so an answer drawn a `Text` a block could be copied only a block at a time. Here AppKit lays the run
/// out (TextKit 1), set as MarkdownBlocks set its blocks — a quote's bar and a rule drawn under the text; code and
/// tables stay views of their own (MarkdownBlocks), with their own selection and `Copy`.
struct ProseText: NSViewRepresentable {
    let blocks: [DispatchMarkdownBlock]
    let size: CGFloat
    let color: Color
    let lineSpacing: CGFloat
    let blockSpacing: CGFloat

    func makeNSView(context: Context) -> ProseTextView { ProseTextView() }

    func updateNSView(_ view: ProseTextView, context: Context) {
        view.set(ProseTextView.Content(blocks: blocks, size: size, color: color, lineSpacing: lineSpacing,
                                       blockSpacing: blockSpacing, classic: InterfaceLook.current.isClassic))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nsView.fitted(within: 10_000) }
        return CGSize(width: width, height: nsView.height(for: width))
    }
}

/// The text of a ProseText: selectable, not editable, no ground of its own, laid out to the width SwiftUI gives it.
final class ProseTextView: NSTextView {
    /// What the text is made from. Compared as given (the SwiftUI colour, not an AppKit one made from it, which is a
    /// new object each time): the same content is not set again, so a record's updates leave a selection alone.
    struct Content: Equatable {
        let blocks: [DispatchMarkdownBlock]
        let size: CGFloat
        let color: Color
        let lineSpacing: CGFloat
        let blockSpacing: CGFloat
        /// The look in force: the colours are the look's.
        let classic: Bool
    }

    private var content: Content?

    init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        setAccessibilityRole(.staticText)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
    }

    func set(_ new: Content) {
        guard new != content else { return }
        content = new
        rebuild()
    }

    /// The colours are resolved for the appearance the text is drawn in: set again when it changes.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        rebuild()
    }

    /// A quote's bar beside its lines, a rule across: drawn under the text, in the colours of the appearance in force.
    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        guard let layoutManager, let textContainer, let storage = textStorage, storage.length > 0 else { return }
        let whole = NSRange(location: 0, length: storage.length)
        // Where the words of a range are: its lines' used parts, without the spacing under them.
        func lines(_ range: NSRange) -> NSRect {
            let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            var box = NSRect.null
            layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in box = box.union(used) }
            return box.isNull ? .zero : box
        }
        storage.enumerateAttribute(Self.quote, in: whole) { value, range, _ in
            guard value != nil else { return }
            let box = lines(range)
            NSColor(Look.faint).setFill()
            NSRect(x: 0, y: box.minY, width: 2, height: box.height).fill()
        }
        storage.enumerateAttribute(Self.rule, in: whole) { value, range, _ in
            guard value != nil else { return }
            let box = lines(range)
            NSColor(Look.line).setFill()
            NSRect(x: 0, y: box.midY.rounded(.down), width: bounds.width, height: 1).fill()
        }
    }

    static let quote = NSAttributedString.Key("AgentSwitchProseQuote")
    static let rule = NSAttributedString.Key("AgentSwitchProseRule")

    /// The wheel is the column's: the text has no scroller of its own.
    override func scrollWheel(with event: NSEvent) {
        if let nextResponder { nextResponder.scrollWheel(with: event) } else { super.scrollWheel(with: event) }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if let textContainer, textContainer.containerSize.width != newSize.width {
            textContainer.containerSize = NSSize(width: newSize.width, height: .greatestFiniteMagnitude)
        }
    }

    /// The height the text takes at `width` (the container is left at the view's own width afterwards).
    func height(for width: CGFloat) -> CGFloat {
        guard let layoutManager, let textContainer else { return 0 }
        textContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let height = ceil(layoutManager.usedRect(for: textContainer).height)
        if frame.width > 0, frame.width != width {
            textContainer.containerSize = NSSize(width: frame.width, height: .greatestFiniteMagnitude)
        }
        return height
    }

    /// Its own width and height when nothing is proposed: the longest line, up to `within`.
    func fitted(within width: CGFloat) -> CGSize {
        guard let layoutManager, let textContainer else { return .zero }
        textContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        return CGSize(width: ceil(used.width), height: ceil(used.height))
    }

    private func rebuild() {
        guard let content else { return }
        var text = NSAttributedString()
        var link = NSColor.linkColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            text = Self.attributed(content)
            link = Self.resolved(NSColor(Color.signal))
        }
        linkTextAttributes = [.foregroundColor: link, .cursor: NSCursor.pointingHand]
        // The same words in other colours (the appearance changed): the selection stays where it was.
        let selection = selectedRange()
        textStorage?.setAttributedString(text)
        if NSMaxRange(selection) <= text.length { setSelectedRange(selection) }
        invalidateIntrinsicContentSize()
    }

    /// A dynamic colour as it is in the appearance in force.
    private static func resolved(_ color: NSColor) -> NSColor { NSColor(cgColor: color.cgColor) ?? color }

    // MARK: the text

    /// The blocks as one text: each block a paragraph (its own line breaks kept as paragraphs of it), `blockSpacing`
    /// after a block's last line, `lineSpacing` between lines — as MarkdownBlocks' VStack and Texts set them.
    static func attributed(_ c: Content) -> NSAttributedString {
        let ink = resolved(NSColor(c.color)), quiet = resolved(NSColor(Look.ink2))
        let wash = resolved(NSColor(Look.ink)).withAlphaComponent(0.07)
        let body = NSFont.systemFont(ofSize: c.size)
        let out = NSMutableAttributedString()
        for (n, block) in c.blocks.enumerated() {
            let start = out.length
            var first = 0.0, rest = 0.0, before = 0.0
            var mark: NSAttributedString.Key?
            var tabs: [NSTextTab] = []
            switch block {
            case .heading(let level, let text):
                let font = NSFont.systemFont(ofSize: level == 1 ? c.size + 3 : level == 2 ? c.size + 1 : c.size, weight: .semibold)
                out.append(inline(text, font: font, color: ink, wash: wash))
                before = 2
            case .paragraph(let text):
                out.append(inline(text, font: body, color: ink, wash: wash))
            case .listItem(let depth, let ordinal, let text):
                let marker = ordinal.map { "\($0)." } ?? "•"
                let markerFont = NSFont.monospacedDigitSystemFont(ofSize: c.size, weight: .regular)
                let width = (marker as NSString).size(withAttributes: [.font: markerFont]).width
                first = Double(depth) * 16
                rest = first + Double(ceil(width)) + 6
                tabs = [NSTextTab(textAlignment: .left, location: rest)]
                out.append(NSAttributedString(string: marker + "\t", attributes: [.font: markerFont, .foregroundColor: quiet]))
                out.append(inline(text, font: body, color: ink, wash: wash))
            case .quote(let text):
                // The bar (2 pt) and 8 pt to the words, as MarkdownBlocks' HStack.
                first = 10
                rest = 10
                mark = ProseTextView.quote
                out.append(inline(text, font: body, color: quiet, wash: wash))
            case .rule:
                mark = ProseTextView.rule
                out.append(NSAttributedString(string: "\u{00A0}", attributes: [.font: NSFont.systemFont(ofSize: 1)]))
            case .code, .table:
                continue   // views of their own (MarkdownBlocks)
            }
            let last = n == c.blocks.count - 1
            if !last { out.append(NSAttributedString(string: "\n", attributes: [.font: body])) }
            // Each paragraph of the block: the first starts at the marker, the others under the text; only the
            // block's last has the space after it.
            let string = out.string as NSString
            var at = start
            while at < out.length {
                let paragraph = string.paragraphRange(for: NSRange(location: at, length: 0))
                let style = NSMutableParagraphStyle()
                style.lineSpacing = c.lineSpacing
                style.firstLineHeadIndent = at == start ? first : rest
                style.headIndent = rest
                style.tabStops = tabs
                style.paragraphSpacingBefore = at == start ? before : 0
                let blockEnds = NSMaxRange(paragraph) >= out.length
                // TextKit puts the line spacing under a paragraph's last line too: the block's space is what is left.
                style.paragraphSpacing = blockEnds && !last ? max(0, c.blockSpacing - c.lineSpacing) : 0
                out.addAttribute(.paragraphStyle, value: style, range: paragraph)
                at = NSMaxRange(paragraph)
            }
            if let mark { out.addAttribute(mark, value: true, range: NSRange(location: start, length: out.length - start)) }
        }
        return out
    }

    /// One block's inline Markdown (DispatchMarkdown.inline: web links only) in AppKit's attributes: bold, italic,
    /// struck through, code in the fixed-width face on the code wash, links.
    static func inline(_ text: String, font: NSFont, color: NSColor, wash: NSColor) -> NSAttributedString {
        let parsed = DispatchMarkdown.inline(text)
        let out = NSMutableAttributedString()
        let fonts = NSFontManager.shared
        for run in parsed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var face = intent.contains(.code) ? NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular) : font
            if intent.contains(.stronglyEmphasized) { face = fonts.convert(face, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { face = fonts.convert(face, toHaveTrait: .italicFontMask) }
            var attributes: [NSAttributedString.Key: Any] = [.font: face, .foregroundColor: color]
            if intent.contains(.code) { attributes[.backgroundColor] = wash }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return out
    }
}
