# SwiftTerm, vendored

SwiftTerm 1.18.0 from https://github.com/migueldeicaza/SwiftTerm at `7691f85b222a67a66b58499e1b2647443cf0dda7` (MIT,
`LICENSE`): only the library target (`Sources/SwiftTerm`). The first commit that added it (`chore(mac): vendor SwiftTerm
1.18.0 unchanged`) is upstream as it was; everything after it is listed here. The iPhone app uses the upstream package.

## An input method's marked text (2026-09-30)

docs/terminal-v0.md §1 Mac, "输入法的未上屏文字". Upstream shows marked text (Pinyin's `zhong` before it becomes 中) in a
floating `NSTextField` with padding and a translucent rounded background next to the block caret, which stays on screen,
and `firstRect(forCharacterRange:actualRange:)` always answers the caret's cell, so the candidate window does not follow
the text. The state involved (`markedTextStorage`, `markedSelectedRange`, `markedTextOverlay`, `kittyIsComposing`,
`caretView`) is private or internal, so a subclass cannot change it cleanly.

- `Mac/MarkedTextView.swift` (new): draws the marked text as the terminal draws text — on the cell grid at the cursor,
  a wide character centred over two cells on the rows' baseline, opaque over the cells beneath; a thin underline under
  all of it and a thick one under the clause being converted; a 2 pt caret at the input method's insertion point.
- `Mac/MacTerminalView.swift`:
  - `updateMarkedTextOverlay()` places a `MarkedTextView` on the cursor's cell (pulled left at the right edge) and hides
    the block caret while there is marked text, restoring it after;
  - `firstRect(forCharacterRange:actualRange:)` answers the cell of the character asked about inside the marked text
    (the cursor's cell when there is none);
  - `selectedRange()` answers the input method's own selection while it composes.

## Implicit links across unwrapped rows (2026-10-01)

docs/terminal-v0.md §1 链接. Upstream joins a row with the next one for implicit link detection (a path an app broke
across rows itself) when the upper row reaches within a fifth of the width of the right edge. A plain long line did:
a path printed on a 97-column line in a 106-column screen became `…/crt.htmlsee docs/ui-v0.` with the next line, and
⌘-click found no such file.

- `Terminal.swift`, `canJoinImplicitRows`: the upper row must reach within a twentieth of the edge (at least 2 columns),
  as a row an app filled by breaking a long path does.

To take a newer SwiftTerm: replace `Sources/SwiftTerm` with its library sources, then apply the changes above again (or
drop them once upstream draws marked text inline and joins rows more strictly).
