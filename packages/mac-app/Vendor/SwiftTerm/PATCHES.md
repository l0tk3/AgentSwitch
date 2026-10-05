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

## The cell a link was clicked in (2026-10-02)

docs/terminal-v0.md §1 链接, "折行的路径". `requestOpenLink` hands the delegate the link's text only, and an agent's screen
breaks a long path over indented lines, so the app reads the lines around the click itself (`WrappedPath`). The view's
mapping from a mouse event to a cell (columns, rows from the top of the scrollback, BiDi rows) is internal.

- `Mac/MacTerminalView.swift`: `calculateMouseHit(with:)` is `public` (unchanged otherwise).

## Colours of drawn cells (2026-10-03)

docs/app-v0.md §4 "省电". The CoreGraphics draw path keeps a cache of the CGColors it draws text and backgrounds with
(`cachedCGColor`: on macOS 26 and later every NSColor → CGColor conversion evaluates the display's EDR headroom), but
the cells it draws itself did not use it: each box-drawing cell copied its NSColor and converted it twice, each block
element converted it for every shade, each Powerline glyph once. Agents' screens draw rules and boxes across the whole
width (Claude Code's input box), so a redraw did hundreds of conversions.

- `Apple/AppleTerminalView.swift`: `drawBlockElements`, `drawBoxDrawings` and `drawPowerlineGlyphs` take the cached
  CGColor (a shade's alpha by `CGColor.copy(alpha:)`).
- `Apple/BoxDrawingRenderer.swift`: `draw(… cgColor: …)` beside `draw(… color: …)`, which now calls it.

## Rows drawn again only when they changed (2026-10-05)

docs/app-v0.md §4 省电. The terminal's update range is one span, from the first row touched to the last, and moving the
cursor touches a row. Claude Code's status line (recorded from a session at work: about eleven pieces of output a
second) homes the cursor, goes down to its row, writes a glyph and a word, and parks the cursor on the last row: of 110
pieces, 107 marked all 46 rows, and the Core Graphics view drew the whole screen each time, though 1.4 rows had changed
on average. Each row's line already counts its changes (`BufferLine.generation`, kept for the Metal renderer).

- `Apple/RowRedraw.swift` (new): by screen row, the line last sent to be drawn and its counter then; `runs(in:…)` gives
  the runs of rows in a range whose line is another one or has changed, or that were asked for outright.
- `Terminal.swift`: `refresh(startRow:endRow:)` and `updateFullScreen()` also keep the rows they were called for
  (`getForcedUpdateRange()`, `forceUpdate(startLine:endLine:)`, cleared with the update range): the views call them
  when what changed is not in the cells (colours, reverse video), and those rows are drawn whatever their counters say.
  The same for a link's highlight (`invalidateLinkHighlightRow` in `Apple/AppleTerminalView.swift`) and for Kitty
  placements removed (`KittyGraphics.swift`), which marked their rows without going through `refresh`.
- `Apple/AppleTerminalView.swift`, `updateDisplay`, macOS with Core Graphics: `setNeedsDisplay` for each run (with the
  rows shaped along with it, and upstream's rect for a span of rows) instead of once for the whole range; nothing when
  no row changed. The whole range, as upstream, while the screen is scrolled back or Kitty placements exist (they are
  drawn from a table of their own). The Metal path is as it was.
- `Mac/MacTerminalView.swift`: the view's `rowRedraw`.
- `Tests/AgentSwitchPatchTests` (new; `swift test` in this folder, upstream's own tests are not vendored): the runs for
  the recorded status line, rows apart, rows asked for outright, scrolling, another size, a link's highlight; and, drawing a screen only
  where the view asks, pixel for pixel the screen drawn whole after each of 1600 pieces of mixed output (text, erasing,
  scrolling, regions, the other screen, palette and default colours, reverse video).

To take a newer SwiftTerm: replace `Sources/SwiftTerm` with its library sources, then apply the changes above again (or
drop them once upstream draws marked text inline and joins rows more strictly, draws these cells from its colour
cache, and sends only changed rows to be drawn).
