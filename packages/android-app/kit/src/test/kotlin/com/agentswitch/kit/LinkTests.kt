package com.agentswitch.kit

import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.BrowserTarget
import com.agentswitch.kit.feed.LinkAction
import com.agentswitch.kit.feed.LinkOpening
import com.agentswitch.kit.feed.LinkText
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.ScreenLink
import com.agentswitch.kit.feed.TappedLink
import com.agentswitch.kit.feed.TerminalLinks
import java.text.BreakIterator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Links on the phone (docs/terminal-v0.md §1 iPhone 链接, browser-v0 §1 入口; 2026-10-03, user: 手机上现在点击和复制链接
 * 还是费劲……点击之后直接在agent switch浏览器中打开): what counts as one on a terminal's screen and in Dispatch's text,
 * where a touch lands, what a tap opens and a long press offers, and what happens when the Mac's browser cannot take it.
 */
class LinkTests {
    /** Rows as the screen holds them: a character a cell, CJK taking two. */
    private fun rows(lines: List<String>): List<List<String>> = lines.map { line ->
        val out = mutableListOf<String>()
        val it = BreakIterator.getCharacterInstance()
        it.setText(line)
        var start = 0
        while (true) {
            val end = it.next()
            if (end == BreakIterator.DONE) break
            val c = line.substring(start, end)
            out.add(c)
            if (c.codePointAt(0) >= 0x2E80) out.add(TerminalLinks.wideTail)
            start = end
        }
        out
    }

    private fun rows(vararg lines: String): List<List<String>> = rows(lines.toList())

    private fun span(row: Int, columns: IntRange) = ScreenLink.Span(row, columns)

    private val cell = TerminalLinks.CellSize(6.0, 12.0)

    // MARK: a link

    @Test
    fun testOnlyWebAddressesAndFilesAreLinks() {
        assertEquals(TappedLink.Web("https://example.com/a?b=1"), TappedLink.fromAddress("https://example.com/a?b=1"))
        assertEquals(TappedLink.Web("HTTP://Example.com"), TappedLink.fromAddress("HTTP://Example.com"))
        assertEquals(TappedLink.File("/Users/me/out/a b.html"), TappedLink.fromAddress("file:///Users/me/out/a%20b.html"))
        assertNull(TappedLink.fromAddress("agentswitch://pair?code=1"), "the app's own scheme is never opened from output")
        assertNull(TappedLink.fromAddress("javascript:alert(1)"))
        assertNull(TappedLink.fromAddress("https://"), "a scheme alone")
        assertNull(TappedLink.fromAddress("file:///"))
    }

    @Test
    fun testWhatATapOpensAndALongPressOffers() {
        val web = TappedLink.Web("https://github.com/acme/app/pull/128")
        assertEquals(BrowserTarget.Url("https://github.com/acme/app/pull/128"), web.target)
        assertEquals(listOf(LinkAction.OpenInBrowser, LinkAction.Copy, LinkAction.OpenInSafari), web.actions)
        assertEquals(listOf("Open in Browser", "Copy Link", "Open in Safari"), web.actions.map { it.label(web) })
        assertEquals("github.com/acme/app/pull/128", web.display)
        assertEquals("Link Copied", LinkAction.copied(web))

        val file = TappedLink.File("/Users/me/Projects/site/index.html")
        assertEquals(BrowserTarget.Path("/Users/me/Projects/site/index.html"), file.target)
        // A tap on a path opens the Files browser (docs/files-v0.md §12.4.2); the browser is the menu's second.
        assertEquals(listOf("Show in Files", "Open in Browser", "Copy Path"), file.actions.map { it.label(file) }, "a file of the Mac's is not Safari's to open")
        assertEquals("~/Projects/site/index.html", file.display)
        assertEquals("/Users/me/Projects/site/index.html", file.text, "the whole path is what is copied")
        assertEquals("Path Copied", LinkAction.copied(file))

        for (local in listOf("http://localhost:5173/", "http://127.0.0.1:8080/x", "http://[::1]:3000/")) {
            assertEquals(listOf(LinkAction.OpenInBrowser, LinkAction.Copy), TappedLink.Web(local).actions, "$local is only there on the Mac")
            assertNull(TappedLink.Web(local).safari)
        }
    }

    @Test
    fun testWithoutTheMacsBrowserAWebAddressGoesToSafariAndSaysWhy() {
        val web = TappedLink.Web("https://example.com/a")
        val local = TappedLink.Web("http://localhost:5173/")
        val file = TappedLink.File("~/a.html")
        val off = LinkOpening.fallback(web, LinkOpening.Failure.NoBrowser)
        assertEquals("https://example.com/a", off.safari)
        assertEquals("此 Mac 上的 AgentSwitch 未提供浏览器，已在 Safari 中打开。", off.said)
        assertNull(LinkOpening.fallback(file, LinkOpening.Failure.NoBrowser).safari)
        assertEquals("此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。", LinkOpening.fallback(file, LinkOpening.Failure.NoBrowser).said)
        assertEquals("未连接到 Mac，已在 Safari 中打开。", LinkOpening.fallback(web, LinkOpening.Failure.NotConnected).said)
        assertNull(LinkOpening.fallback(local, LinkOpening.Failure.NotConnected).safari, "a page of the Mac's own cannot open on the phone")
        assertEquals("未连接到 Mac，无法在 Mac 的浏览器中打开。", LinkOpening.fallback(local, LinkOpening.Failure.NotConnected).said)
        val refused = LinkOpening.fallback(file, LinkOpening.Failure.Refused("此路径属于凭据或 AgentSwitch 自己的数据，不能在浏览器中打开。"))
        assertNull(refused.safari)
        assertEquals("此路径属于凭据或 AgentSwitch 自己的数据，不能在浏览器中打开。", refused.said, "the Mac's own reason")
        assertEquals("Mac 未能打开此链接（Chrome 未能启动），已在 Safari 中打开。", LinkOpening.fallback(web, LinkOpening.Failure.Refused("Chrome 未能启动")).said)
        assertEquals("Mac 未能打开此链接。", LinkOpening.fallback(local, LinkOpening.Failure.Refused("")).said)
    }

    @Test
    fun testHowAFailedOpenCounts() {
        val web = TappedLink.Web("https://example.com")
        val file = TappedLink.File("/Users/me/a.html")
        assertEquals(LinkOpening.Failure.NoBrowser, LinkOpening.failure(APIError.Http(404, "not found"), web), "a Mac without the route")
        assertEquals(LinkOpening.Failure.Refused("没有这个文件"), LinkOpening.failure(APIError.Http(404, "没有这个文件"), file))
        assertEquals(LinkOpening.Failure.Refused("不能打开"), LinkOpening.failure(APIError.Http(403, "不能打开"), file))
        assertEquals(LinkOpening.Failure.NotConnected, LinkOpening.failure(APIError.Unreachable, web))
        assertEquals(LinkOpening.Failure.NotConnected, LinkOpening.failure(APIError.Transport("timed out"), web))
    }

    // MARK: addresses and paths in text

    @Test
    fun testAnAddressEndsWhereTheProseGoesOn() {
        fun found(text: String): List<String> = LinkText.webAddresses(text).map { it.address }
        assertEquals(listOf("https://example.com/a?b=1"), found("see https://example.com/a?b=1."))
        assertEquals(listOf("https://example.com/a", "https://example.org/b"), found("打开https://example.com/a。然后看https://example.org/b，再说"),
            "Chinese text follows an address without a space")
        assertEquals(listOf("https://example.com/x", "https://en.wikipedia.org/wiki/A_(b)"), found("(https://example.com/x) and https://en.wikipedia.org/wiki/A_(b)"),
            "a bracket closes the one before the address, or belongs to it")
        assertEquals(listOf("https://example.com/a"), found("**https://example.com/a**"))
        assertEquals(emptyList(), found("http:// https://. nothing"), "a scheme alone")
        assertEquals(listOf("HTTPS://Example.COM/Path"), found("HTTPS://Example.COM/Path"))
        val text = "见 https://example.com/a。"
        val match = LinkText.webAddresses(text)[0]
        assertEquals("https://example.com/a", text.substring(match.start, match.end))
    }

    @Test
    fun testWhichWordsArePathsOfTheMacs() {
        val workdir = "/Users/me/Projects/AgentSwitch"
        fun path(word: String, dir: String? = workdir): String? = LinkText.macPath(word, dir)
        assertEquals("/Users/me/out/index.html", path("/Users/me/out/index.html"))
        assertEquals("/private/tmp/", path("/private/tmp/"))
        assertEquals("~/Desktop/a.png", path("~/Desktop/a.png"))
        assertEquals("$workdir/docs/a.md", path("./docs/a.md"))
        assertEquals("$workdir/../site/index.html", path("../site/index.html"))
        assertEquals("$workdir/docs/design/concepts/split.html", path("docs/design/concepts/split.html"))
        assertEquals("$workdir/packages/daemon/ui/terminal.js", path("packages/daemon/ui/terminal.js:1287"), "a place in the file is not its path")
        assertEquals("$workdir/src/a.ts", path("src/a.ts:12:5"))
        assertEquals("$workdir/培训/靶场/说明.md", path("培训/靶场/说明.md"))
        for (word in listOf("/help", "/compact", "//", "/", "~", "and/or", "text/plain", "1/2", "2026/10/03", "v2/3.1", "origin/main", "README.md", "a//b.md",
            "https://example.com/a.html", "-/x.md")) {
            assertNull(path(word), "$word is not a path")
        }
        assertNull(path("docs/a.md", null), "nothing to resolve a relative path against")
        assertEquals("/Users/me/a/b.md", path("/Users/me/a/b.md", null))
    }

    // MARK: on a terminal's screen

    @Test
    fun testAnAddressWrittenOutIsALink() {
        val found = TerminalLinks.find(rows("⏺ 文档见https://code.claude.com/docs/en/agent-teams.md。", "  next line"))
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://code.claude.com/docs/en/agent-teams.md")), found.map { it.link })
        assertEquals(listOf(span(0, 8 until 54)), found[0].spans, "the Chinese before it takes two cells a character; the full stop after it is not the address's")
    }

    @Test
    fun testTheTerminalsOwnWrapIsOneLink() {
        val screen = rows("$ echo https://example.com/a/very/long/pa", "th/index.html and more")
        val found = TerminalLinks.find(screen, wrapped = setOf(1))
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/a/very/long/path/index.html")), found.map { it.link })
        assertEquals(listOf(span(0, 7 until 41), span(1, 0 until 13)), found[0].spans)
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/a/very/long/pa")), TerminalLinks.find(screen).map { it.link }, "two lines the program wrote, not one wrapped")
    }

    @Test
    fun testAnAddressTheAgentCutAtItsWidthIsOneLink() {
        // Claude Code wraps by words and cuts only a word longer than a line: that line is filled to the width.
        val screen = rows(
            "⏺ 分屏的说明在这里，可以直接打开看一下效果：",
            "  https://code.claude.com/docs/en/agent-teams.md#choose-",
            "  a-display-mode",
            "",
            "⏺ 另一段。",
        )
        val found = TerminalLinks.find(screen)
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://code.claude.com/docs/en/agent-teams.md#choose-a-display-mode")), found.map { it.link })
        assertEquals(listOf(span(1, 2 until 56), span(2, 2 until 16)), found[0].spans)
    }

    @Test
    fun testAWordOnTheNextLineIsNotJoinedToAnAddressThatFits() {
        // The line is not filled to the width of its paragraph: the address ended there.
        val prose = rows(
            "⏺ The preview is at https://example.com/preview/index.html",
            "  and the rest of this sentence runs on to the full width here.",
        )
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/preview/index.html")), TerminalLinks.find(prose).map { it.link })
        // Filled to the width, yet the word after it would have fitted a line with it: a wrapped word, not a cut one.
        val fits = rows(
            "⏺ Opened https://example.com/a/b",
            "  ok",
        )
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/a/b")), TerminalLinks.find(fits).map { it.link })
        // Chinese after the break is never the address's.
        val chinese = rows("⏺ https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u", "  然后继续")
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u")), TerminalLinks.find(chinese).map { it.link })
    }

    @Test
    fun testABoxsSideIsNotTheWidthOfTheText() {
        val screen = rows(
            "╭──────────────────────────────────────────────────────────────╮",
            "│ > 试试                                                       │",
            "╰──────────────────────────────────────────────────────────────╯",
            "  https://example.com/a/very/long/address/that/does/not/fi",
            "  t/in/one/line.html",
        )
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/a/very/long/address/that/does/not/fit/in/one/line.html")), TerminalLinks.find(screen).map { it.link })
    }

    @Test
    fun testOSC8LinksCarryTheirAddress() {
        val screen = rows("  说明 and Docs", "  page here", "  ~/out/report.html")
        val explicit = listOf(
            TerminalLinks.Explicit(0, 11 until 15, "https://example.com/docs/page"),
            TerminalLinks.Explicit(1, 2 until 6, "https://example.com/docs/page"),
            TerminalLinks.Explicit(2, 2 until 19, "file:///Users/me/out/report.html"),
            TerminalLinks.Explicit(1, 7 until 11, "mailto:me@example.com"),
        )
        val found = TerminalLinks.find(screen, explicit = explicit)
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/docs/page"), TappedLink.File("/Users/me/out/report.html")), found.map { it.link },
            "one link over two rows; the words under an OSC 8 link are not read again; no other scheme")
        assertEquals(listOf(span(0, 11 until 15), span(1, 2 until 6)), found[0].spans)
        assertEquals("https://example.com/a;b", TerminalLinks.address("id=7;https://example.com/a;b"))
        assertEquals("file:///tmp/a", TerminalLinks.address(";file:///tmp/a"))
        assertNull(TerminalLinks.address("no-address"))
    }

    @Test
    fun testPathsOnTheScreen() {
        val workdir = "/Users/me/Projects/AgentSwitch"
        val screen = rows(
            "⏺ Write(docs/design/concepts/split.html)",
            "  ⎿  Wrote 420 lines to \"/Users/me/out/a.html\".",
            "  try /help or and/or, see packages/daemon/ui/terminal.js:1287",
        )
        val found = TerminalLinks.find(screen, workdir = workdir)
        assertEquals(listOf<TappedLink>(TappedLink.File("$workdir/docs/design/concepts/split.html"), TappedLink.File("/Users/me/out/a.html"),
            TappedLink.File("$workdir/packages/daemon/ui/terminal.js")), found.map { it.link }, "`/help` and `and/or` are words")
        assertEquals(listOf(span(0, 8 until 39)), found[0].spans, "a tool's argument: what is inside the brackets")
        assertEquals(listOf(span(1, 25 until 45)), found[1].spans, "the quotes and the full stop are not the path's")
        assertEquals(listOf(span(2, 27 until 62)), found[2].spans)
        assertEquals(listOf<TappedLink>(TappedLink.File("/Users/me/out/a.html")), TerminalLinks.find(screen).map { it.link }, "no folder to resolve the relative one against")
    }

    @Test
    fun testAPathCutOverLinesKeepsItsOtherReadings() {
        // Filled to the width and too long for a line: surely one path.
        val cut = rows(
            "⏺ Wrote /private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d",
            "       7a3bb725b/scratchpad/out/agentswitch-browser.html",
        )
        val one = TerminalLinks.find(cut)
        assertEquals(listOf<TappedLink>(TappedLink.File("/private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b/scratchpad/out/agentswitch-browser.html")), one.map { it.link })
        assertEquals(listOf(0, 1), one[0].spans.map { it.row })
        assertEquals(listOf<TappedLink>(TappedLink.File("/private/tmp/claude-501/-Users-me-Desktop-WorkSpace/0e3e5e94-d0e2-4f5b-b869-85d")), one[0].alternates)
        // A path that ends its line, the next line a new word: the path alone, the join only as another reading for
        // the Mac to tell.
        val ended = rows("⏺ Wrote /Users/me/out/index.html", "  done")
        val two = TerminalLinks.find(ended)
        assertEquals(listOf<TappedLink>(TappedLink.File("/Users/me/out/index.html")), two.map { it.link })
        assertEquals(listOf(span(0, 8 until 32)), two[0].spans)
        assertEquals(listOf<TappedLink>(TappedLink.File("/Users/me/out/index.htmldone")), two[0].alternates)
    }

    @Test
    fun testTheRestOfAPathCutOverLinesAlsoReadsAsTheWhole() {
        // The path's row is not the widest of its paragraph (the address above is wider): whether it goes on is not sure,
        // so it is read alone, the join kept for the Mac to tell. The next row's own word (a relative path) also reads
        // as the whole, so a tap on either half finds it (files-v0 §12.4.2).
        val workdir = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
        val screen = rows(
            "⏺ 分屏的说明见这一页，也可以直接打开预览：",
            "  https://code.claude.com/docs/en/agent-teams.md#choo",
            "  se-a-display-mode",
            "  ~/Desktop/WorkSpace/Projects/AgentSwitch/docs/desi",
            "  gn/concepts/split.html",
        )
        val paths = TerminalLinks.find(screen, workdir = workdir).filter { it.link is TappedLink.File }
        assertEquals(2, paths.size)
        val whole = TappedLink.File("~/Desktop/WorkSpace/Projects/AgentSwitch/docs/design/concepts/split.html")
        assertEquals(TappedLink.File("~/Desktop/WorkSpace/Projects/AgentSwitch/docs/desi"), paths.first().link)
        assertEquals(listOf<TappedLink>(whole), paths.first().alternates)
        assertEquals(TappedLink.File("$workdir/gn/concepts/split.html"), paths.last().link)
        assertEquals(listOf<TappedLink>(whole), paths.last().alternates)
    }

    @Test
    fun testAPathWrappedInItsOwnColumnIsOnePath() {
        // Claude Code's row for a file on a narrow screen (2026-10-04, user: 手机上两行的东西只能选中一行): the mark, the
        // path and the size each wrapped in a column of its own, so the path's rest starts under its first cell — right
        // after another column's word, or a space from it — and the size's rest follows it.
        val screen = rows(
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/send (554.4",
            "  [image]-before-after.png                             KB)",
            "",
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/prob (298.3",
            "  [image]e-real/after-terminals.png                    KB)",
            "",
            "  ›       ~/Desktop/WorkSpace/Scratch/classic-dark/web (81.2K",
            "  [image] /web-terminal-classic.png                    B)",
        )
        val found = TerminalLinks.find(screen, workdir = "/Users/me/Projects/AgentSwitch")
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/WorkSpace/Scratch/classic-dark/send-before-after.png"),
            TappedLink.File("~/Desktop/WorkSpace/Scratch/classic-dark/probe-real/after-terminals.png"),
            TappedLink.File("~/Desktop/WorkSpace/Scratch/classic-dark/web/web-terminal-classic.png")), found.map { it.link },
            "each one path; what the next row holds before the path's column is no path of its own")
        assertEquals(listOf(span(0, 9 until 54), span(1, 9 until 26)), found[0].spans, "both rows are the link's: a touch on either lands on it")
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/WorkSpace/Scratch/classic-dark/send")), found[0].alternates, "the first row alone, should the Mac not have the whole")
        assertEquals(listOf(span(6, 10 until 54), span(7, 10 until 35)), found[2].spans)
        assertEquals(found[0].link, TerminalLinks.hit(found, column = 14.0, row = 1.5, cell = cell, slop = 12.0)?.link, "on the second row")
        assertEquals(found[0].link, TerminalLinks.hit(found, column = 30.0, row = 0.5, cell = cell, slop = 12.0)?.link, "on the first")

        // Three rows: the middle one fills the column.
        val three = rows(
            "  ›      ~/Desktop/WorkSpace/Scratch/classic-dark/send (1.2",
            "  [image]-before-after-with-a-very-long-name-that-goes MB)",
            "         -on.png",
        )
        val long = TerminalLinks.find(three)
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/WorkSpace/Scratch/classic-dark/send-before-after-with-a-very-long-name-that-goes-on.png")), long.map { it.link })
        assertEquals(listOf(0, 1, 2), long[0].spans.map { it.row })
    }

    @Test
    fun testRowsUnderOneAnotherAreNotOnePathWithoutAReason() {
        val workdir = "/Users/me/Projects/AgentSwitch"
        // A list of files, each with what follows it: a file with its name whole does not go on in the next row. The
        // join is kept only as another reading for the Mac to tell.
        val list = TerminalLinks.find(rows("  › src/components/Button.tsx  12 KB", "  › src/utils/a.ts             3 KB"), workdir = workdir)
        assertEquals(listOf<TappedLink>(TappedLink.File("$workdir/src/components/Button.tsx"), TappedLink.File("$workdir/src/utils/a.ts")), list.map { it.link })
        assertEquals(listOf(span(0, 4 until 29)), list[0].spans)
        assertEquals(listOf<TappedLink>(TappedLink.File("$workdir/src/components/Button.tsxsrc/utils/a.ts")), list[0].alternates)
        // The row under it starts another path.
        val paths = TerminalLinks.find(rows("  ›  ~/Desktop/out/report  (dir)", "     ~/Desktop/out/a.png   (2 KB)"))
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/out/report"), TappedLink.File("~/Desktop/out/a.png")), paths.map { it.link })
        assertEquals(emptyList(), paths[0].alternates)
        // A longer row under it is not the rest of a column no wider than the path.
        val longer = TerminalLinks.find(rows("  in ~/out/a (new)", "     and-a-longer-word.txt here"))
        assertEquals(listOf<TappedLink>(TappedLink.File("~/out/a")), longer.map { it.link })
        assertEquals(emptyList(), longer[0].alternates)
        // The column under the path's first cell is the middle of a word.
        val prose = TerminalLinks.find(rows("  see ~/Desktop/a/b/c today", "  another.line of text"))
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/a/b/c")), prose.map { it.link })
        assertEquals(emptyList(), prose[0].alternates)
        // An address is not joined this way: nobody can say which reading is there.
        val web = TerminalLinks.find(rows("  docs  https://example.com/a/very/long/addr (new", "        ess/index.html                        tab)"))
        assertEquals(TappedLink.Web("https://example.com/a/very/long/addr"), web.firstOrNull()?.link)
        assertEquals(listOf(span(0, 8 until 44)), web.firstOrNull()?.spans)
        // Nor a row the terminal wrapped itself, which goes on at the row's first cell.
        val wrapped = TerminalLinks.find(rows("  ›  ~/Desktop/out/repo (1", "     rt.html KB)"), wrapped = setOf(1))
        assertEquals(listOf<TappedLink>(TappedLink.File("~/Desktop/out/repo")), wrapped.map { it.link })
    }

    @Test
    fun testATouchNeedNotBeExact() {
        val links = TerminalLinks.find(rows("  see https://example.com/a now", "", "  and /Users/me/out/b.html too"))
        assertEquals(2, links.size)
        fun hit(column: Double, row: Double, slop: Double = 12.0): TappedLink? = TerminalLinks.hit(links, column, row, cell, slop)?.link
        assertEquals(TappedLink.Web("https://example.com/a"), hit(10.0, 0.5), "on it")
        assertEquals(TappedLink.Web("https://example.com/a"), hit(10.0, 1.3), "a third of a line below it")
        assertEquals(TappedLink.File("/Users/me/out/b.html"), hit(10.0, 1.9), "nearer the path under it")
        assertEquals(TappedLink.Web("https://example.com/a"), hit(4.5, 0.5), "just before its first character")
        assertNull(hit(40.0, 0.5), "far to its right")
        assertNull(hit(10.0, 1.6, slop = 4.0), "a tighter slop")
        assertNull(TerminalLinks.hit(emptyList(), 1.0, 1.0, cell, 12.0))
    }

    // MARK: in Dispatch's text

    @Test
    fun testAnAddressInChineseTextIsCutWhereItEnds() {
        val text = Markdown.inline("打开 https://example.com/a。然后看https://example.org/b，再说")
        val links = text.runs.mapNotNull { run -> run.link?.let { run.text to it } }
        assertEquals(listOf("https://example.com/a", "https://example.org/b"), links.map { it.first })
        assertEquals(listOf("https://example.com/a", "https://example.org/b"), links.map { it.second })
        assertEquals("打开 https://example.com/a。然后看https://example.org/b，再说", text.text, "the text itself is as written")
    }

    @Test
    fun testANamedLinkStaysAndAnAddressInBackticksIsOne() {
        val named = Markdown.inline("见 [说明。](https://example.com/guide) 与 `https://example.com/api`，以及 `npm run dev`")
        val links = named.runs.mapNotNull { run -> run.link?.let { run.text to it } }
        assertEquals(listOf("说明。", "https://example.com/api"), links.map { it.first })
        assertEquals(listOf("https://example.com/guide", "https://example.com/api"), links.map { it.second })
    }

    @Test
    fun testTheLinksOfATextForItsLongPress() {
        val source = """
            见 [说明](https://example.com/guide) 和 https://example.com/a。再看一次 https://example.com/guide
            ```
            curl -s https://api.example.com/v1/health
            ```
            | 页 | 地址 |
            |---|---|
            | 首页 | https://example.com/ |
            [配对](agentswitch://pair?code=1)
        """.trimIndent()
        assertEquals(listOf<TappedLink>(TappedLink.Web("https://example.com/guide"), TappedLink.Web("https://example.com/a"), TappedLink.Web("https://api.example.com/v1/health"),
            TappedLink.Web("https://example.com/")), Markdown.links(source), "in order, each once, code and tables too, web addresses only")
        assertEquals(2, Markdown.links(source, limit = 2).size)
        assertEquals(emptyList(), Markdown.links("没有链接。"))
    }
}
