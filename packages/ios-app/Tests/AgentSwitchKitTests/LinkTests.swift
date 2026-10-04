import XCTest
@testable import AgentSwitchKit

/// Links on the phone (docs/terminal-v0.md §1 iPhone 链接, browser-v0 §1 入口; 2026-10-03, user: 手机上现在点击和复制链接
/// 还是费劲……点击之后直接在agent switch浏览器中打开): what counts as one on a terminal's screen and in Dispatch's text,
/// where a touch lands, what a tap opens and a long press offers, and what happens when the Mac's browser cannot take it.
final class LinkTests: XCTestCase {
    /// Rows as the screen holds them: a character a cell, CJK taking two.
    private func rows(_ lines: [String]) -> [[Character]] {
        lines.map { line in
            line.flatMap { c -> [Character] in (c.unicodeScalars.first?.value ?? 0) >= 0x2E80 ? [c, TerminalLinks.wideTail] : [c] }
        }
    }

    private func span(_ row: Int, _ columns: Range<Int>) -> ScreenLink.Span { ScreenLink.Span(row: row, columns: columns) }

    // MARK: a link

    func testOnlyWebAddressesAndFilesAreLinks() {
        XCTAssertEqual(TappedLink(address: "https://example.com/a?b=1"), .web("https://example.com/a?b=1"))
        XCTAssertEqual(TappedLink(address: "HTTP://Example.com"), .web("HTTP://Example.com"))
        XCTAssertEqual(TappedLink(address: "file:///Users/me/out/a%20b.html"), .file("/Users/me/out/a b.html"))
        XCTAssertNil(TappedLink(address: "agentswitch://pair?code=1"), "the app's own scheme is never opened from output")
        XCTAssertNil(TappedLink(address: "javascript:alert(1)"))
        XCTAssertNil(TappedLink(address: "https://"), "a scheme alone")
        XCTAssertNil(TappedLink(address: "file:///"))
    }

    func testWhatATapOpensAndALongPressOffers() {
        let web = TappedLink.web("https://github.com/acme/app/pull/128")
        XCTAssertEqual(web.target, .url("https://github.com/acme/app/pull/128"))
        XCTAssertEqual(web.actions, [.openInBrowser, .copy, .openInSafari])
        XCTAssertEqual(web.actions.map { $0.label(for: web) }, ["Open in Browser", "Copy Link", "Open in Safari"])
        XCTAssertEqual(web.display, "github.com/acme/app/pull/128")
        XCTAssertEqual(LinkAction.copied(web), "Link Copied")

        let file = TappedLink.file("/Users/me/Projects/site/index.html")
        XCTAssertEqual(file.target, .path("/Users/me/Projects/site/index.html"))
        XCTAssertEqual(file.actions.map { $0.label(for: file) }, ["Open in Browser", "Copy Path"], "a file of the Mac's is not Safari's to open")
        XCTAssertEqual(file.display, "~/Projects/site/index.html")
        XCTAssertEqual(file.text, "/Users/me/Projects/site/index.html", "the whole path is what is copied")
        XCTAssertEqual(LinkAction.copied(file), "Path Copied")

        for local in ["http://localhost:5173/", "http://127.0.0.1:8080/x", "http://[::1]:3000/"] {
            XCTAssertEqual(TappedLink.web(local).actions, [.openInBrowser, .copy], "\(local) is only there on the Mac")
            XCTAssertNil(TappedLink.web(local).safari)
        }
    }

    func testWithoutTheMacsBrowserAWebAddressGoesToSafariAndSaysWhy() {
        let web = TappedLink.web("https://example.com/a"), local = TappedLink.web("http://localhost:5173/"), file = TappedLink.file("~/a.html")
        let off = LinkOpening.fallback(web, .noBrowser)
        XCTAssertEqual(off.safari?.absoluteString, "https://example.com/a")
        XCTAssertEqual(off.said, "此 Mac 上的 AgentSwitch 未提供浏览器，已在 Safari 中打开。")
        XCTAssertNil(LinkOpening.fallback(file, .noBrowser).safari)
        XCTAssertEqual(LinkOpening.fallback(file, .noBrowser).said, "此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。")
        XCTAssertEqual(LinkOpening.fallback(web, .notConnected).said, "未连接到 Mac，已在 Safari 中打开。")
        XCTAssertNil(LinkOpening.fallback(local, .notConnected).safari, "a page of the Mac's own cannot open on the phone")
        XCTAssertEqual(LinkOpening.fallback(local, .notConnected).said, "未连接到 Mac，无法在 Mac 的浏览器中打开。")
        let refused = LinkOpening.fallback(file, .refused("此路径属于凭据或 AgentSwitch 自己的数据，不能在浏览器中打开。"))
        XCTAssertNil(refused.safari)
        XCTAssertEqual(refused.said, "此路径属于凭据或 AgentSwitch 自己的数据，不能在浏览器中打开。", "the Mac's own reason")
        XCTAssertEqual(LinkOpening.fallback(web, .refused("Chrome 未能启动")).said, "Mac 未能打开此链接（Chrome 未能启动），已在 Safari 中打开。")
        XCTAssertEqual(LinkOpening.fallback(local, .refused("")).said, "Mac 未能打开此链接。")
    }

    func testHowAFailedOpenCounts() {
        let web = TappedLink.web("https://example.com"), file = TappedLink.file("/Users/me/a.html")
        XCTAssertEqual(LinkOpening.failure(APIError.http(status: 404, message: "not found"), for: web), .noBrowser, "a Mac without the route")
        XCTAssertEqual(LinkOpening.failure(APIError.http(status: 404, message: "没有这个文件"), for: file), .refused("没有这个文件"))
        XCTAssertEqual(LinkOpening.failure(APIError.http(status: 403, message: "不能打开"), for: file), .refused("不能打开"))
        XCTAssertEqual(LinkOpening.failure(APIError.unreachable, for: web), .notConnected)
        XCTAssertEqual(LinkOpening.failure(APIError.transport("timed out"), for: web), .notConnected)
    }

    // MARK: addresses and paths in text

    func testAnAddressEndsWhereTheProseGoesOn() {
        func found(_ text: String) -> [String] { LinkText.webAddresses(in: text).map(\.address) }
        XCTAssertEqual(found("see https://example.com/a?b=1."), ["https://example.com/a?b=1"])
        XCTAssertEqual(found("打开https://example.com/a。然后看https://example.org/b，再说"), ["https://example.com/a", "https://example.org/b"],
                       "Chinese text follows an address without a space")
        XCTAssertEqual(found("(https://example.com/x) and https://en.wikipedia.org/wiki/A_(b)"), ["https://example.com/x", "https://en.wikipedia.org/wiki/A_(b)"],
                       "a bracket closes the one before the address, or belongs to it")
        XCTAssertEqual(found("**https://example.com/a**"), ["https://example.com/a"])
        XCTAssertEqual(found("http:// https://. nothing"), [], "a scheme alone")
        XCTAssertEqual(found("HTTPS://Example.COM/Path"), ["HTTPS://Example.COM/Path"])
        let text = "见 https://example.com/a。"
        let range = LinkText.webAddresses(in: text)[0].range
        XCTAssertEqual(String(text[range]), "https://example.com/a")
    }

    func testWhichWordsArePathsOfTheMacs() {
        let workdir = "/Users/me/Projects/AgentSwitch"
        func path(_ word: String, _ dir: String? = workdir) -> String? { LinkText.macPath(word, workdir: dir) }
        XCTAssertEqual(path("/Users/me/out/index.html"), "/Users/me/out/index.html")
        XCTAssertEqual(path("/private/tmp/"), "/private/tmp/")
        XCTAssertEqual(path("~/Desktop/a.png"), "~/Desktop/a.png")
        XCTAssertEqual(path("./docs/a.md"), "\(workdir)/docs/a.md")
        XCTAssertEqual(path("../site/index.html"), "\(workdir)/../site/index.html")
        XCTAssertEqual(path("docs/design/concepts/split.html"), "\(workdir)/docs/design/concepts/split.html")
        XCTAssertEqual(path("packages/daemon/ui/terminal.js:1287"), "\(workdir)/packages/daemon/ui/terminal.js", "a place in the file is not its path")
        XCTAssertEqual(path("src/a.ts:12:5"), "\(workdir)/src/a.ts")
        XCTAssertEqual(path("培训/靶场/说明.md"), "\(workdir)/培训/靶场/说明.md")
        for word in ["/help", "/compact", "//", "/", "~", "and/or", "text/plain", "1/2", "2026/10/03", "v2/3.1", "origin/main", "README.md", "a//b.md",
                     "https://example.com/a.html", "-/x.md"] {
            XCTAssertNil(path(word), "\(word) is not a path")
        }
        XCTAssertNil(path("docs/a.md", nil), "nothing to resolve a relative path against")
        XCTAssertEqual(path("/Users/me/a/b.md", nil), "/Users/me/a/b.md")
    }

    // MARK: on a terminal's screen

    func testAnAddressWrittenOutIsALink() {
        let found = TerminalLinks.find(rows: rows(["⏺ 文档见https://code.claude.com/docs/en/agent-teams.md。", "  next line"]))
        XCTAssertEqual(found.map(\.link), [.web("https://code.claude.com/docs/en/agent-teams.md")])
        XCTAssertEqual(found[0].spans, [span(0, 8..<54)], "the Chinese before it takes two cells a character; the full stop after it is not the address's")
    }

    func testTheTerminalsOwnWrapIsOneLink() {
        let screen = rows(["$ echo https://example.com/a/very/long/pa", "th/index.html and more"])
        let found = TerminalLinks.find(rows: screen, wrapped: [1])
        XCTAssertEqual(found.map(\.link), [.web("https://example.com/a/very/long/path/index.html")])
        XCTAssertEqual(found[0].spans, [span(0, 7..<41), span(1, 0..<13)])
        XCTAssertEqual(TerminalLinks.find(rows: screen).map(\.link), [.web("https://example.com/a/very/long/pa")], "two lines the program wrote, not one wrapped")
    }

    func testAnAddressTheAgentCutAtItsWidthIsOneLink() {
        // Claude Code wraps by words and cuts only a word longer than a line: that line is filled to the width.
        let screen = rows([
            "⏺ 分屏的说明在这里，可以直接打开看一下效果：",
            "  https://code.claude.com/docs/en/agent-teams.md#choose-",
            "  a-display-mode",
            "",
            "⏺ 另一段。",
        ])
        let found = TerminalLinks.find(rows: screen)
        XCTAssertEqual(found.map(\.link), [.web("https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode")])
        XCTAssertEqual(found[0].spans, [span(1, 2..<56), span(2, 2..<16)])
    }

    func testAWordOnTheNextLineIsNotJoinedToAnAddressThatFits() {
        // The line is not filled to the width of its paragraph: the address ended there.
        let prose = rows([
            "⏺ The preview is at https://example.com/preview/index.html",
            "  and the rest of this sentence runs on to the full width here.",
        ])
        XCTAssertEqual(TerminalLinks.find(rows: prose).map(\.link), [.web("https://example.com/preview/index.html")])
        // Filled to the width, yet the word after it would have fitted a line with it: a wrapped word, not a cut one.
        let fits = rows([
            "⏺ Opened https://example.com/a/b",
            "  ok",
        ])
        XCTAssertEqual(TerminalLinks.find(rows: fits).map(\.link), [.web("https://example.com/a/b")])
        // Chinese after the break is never the address's.
        let chinese = rows(["⏺ https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u", "  然后继续"])
        XCTAssertEqual(TerminalLinks.find(rows: chinese).map(\.link), [.web("https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u")])
    }

    func testABoxsSideIsNotTheWidthOfTheText() {
        let screen = rows([
            "╭──────────────────────────────────────────────────────────────╮",
            "│ > 试试                                                       │",
            "╰──────────────────────────────────────────────────────────────╯",
            "  https://example.com/a/very/long/address/that/does/not/fi",
            "  t/in/one/line.html",
        ])
        XCTAssertEqual(TerminalLinks.find(rows: screen).map(\.link), [.web("https://example.com/a/very/long/address/that/does/not/fit/in/one/line.html")])
    }

    func testOSC8LinksCarryTheirAddress() {
        let screen = rows(["  说明 and Docs", "  page here", "  ~/out/report.html"])
        let explicit = [TerminalLinks.Explicit(row: 0, columns: 11..<15, address: "https://example.com/docs/page"),
                        TerminalLinks.Explicit(row: 1, columns: 2..<6, address: "https://example.com/docs/page"),
                        TerminalLinks.Explicit(row: 2, columns: 2..<19, address: "file:///Users/me/out/report.html"),
                        TerminalLinks.Explicit(row: 1, columns: 7..<11, address: "mailto:me@example.com")]
        let found = TerminalLinks.find(rows: screen, explicit: explicit)
        XCTAssertEqual(found.map(\.link), [.web("https://example.com/docs/page"), .file("/Users/me/out/report.html")],
                       "one link over two rows; the words under an OSC 8 link are not read again; no other scheme")
        XCTAssertEqual(found[0].spans, [span(0, 11..<15), span(1, 2..<6)])
        XCTAssertEqual(TerminalLinks.address(payload: "id=7;https://example.com/a;b"), "https://example.com/a;b")
        XCTAssertEqual(TerminalLinks.address(payload: ";file:///tmp/a"), "file:///tmp/a")
        XCTAssertNil(TerminalLinks.address(payload: "no-address"))
    }

    func testPathsOnTheScreen() {
        let workdir = "/Users/me/Projects/AgentSwitch"
        let screen = rows([
            "⏺ Write(docs/design/concepts/split.html)",
            "  ⎿  Wrote 420 lines to \"/Users/me/out/a.html\".",
            "  try /help or and/or, see packages/daemon/ui/terminal.js:1287",
        ])
        let found = TerminalLinks.find(rows: screen, workdir: workdir)
        XCTAssertEqual(found.map(\.link), [.file("\(workdir)/docs/design/concepts/split.html"), .file("/Users/me/out/a.html"),
                                           .file("\(workdir)/packages/daemon/ui/terminal.js")], "`/help` and `and/or` are words")
        XCTAssertEqual(found[0].spans, [span(0, 8..<39)], "a tool's argument: what is inside the brackets")
        XCTAssertEqual(found[1].spans, [span(1, 25..<45)], "the quotes and the full stop are not the path's")
        XCTAssertEqual(found[2].spans, [span(2, 27..<62)])
        XCTAssertEqual(TerminalLinks.find(rows: screen).map(\.link), [.file("/Users/me/out/a.html")], "no folder to resolve the relative one against")
    }

    func testAPathCutOverLinesKeepsItsOtherReadings() {
        // Filled to the width and too long for a line: surely one path.
        let cut = rows([
            "⏺ Wrote /private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d",
            "       7a3bb725b/scratchpad/out/agentswitch-browser.html",
        ])
        let one = TerminalLinks.find(rows: cut)
        XCTAssertEqual(one.map(\.link), [.file("/private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b/scratchpad/out/agentswitch-browser.html")])
        XCTAssertEqual(one[0].spans.map(\.row), [0, 1])
        XCTAssertEqual(one[0].alternates, [.file("/private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d")])
        // A path that ends its line, the next line a new word: the path alone, the join only as another reading for
        // the Mac to tell.
        let ended = rows(["⏺ Wrote /Users/me/out/index.html", "  done"])
        let two = TerminalLinks.find(rows: ended)
        XCTAssertEqual(two.map(\.link), [.file("/Users/me/out/index.html")])
        XCTAssertEqual(two[0].spans, [span(0, 8..<32)])
        XCTAssertEqual(two[0].alternates, [.file("/Users/me/out/index.htmldone")])
    }

    func testAPathWrappedInItsOwnColumnIsOnePath() {
        // Claude Code's row for a file on a narrow screen (2026-10-04, user: 手机上两行的东西只能选中一行): the mark, the
        // path and the size each wrapped in a column of its own, so the path's rest starts under its first cell — right
        // after another column's word, or a space from it — and the size's rest follows it.
        let screen = rows([
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/send (554.4",
            "  [image]-before-after.png                             KB)",
            "",
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/prob (298.3",
            "  [image]e-real/after-terminals.png                    KB)",
            "",
            "  ›       ~/Desktop/WorkSpace/Scratch/classic-dark/web (81.2K",
            "  [image] /web-terminal-classic.png                    B)",
        ])
        let found = TerminalLinks.find(rows: screen, workdir: "/Users/me/Projects/AgentSwitch")
        XCTAssertEqual(found.map(\.link), [.file("~/Desktop/WorkSpace/Scratch/classic-dark/send-before-after.png"),
                                           .file("~/Desktop/WorkSpace/Scratch/classic-dark/probe-real/after-terminals.png"),
                                           .file("~/Desktop/WorkSpace/Scratch/classic-dark/web/web-terminal-classic.png")],
                       "each one path; what the next row holds before the path's column is no path of its own")
        XCTAssertEqual(found[0].spans, [span(0, 9..<54), span(1, 9..<26)], "both rows are the link's: a touch on either lands on it")
        XCTAssertEqual(found[0].alternates, [.file("~/Desktop/WorkSpace/Scratch/classic-dark/send")], "the first row alone, should the Mac not have the whole")
        XCTAssertEqual(found[2].spans, [span(6, 10..<54), span(7, 10..<35)])
        let cell = (width: 6.0, height: 12.0)
        XCTAssertEqual(TerminalLinks.hit(found, column: 14, row: 1.5, cell: cell, slop: 12)?.link, found[0].link, "on the second row")
        XCTAssertEqual(TerminalLinks.hit(found, column: 30, row: 0.5, cell: cell, slop: 12)?.link, found[0].link, "on the first")

        // Three rows: the middle one fills the column.
        let three = rows([
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/send (1.2",
            "  [image]-before-after-with-a-very-long-name-that-goes MB)",
            "         -on.png",
        ])
        let long = TerminalLinks.find(rows: three)
        XCTAssertEqual(long.map(\.link), [.file("~/Desktop/WorkSpace/Scratch/classic-dark/send-before-after-with-a-very-long-name-that-goes-on.png")])
        XCTAssertEqual(long[0].spans.map(\.row), [0, 1, 2])
    }

    func testRowsUnderOneAnotherAreNotOnePathWithoutAReason() {
        let workdir = "/Users/me/Projects/AgentSwitch"
        // A list of files, each with what follows it: a file with its name whole does not go on in the next row. The
        // join is kept only as another reading for the Mac to tell.
        let list = TerminalLinks.find(rows: rows(["  › src/components/Button.tsx  12 KB", "  › src/utils/a.ts             3 KB"]), workdir: workdir)
        XCTAssertEqual(list.map(\.link), [.file("\(workdir)/src/components/Button.tsx"), .file("\(workdir)/src/utils/a.ts")])
        XCTAssertEqual(list[0].spans, [span(0, 4..<29)])
        XCTAssertEqual(list[0].alternates, [.file("\(workdir)/src/components/Button.tsxsrc/utils/a.ts")])
        // The row under it starts another path.
        let paths = TerminalLinks.find(rows: rows(["  ›  ~/Desktop/out/report  (dir)", "     ~/Desktop/out/a.png   (2 KB)"]))
        XCTAssertEqual(paths.map(\.link), [.file("~/Desktop/out/report"), .file("~/Desktop/out/a.png")])
        XCTAssertEqual(paths[0].alternates, [])
        // A longer row under it is not the rest of a column no wider than the path.
        let longer = TerminalLinks.find(rows: rows(["  in ~/out/a (new)", "     and-a-longer-word.txt here"]))
        XCTAssertEqual(longer.map(\.link), [.file("~/out/a")])
        XCTAssertEqual(longer[0].alternates, [])
        // The column under the path's first cell is the middle of a word.
        let prose = TerminalLinks.find(rows: rows(["  see ~/Desktop/a/b/c today", "  another.line of text"]))
        XCTAssertEqual(prose.map(\.link), [.file("~/Desktop/a/b/c")])
        XCTAssertEqual(prose[0].alternates, [])
        // An address is not joined this way: nobody can say which reading is there.
        let web = TerminalLinks.find(rows: rows(["  docs  https://example.com/a/very/long/addr (new", "        ess/index.html                        tab)"]))
        XCTAssertEqual(web.first?.link, .web("https://example.com/a/very/long/addr"))
        XCTAssertEqual(web.first?.spans, [span(0, 8..<44)])
        // Nor a row the terminal wrapped itself, which goes on at the row's first cell.
        let wrapped = TerminalLinks.find(rows: rows(["  ›  ~/Desktop/out/repo (1", "     rt.html KB)"]), wrapped: [1])
        XCTAssertEqual(wrapped.map(\.link), [.file("~/Desktop/out/repo")])
    }

    func testATouchNeedNotBeExact() {
        let links = TerminalLinks.find(rows: rows(["  see https://example.com/a now", "", "  and /Users/me/out/b.html too"]))
        XCTAssertEqual(links.count, 2)
        let cell = (width: 6.0, height: 12.0)
        func hit(_ column: Double, _ row: Double, slop: Double = 12) -> TappedLink? {
            TerminalLinks.hit(links, column: column, row: row, cell: cell, slop: slop)?.link
        }
        XCTAssertEqual(hit(10, 0.5), .web("https://example.com/a"), "on it")
        XCTAssertEqual(hit(10, 1.3), .web("https://example.com/a"), "a third of a line below it")
        XCTAssertEqual(hit(10, 1.9), .file("/Users/me/out/b.html"), "nearer the path under it")
        XCTAssertEqual(hit(4.5, 0.5), .web("https://example.com/a"), "just before its first character")
        XCTAssertNil(hit(40, 0.5), "far to its right")
        XCTAssertNil(hit(10, 1.6, slop: 4), "a tighter slop")
        XCTAssertNil(TerminalLinks.hit([], column: 1, row: 1, cell: cell, slop: 12))
    }

    // MARK: in Dispatch's text

    func testAnAddressInChineseTextIsCutWhereItEnds() {
        let text = Markdown.inline("打开 https://example.com/a。然后看https://example.org/b，再说")
        let links = text.runs.compactMap { run in run.link.map { (String(text[run.range].characters), $0.absoluteString) } }
        XCTAssertEqual(links.map(\.0), ["https://example.com/a", "https://example.org/b"])
        XCTAssertEqual(links.map(\.1), ["https://example.com/a", "https://example.org/b"])
        XCTAssertEqual(String(text.characters), "打开 https://example.com/a。然后看https://example.org/b，再说", "the text itself is as written")
    }

    func testANamedLinkStaysAndAnAddressInBackticksIsOne() {
        let named = Markdown.inline("见 [说明。](https://example.com/guide) 与 `https://example.com/api`，以及 `npm run dev`")
        let links = named.runs.compactMap { run in run.link.map { (String(named[run.range].characters), $0.absoluteString) } }
        XCTAssertEqual(links.map(\.0), ["说明。", "https://example.com/api"])
        XCTAssertEqual(links.map(\.1), ["https://example.com/guide", "https://example.com/api"])
    }

    func testTheLinksOfATextForItsLongPress() {
        let source = """
        见 [说明](https://example.com/guide) 和 https://example.com/a。再看一次 https://example.com/guide
        ```
        curl -s https://api.example.com/v1/health
        ```
        | 页 | 地址 |
        |---|---|
        | 首页 | https://example.com/ |
        [配对](agentswitch://pair?code=1)
        """
        XCTAssertEqual(Markdown.links(in: source), [.web("https://example.com/guide"), .web("https://example.com/a"), .web("https://api.example.com/v1/health"),
                                                   .web("https://example.com/")], "in order, each once, code and tables too, web addresses only")
        XCTAssertEqual(Markdown.links(in: source, limit: 2).count, 2)
        XCTAssertEqual(Markdown.links(in: "没有链接。"), [])
    }
}
