package com.agentswitch.android.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import com.agentswitch.kit.api.BrowserAgentAction
import com.agentswitch.kit.api.BrowserBox
import com.agentswitch.kit.api.BrowserChoice
import com.agentswitch.kit.api.BrowserFrame
import com.agentswitch.kit.api.BrowserLocalServer
import com.agentswitch.kit.api.BrowserPlaceKind
import com.agentswitch.kit.api.BrowserTabGroup
import com.agentswitch.kit.api.BrowserTabInfo
import com.agentswitch.kit.api.BrowserTabList
import com.agentswitch.kit.api.BrowserTabOwner
import com.agentswitch.kit.api.BrowserTabStatus
import com.agentswitch.kit.api.BrowserViewport
import com.agentswitch.kit.browser.BrowserZoomMemory
import com.agentswitch.kit.browser.Size
import java.io.ByteArrayOutputStream

/**
 * The Browser tab's sample state (a sample screen, debug builds only), as the demo page
 * `docs/design/implemented/browser.html` has it: codex working on a pull request in its terminal, a dispatched task
 * waiting at a login for a code, and two tabs of yours — a file of the Mac's and a local dev server. The pictures are
 * mock pages drawn on the phone, standing in for the Mac's frames. Screens: `browser|browserpage|browsertook|browserfile|
 * browserlocal|browserdenied|browsernew|browserclose|browserzoom|browserzoomwatch`.
 *
 * The Swift read the screen's name from `UserDefaults` and this phone's id from `PhoneScreen`; here both are parameters
 * (`screen`, `phone`). The mock pages are drawn with `android.graphics.Canvas` in the system's sans-serif and monospace
 * (the iPhone's SF), so line breaks and widths differ a little.
 */
object DemoBrowser {
    val codex = BrowserTabOwner(kind = BrowserTabOwner.Kind.Terminal, id = "e5f6a7b8", label = "codex · AgentSwitch")
    val task = BrowserTabOwner(kind = BrowserTabOwner.Kind.Task, id = "t2", label = "登录财务平台，汇总首页的待办")

    /** The merge button where the mock page draws it (CSS pixels of a 640 × 900 page). */
    val mergeBox = BrowserBox(x = 28.0, y = 584.0, width = 250.0, height = 50.0)

    private val agentSize = BrowserViewport(width = 640.0, height = 900.0)
    private fun phoneSize(phone: String) = BrowserViewport(width = 402.0, height = 700.0, scale = 3.0, mobile = true, by = phone)

    /** `screen`: the sample screen's name; `phone`: this phone's screen id (`PhoneScreen.id`). */
    fun list(screen: String?, phone: String): BrowserTabList {
        val took = screen == "browsertook"
        val pr = BrowserTabInfo(
            id = "pr", owner = codex, title = "Add native Dispatch page · Pull Request #128", url = "https://github.com/acme/app/pull/128",
            site = "github.com", status = BrowserTabStatus.Busy,
            action = BrowserAgentAction(tool = "browser_click", description = "click \"Merge pull request\"", box = mergeBox),
            viewport = agentSize, openedAt = 1,
        )
        val issues = BrowserTabInfo(
            id = "issues", owner = codex, title = "Issues · acme/app", url = "https://github.com/acme/app/issues",
            site = "github.com", viewport = agentSize, openedAt = 2,
        )
        val portal = BrowserTabInfo(
            id = "portal", owner = task, title = "登录 · 财务平台", url = "https://portal.example.com/login",
            site = "portal.example.com", status = BrowserTabStatus.Waiting, heldBy = if (took) phone else null,
            action = BrowserAgentAction(tool = "needs_user", description = "等你：短信验证码"),
            viewport = if (took) phoneSize(phone) else agentSize, openedAt = 3,
        )
        val yours = mutableListOf(
            BrowserTabInfo(
                id = "mesh", title = "Mesh · 网状连接（演示）", url = "file:///Users/me/Projects/AgentSwitch/docs/design/concepts/mesh.html",
                site = "~/Projects/AgentSwitch/docs/design/concepts/mesh.html", kind = BrowserPlaceKind.File, heldBy = phone, viewport = phoneSize(phone), openedAt = 4,
            ),
            BrowserTabInfo(
                id = "vite", title = "Acme · Dev", url = "http://localhost:5173/", site = "localhost:5173", kind = BrowserPlaceKind.Local,
                heldBy = phone, viewport = phoneSize(phone), openedAt = 5,
            ),
        )
        if (screen == "browserdenied") {
            yours.add(BrowserTabInfo(
                id = "denied", title = "Not Viewable", url = "file:///Users/me/Projects/app/.env", site = "~/Projects/app/.env",
                kind = BrowserPlaceKind.File, heldBy = phone, viewport = phoneSize(phone), openedAt = 6,
            ))
        }
        return BrowserTabList(running = true, groups = listOf(
            BrowserTabGroup(codex, listOf(pr, issues)), BrowserTabGroup(task, listOf(portal)), BrowserTabGroup(BrowserTabOwner.you, yours),
        ))
    }

    val servers = listOf(
        BrowserLocalServer(port = 5173, pid = 4211, name = "vite", cwd = "/Users/me/Projects/site"),
        BrowserLocalServer(port = 3000, bind = "all", pid = 4388, name = "next dev", cwd = "/Users/me/Projects/web"),
    )
    val recent = listOf("github.com/acme/app/pulls", "~/Projects/AgentSwitch/docs/design/implemented/browser.html", "localhost:3000")

    /**
     * The page zoom the demo phone remembers: none, but the dev server's pages at 50% on `browserzoom` (browser-v0 §1
     * 页面缩放) — whatever was kept on the phone is not shown.
     */
    fun zoom(screen: String?): BrowserZoomMemory =
        if (screen == "browserzoom") BrowserZoomMemory().setting(50, "localhost:5173") else BrowserZoomMemory()

    /** `browserprofiles`: a profile's own browser beside the shared one (the store shows the last). */
    val profileBrowsers: List<BrowserChoice> = listOf(
        BrowserChoice.shared,
        BrowserChoice(key = "abc123def0", name = "cwork1", exit = BrowserChoice.Exit(ip = "203.0.113.9", place = "Tokyo"), running = true),
    )

    /** The tab a demo screen opens. */
    fun openRequest(screen: String?): String? = when (screen) {
        "browserpage", "browserclose", "browserzoomwatch" -> "pr"
        "browsertook" -> "portal"
        "browserfile" -> "mesh"
        "browserlocal", "browserzoom" -> "vite"
        "browserdenied" -> "denied"
        "browsernew" -> "new"
        else -> null
    }

    /** A tab's picture at its size, as the Mac would send it. Null: no mock page for this tab. */
    fun frame(tab: BrowserTabInfo, phone: Size? = null): BrowserFrame? {
        val w = (phone?.width ?: tab.viewport.width).let { Math.round(it).toInt() }.coerceAtLeast(1)
        val h = (phone?.height ?: tab.viewport.height).let { Math.round(it).toInt() }.coerceAtLeast(1)
        val draw: (Pen) -> Unit = when (tab.id) {
            "pr" -> { p -> pullRequest(p) }
            "issues" -> { p -> issues(p) }
            "portal" -> { p -> login(p, tab.viewport.mobile) }
            "mesh" -> { p -> filePage(p) }
            "vite" -> { p -> devPage(p) }
            "denied" -> { p -> denied(p) }
            else -> return null
        }
        // A page longer than its window (zoomed in) shows its top, as a page does.
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        draw(Pen(Canvas(bitmap), w.toFloat(), h.toFloat()))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
        bitmap.recycle()
        return BrowserFrame(seq = 1, jpeg = out.toByteArray(), width = w.toDouble(), height = h.toDouble())
    }

    // MARK: mock pages (other people's sites, in their own colours)

    private fun rgb(r: Double, g: Double, b: Double) = Color.rgb((r * 255).toInt(), (g * 255).toInt(), (b * 255).toInt())
    private fun gray(w: Double) = rgb(w, w, w)

    private val ink = rgb(0.12, 0.14, 0.16)
    private val ink2 = rgb(0.35, 0.39, 0.43)
    private val line = rgb(0.82, 0.85, 0.88)
    private val green = rgb(0.12, 0.53, 0.24)
    private val blue = rgb(0.04, 0.41, 0.85)

    /** A little pen over a canvas: filled and stroked shapes, a line of text, a wrapped paragraph. */
    private class Pen(val c: Canvas, val width: Float, val height: Float) {
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG)

        fun rect(x: Float, y: Float, w: Float, h: Float, color: Int) { fill.style = Paint.Style.FILL; fill.color = color; c.drawRect(x, y, x + w, y + h, fill) }
        fun rrect(x: Float, y: Float, w: Float, h: Float, r: Float, color: Int) { fill.style = Paint.Style.FILL; fill.color = color; c.drawRoundRect(RectF(x, y, x + w, y + h), r, r, fill) }
        fun circle(cx: Float, cy: Float, r: Float, color: Int) { fill.style = Paint.Style.FILL; fill.color = color; c.drawCircle(cx, cy, r, fill) }

        /** SwiftUI's `strokeBorder`: the stroke inside the shape. */
        fun border(x: Float, y: Float, w: Float, h: Float, r: Float, color: Int, lineWidth: Float) {
            fill.style = Paint.Style.STROKE; fill.color = color; fill.strokeWidth = lineWidth
            val i = lineWidth / 2
            c.drawRoundRect(RectF(x + i, y + i, x + w - i, y + h - i), maxOf(r - i, 0f), maxOf(r - i, 0f), fill)
            fill.style = Paint.Style.FILL
        }

        private fun paint(size: Float, color: Int, bold: Boolean, mono: Boolean) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = size; this.color = color
            typeface = Typeface.create(if (mono) Typeface.MONOSPACE else Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
        }

        fun measure(s: String, size: Float, bold: Boolean = false, mono: Boolean = false) = paint(size, 0, bold, mono).measureText(s)

        /** The line's height, as a text view would give it. */
        fun lineHeight(size: Float, mono: Boolean = false): Float = paint(size, 0, false, mono).fontMetrics.let { it.descent - it.ascent }

        /** One line with its top at `y`; returns its height. */
        fun text(s: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean = false, mono: Boolean = false): Float {
            val p = paint(size, color, bold, mono)
            c.drawText(s, x, y - p.fontMetrics.ascent, p)
            return p.fontMetrics.descent - p.fontMetrics.ascent
        }

        /** One line centred in a box. */
        fun centered(s: String, x: Float, y: Float, w: Float, h: Float, size: Float, color: Int, bold: Boolean = false) {
            val p = paint(size, color, bold, false)
            val m = p.fontMetrics
            c.drawText(s, x + (w - p.measureText(s)) / 2, y + (h - (m.descent - m.ascent)) / 2 - m.ascent, p)
        }

        /** A paragraph wrapped at `w`, its top at `y`; returns its height. */
        fun para(s: String, x: Float, y: Float, w: Float, size: Float, color: Int, bold: Boolean = false, mono: Boolean = false): Float {
            val layout = StaticLayout.Builder.obtain(s, 0, s.length, paint(size, color, bold, mono), w.toInt().coerceAtLeast(1))
                .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).build()
            c.save(); c.translate(x, y); layout.draw(c); c.restore()
            return layout.height.toFloat()
        }

        fun paraHeight(s: String, w: Float, size: Float, bold: Boolean = false, mono: Boolean = false): Float =
            StaticLayout.Builder.obtain(s, 0, s.length, paint(size, 0, bold, mono), w.toInt().coerceAtLeast(1)).setIncludePad(false).build().height.toFloat()

        fun gradient(x: Float, y: Float, w: Float, h: Float, from: Int, to: Int) {
            fill.shader = LinearGradient(x, 0f, x + w, 0f, from, to, Shader.TileMode.CLAMP)
            c.drawRect(x, y, x + w, y + h, fill)
            fill.shader = null
        }
    }

    private fun pullRequest(p: Pen) {
        p.rect(0f, 0f, p.width, p.height, Color.WHITE)
        p.rect(0f, 0f, 640f, 64f, ink)
        p.circle(28f + 9f, 32f, 9f, Color.WHITE)
        val h = p.lineHeight(18f)
        p.text("acme / app", 28f + 18f + 10f, (64f - h) / 2, 18f, Color.WHITE, bold = true)
        // The title, then the badge, the line under it, the tabs and a rule.
        var y = 92f
        val titleH = p.text("Add native Dispatch page ", 28f, y, 30f, ink, bold = true)
        p.text("#128", 28f + p.measure("Add native Dispatch page ", 30f, bold = true), y, 30f, ink2)
        y += titleH + 14
        val badge = "◉ Open"
        val bw = p.measure(badge, 18f, bold = true) + 32
        val bh = p.lineHeight(18f) + 12
        p.rrect(28f, y, bw, bh, bh / 2, green)
        p.text(badge, 28f + 16, y + 6, 18f, Color.WHITE, bold = true)
        y += bh + 14
        y += p.text("codex-bot wants to merge 14 commits into main", 28f, y, 18f, ink2) + 14
        var x = 28f
        val th = p.lineHeight(18f)
        p.text("Conversation", x, y, 18f, ink)
        val cw = p.measure("Conversation", 18f)
        p.rect(x, y + th + 8 - 3, cw, 3f, rgb(0.99, 0.55, 0.45))
        x += cw + 26
        for (t in listOf("Commits 14", "Checks 3", "Files 38")) {
            p.text(t, x, y, 18f, ink2)
            x += p.measure(t, 18f) + 26
        }
        y += th + 8 + 14
        p.rect(28f, y, 584f, 1f, line)
        // The checks.
        p.border(28f, 380f, 584f, 280f, 10f, line, 2f)
        var cy = 380f + 24
        for (t in listOf("All checks have passed", "No conflicts with base branch", "Merging can be performed automatically")) {
            p.circle(28f + 24 + 9, cy + 11, 9f, green)
            p.text(t, 28f + 24 + 18 + 12, cy, 18f, ink)
            cy += p.lineHeight(18f) + 14
        }
        // The merge button where the agent clicks.
        val m = mergeBox
        p.rrect(m.x.toFloat(), m.y.toFloat(), m.width.toFloat(), m.height.toFloat(), 10f, green)
        p.centered("Merge pull request", m.x.toFloat(), m.y.toFloat(), m.width.toFloat(), m.height.toFloat(), 20f, Color.WHITE, bold = true)
        // The comment.
        val body = "The Dispatch page is native now. Checks pass on macOS 27 and iOS 27."
        val inner = 584f - 40
        val bodyH = p.paraHeight(body, inner, 17f)
        val titleH2 = p.lineHeight(17f)
        p.border(28f, 700f, 584f, 20 + titleH2 + 10 + bodyH + 20, 10f, line, 2f)
        p.text("codex-bot commented", 28f + 20, 720f, 17f, ink, bold = true)
        p.para(body, 28f + 20, 720f + titleH2 + 10, inner, 17f, ink2)
    }

    private fun issues(p: Pen) {
        p.rect(0f, 0f, p.width, p.height, Color.WHITE)
        p.rect(0f, 0f, p.width, 64f, ink)
        p.text("●  acme / app", 28f, (64f - p.lineHeight(18f)) / 2, 18f, Color.WHITE, bold = true)
        var y = 64f + 28
        y += p.text("Issues", 28f, y, 30f, ink, bold = true) + 16
        y += p.text("12 Open · 48 Closed", 28f, y, 18f, ink2) + 16
        for (title in listOf("Dispatch page loses the scroll position", "Sealed reply box covers the key bar", "Tailscale relay: frames stall", "Dark mode for the onboarding")) {
            y += p.text(title, 28f, y, 19f, ink, bold = true) + 6
            y += p.text("opened 2 days ago by l0tk3", 28f, y, 15f, ink2) + 16
            p.rect(28f, y, p.width - 56f, 1f, line)
            y += 1 + 16
        }
    }

    private fun login(p: Pen, phone: Boolean) {
        val k = if (phone) 1f else 1.5f
        p.rect(0f, 0f, p.width, p.height, Color.WHITE)
        val x = 26 * k
        val w = p.width - 52 * k
        var y = 40 * k
        p.centered("财务平台", 0f, y, p.width, p.lineHeight(22 * k), 22 * k, ink, bold = true)
        y += p.lineHeight(22 * k) + 8 * k + 12 * k
        y += p.text("邮箱", x, y, 13 * k, ink, bold = true) + 12 * k
        field(p, "finance@me.com", false, x, y, w, k)
        y += 40 * k + 12 * k
        y += p.text("密码", x, y, 13 * k, ink, bold = true) + 12 * k
        field(p, "", true, x, y, w, k)
        y += 40 * k + 12 * k + 6 * k
        p.rrect(x, y, w, 40 * k, 6 * k, green)
        p.centered("登录", x, y, w, 40 * k, 15 * k, Color.WHITE, bold = true)
        y += 40 * k + 12 * k
        p.centered("忘记密码？", x, y, w, p.lineHeight(13 * k), 13 * k, blue)
    }

    private fun field(p: Pen, text: String, focus: Boolean, x: Float, y: Float, w: Float, k: Float) {
        p.rrect(x, y, w, 40 * k, 6 * k, Color.WHITE)
        val th = p.lineHeight(15 * k)
        if (text.isNotEmpty()) p.text(text, x + 10 * k, y + (40 * k - th) / 2, 15 * k, ink)
        if (focus) p.rect(x + 10 * k + 1, y + (40 * k - 18 * k) / 2, 1.5f, 18 * k, ink)
        p.border(x, y, w, 40 * k, 6 * k, if (focus) blue else line, if (focus) 2f else 1f)
    }

    private fun filePage(p: Pen) {
        p.rect(0f, 0f, p.width, p.height, Color.BLACK)
        val fg = gray(0.91)
        val x = 18f
        var y = 18f
        y += p.text("Mesh · 网状连接（演示）", x, y, 17f, fg, bold = true, mono = true) + 12
        y += p.para("每台 Mac 本来就是服务端：手机与 iPad 连到其中任一台，任务在 Mac 之间转交。", x, y, p.width - 36, 13f, gray(0.55), mono = true) + 12
        y += 8
        val gap = 6f
        fun node(name: String, nx: Float, ny: Float): Float {
            val tw = p.measure(name, 13f, mono = true)
            val nh = p.lineHeight(13f, true) + 12
            p.text(name, nx + 8, ny + 6, 13f, fg, mono = true)
            p.border(nx, ny, tw + 16, nh, 0f, gray(0.3), 1f)
            return tw + 16
        }
        val rowH = p.lineHeight(13f, true) + 12
        var nx = x
        nx += node("MacBook Pro", nx, y) + gap
        nx += p.measure("──", 13f, mono = true).also { p.text("──", nx, y + 6, 13f, fg, mono = true) } + gap
        node("Mac mini", nx, y)
        y += rowH + 10
        nx = x
        nx += node("iPad", nx, y) + gap
        nx += p.measure("┈┈", 13f, mono = true).also { p.text("┈┈", nx, y + 6, 13f, fg, mono = true) } + gap
        node("iPhone 17 Pro", nx, y)
        y += rowH + 12 + 12
        p.text("（mesh.html 在 Mac 上渲染，这里是它的画面）", x, y, 12f, gray(0.32), mono = true)
    }

    private fun devPage(p: Pen) {
        val bg = rgb(0.05, 0.07, 0.09)
        val dim = rgb(0.62, 0.65, 0.7)
        val fg = rgb(0.9, 0.93, 0.95)
        p.rect(0f, 0f, p.width, p.height, bg)
        val headH = p.lineHeight(22f) + 40
        p.gradient(0f, 0f, p.width, headH, rgb(0.43, 0.16, 0.85), rgb(0.86, 0.15, 0.47))
        p.text("Acme · Dev", 20f, 20f, 22f, Color.WHITE, bold = true)
        var y = headH + 18
        y += p.text("vite v6 · HMR connected", 18f, y, 14f, dim) + 12
        val cardW = p.width - 36
        fun card(lines: List<Triple<String, Float, Boolean>>) {
            val inner = cardW - 28
            var h = 28f
            for ((i, l) in lines.withIndex()) h += p.paraHeight(l.first, inner, l.second, l.third) + (if (i > 0) 4 else 0)
            p.rrect(18f, y, cardW, h, 8f, rgb(0.09, 0.11, 0.13))
            var cy = y + 14
            for ((i, l) in lines.withIndex()) {
                if (i > 0) cy += 4
                cy += p.para(l.first, 32f, cy, inner, l.second, if (l.third) fg else dim, l.third)
            }
            y += h + 12
        }
        card(listOf(Triple("Dashboard", 15f, false), Triple("$12,480", 28f, true)))
        card(listOf(Triple("改了 src/App.tsx，热更新后这里立即变。", 15f, false)))
        card(listOf(Triple("Orders", 15f, false), Triple("318", 28f, true)))
    }

    /** The Mac's own refusal page (playwrightDriver.ts refusalPage), as it shows in a tab. */
    private fun denied(p: Pen) {
        p.rect(0f, 0f, p.width, p.height, Color.BLACK)
        val body = "~/Projects/app/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。"
        val w = p.width - 64
        val inner = w - 28
        val titleH = p.lineHeight(13f, true)
        val bodyH = p.paraHeight(body, inner, 14f)
        p.border(32f, 32f, w, 14 + titleH + 8 + bodyH + 14, 0f, rgb(0.91, 0.9, 0.87), 1f)
        p.text("[!] Not Viewable", 32f + 14, 32f + 14, 13f, rgb(1.0, 0.69, 0.0), bold = true, mono = true)
        p.para(body, 32f + 14, 32f + 14 + titleH + 8, inner, 14f, rgb(0.55, 0.54, 0.52))
    }
}
