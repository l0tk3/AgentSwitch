package com.agentswitch.android.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.FileChangeError
import com.agentswitch.kit.api.FileNames
import com.agentswitch.kit.api.FileRefusal
import com.agentswitch.kit.api.MacFileDetails
import com.agentswitch.kit.api.MacFileEntry
import com.agentswitch.kit.api.MacFilePreview
import com.agentswitch.kit.api.MacFileSource
import com.agentswitch.kit.api.MacFileType
import com.agentswitch.kit.api.MacFolder
import com.agentswitch.kit.api.MacMade
import com.agentswitch.kit.api.MacMoved
import com.agentswitch.kit.api.MacPath
import com.agentswitch.kit.api.MacUploaded
import com.agentswitch.kit.api.UploadConflict
import com.agentswitch.kit.api.VersionedFolder
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.delay

/**
 * A made-up Mac disk for the Files demo screens (`uiDemoScreen files…`): the demo terminals' project, a home folder
 * with a picture, a PDF, a big download, AgentSwitch's own locked places and files that may hold a password. Nothing
 * here is the user's: names and contents are invented. `scope`: as a device given only that folder would see it
 * (docs/files-v0.md §7.5).
 */
class DemoFiles(private val scope: String?) : MacFileSource {
    private class Node(
        val kind: MacFileEntry.Kind,
        val size: Long = 0,
        val mtime: Long,
        val text: String? = null,
        val locked: Boolean = false,
        val dim: Boolean = false,
        val sensitive: String? = null,
    )

    private fun inScope(p: String): Boolean = scope?.let { p == it || p.startsWith("$it/") } ?: true
    private fun leadsIn(p: String): Boolean = scope?.startsWith(if (p == "/") "/" else "$p/") ?: false

    private fun children(p: String): List<Pair<String, Node>> =
        synchronized(tree) { tree.filter { MacPath.parent(it.key) == p && it.key != "/" }.map { MacPath.name(it.key) to it.value } }

    private fun entry(name: String, n: Node, dir: String): MacFileEntry =
        MacFileEntry(name = name, kind = n.kind, size = if (n.locked) 0 else n.size, mtime = if (n.locked) 0 else n.mtime, dim = n.dim,
            locked = n.locked, fixed = !n.locked && fixed(MacPath.join(dir, name)))

    private fun refuse(code: String, status: Int = 403) = APIError.Http(status, code)

    /** `~` and `~/…` as the home folder, as the Mac takes them. */
    private fun expanded(p: String): String = if (p == "~") home else if (p.startsWith("~/")) home + p.substring(1) else p

    private fun node(p: String): Node? = synchronized(tree) { tree[p] }

    override suspend fun folder(path: String?, hidden: Boolean, etag: String?): VersionedFolder? {
        val p = path?.let { expanded(it) } ?: scope ?: home
        val node = node(p) ?: throw refuse("not-found", 404)
        if (node.kind != MacFileEntry.Kind.Dir) throw refuse("not-folder", 400)
        if (node.locked) throw refuse("locked")
        val scoped = !inScope(p)
        if (scoped && !leadsIn(p)) throw refuse("scope")
        var kids = children(p)
        if (scoped) kids = kids.filter { inScope(MacPath.join(p, it.first)) || leadsIn(MacPath.join(p, it.first)) }
        val shown = kids.filter { hidden || !it.first.startsWith(".") }
        val sorted = shown.sortedWith { a, b ->
            val fa = a.second.kind == MacFileEntry.Kind.Dir
            val fb = b.second.kind == MacFileEntry.Kind.Dir
            if (fa != fb) return@sortedWith if (fa) -1 else 1
            a.first.trim('.').compareTo(b.first.trim('.'), ignoreCase = true)
        }
        val version = "\"$p|$hidden\""
        if (etag == version) return null
        val level = MacFolder(path = p, parent = MacPath.parent(p), home = home, entries = sorted.map { entry(it.first, it.second, p) },
            hiddenCount = kids.size - shown.size, scoped = scoped)
        return VersionedFolder(level, version)
    }

    override suspend fun fileDetails(path: String): MacFileDetails {
        val p = expanded(path)
        val n = node(p) ?: throw refuse("not-found", 404)
        if (n.locked) throw refuse("locked")
        if (!inScope(p) && !leadsIn(p)) throw refuse("scope")
        if (n.kind == MacFileEntry.Kind.Dir) return MacFileDetails(name = MacPath.name(p), kind = MacFileEntry.Kind.Dir, size = 0, mtime = n.mtime, path = p, items = children(p).size)
        val ext = p.substringAfterLast('.', "").lowercase()
        val type = when {
            ext == "png" || ext == "jpg" -> MacFileType.Image
            ext == "pdf" -> MacFileType.Pdf
            ext == "zip" -> MacFileType.Archive
            n.text != null -> MacFileType.Text
            else -> MacFileType.Binary
        }
        val lines = n.text?.let { t -> t.split("\n").size - (if (t.endsWith("\n")) 1 else 0) }
        return MacFileDetails(name = MacPath.name(p), kind = MacFileEntry.Kind.File, size = n.size, mtime = n.mtime, path = p, type = type, lines = lines, sensitive = n.sensitive)
    }

    override suspend fun filePreview(path: String): MacFilePreview {
        val n = node(expanded(path))
        val text = n?.text ?: throw refuse("not-text", 415)
        return MacFilePreview(text = text, truncated = false, lines = null, size = n.size)
    }

    override suspend fun fileThumbnail(path: String): ByteArray {
        if (node(path) == null) throw refuse("not-found", 404)
        // A made-up picture: a window with three lines, or the logo's bars.
        val bitmap = Bitmap.createBitmap(480, 320, Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val paint = Paint()
        fun fill(color: Int, x: Float, y: Float, w: Float, h: Float) { paint.color = color; c.drawRect(x, y, x + w, y + h, paint) }
        fun white(w: Float) = Color.rgb((w * 255).toInt(), (w * 255).toInt(), (w * 255).toInt())
        fill(white(0.16f), 0f, 0f, 480f, 320f)
        fill(white(0.04f), 40f, 40f, 400f, 240f)
        val colors = listOf(Color.rgb(255, 45, 85), white(0.9f), white(0.55f))
        for ((i, color) in colors.withIndex()) fill(color, 80f, 100f + i * 40f, (260 - i * 60).toFloat(), 18f)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    // MARK: changes (docs/files-v0.md §12)

    private fun fail(refusal: FileRefusal, status: Int = 409) = FileChangeError(refusal = refusal, status = status)

    /** Not to be renamed or moved: AgentSwitch's places, home and what holds them, what is right under `/`. */
    private fun fixed(p: String): Boolean =
        p == "/" || MacPath.parent(p) == "/" || node(p)?.locked == true || p in listOf(home, "/Users", "$home/.agentswitch")

    private fun make(path: String, kind: MacFileEntry.Kind): MacMade {
        if (node(path) != null) throw fail(FileRefusal.Exists)
        var top: String? = null
        var at = path
        val chain = ArrayList<String>()
        while (node(at) == null) {
            val up = MacPath.parent(at) ?: break
            chain.add(0, at)
            at = up
        }
        val base = node(at)
        if (base?.kind != MacFileEntry.Kind.Dir || base.locked || at == "/") throw fail(FileRefusal.Locked, 403)
        for ((i, p) in chain.withIndex()) {
            synchronized(tree) {
                tree[p] = if (i == chain.size - 1 && kind == MacFileEntry.Kind.File) Node(MacFileEntry.Kind.File, 0, System.currentTimeMillis(), text = "")
                else Node(MacFileEntry.Kind.Dir, mtime = System.currentTimeMillis())
            }
            top = top ?: p
        }
        return MacMade(path = path, top = top ?: path)
    }

    override suspend fun newFolder(path: String): MacMade = make(path, MacFileEntry.Kind.Dir)
    override suspend fun newFile(path: String): MacMade = make(path, MacFileEntry.Kind.File)

    override suspend fun rename(path: String, to: String, force: Boolean): String {
        if (node(path) == null) throw fail(FileRefusal.NotFound, 404)
        if (fixed(path)) throw fail(FileRefusal.Locked, 403)
        val target = MacPath.join(MacPath.parent(path) ?: "/", to)
        if (node(target) != null && target.lowercase() != path.lowercase()) throw fail(FileRefusal.Exists)
        synchronized(tree) {
            for ((k, v) in tree.entries.toList()) if (k == path || k.startsWith("$path/")) { tree.remove(k); tree[target + k.substring(path.length)] = v }
        }
        return target
    }

    override suspend fun trash(paths: List<String>, force: Boolean, permanent: Boolean): List<MacMoved> {
        for (p in paths) if (fixed(p)) throw fail(FileRefusal.Locked, 403)
        synchronized(tree) { for (p in paths) tree.keys.toList().forEach { if (it == p || it.startsWith("$p/")) tree.remove(it) } }
        return paths.map { MacMoved(path = it, trashed = "$home/.Trash/${MacPath.name(it)}") }
    }

    override suspend fun upload(file: File, to: String, conflict: UploadConflict, progress: (Double) -> Unit): MacUploaded {
        val size = file.length()
        // A made-up link: the bytes go in twenty steps.
        for (step in 1..20) { delay(150); progress(step / 20.0) }
        var target = to
        if (node(to) != null) {
            when (conflict) {
                UploadConflict.Fail -> throw fail(FileRefusal.Exists)
                UploadConflict.Replace -> synchronized(tree) { tree.remove(to) }
                UploadConflict.Keep -> {
                    val dir = MacPath.parent(to) ?: "/"
                    target = MacPath.join(dir, FileNames.keepBoth(MacPath.name(to), children(dir).map { it.first }.toSet()))
                }
            }
        }
        synchronized(tree) { tree[target] = Node(MacFileEntry.Kind.File, size, System.currentTimeMillis()) }
        return MacUploaded(path = target, name = MacPath.name(target), size = size)
    }

    override suspend fun downloadFile(path: String, to: File, progress: (Double) -> Unit) {
        val n = node(path) ?: throw refuse("not-found", 404)
        for (step in 1..5) { delay(120); progress(step / 5.0) }
        val data = when {
            n.text != null -> n.text.toByteArray(Charsets.UTF_8)
            path.endsWith(".png") -> fileThumbnail(path)
            else -> pdf()
        }
        to.parentFile?.mkdirs()
        to.writeBytes(data)
    }

    /** One made-up page for the PDF. */
    private fun pdf(): ByteArray {
        val doc = PdfDocument()
        val page = doc.startPage(PdfDocument.PageInfo.Builder(420, 595, 1).create())
        val paint = Paint().apply { isAntiAlias = true; color = Color.BLACK }
        paint.typeface = Typeface.DEFAULT_BOLD; paint.textSize = 22f
        page.canvas.drawText("计划（示例）", 40f, 70f, paint)
        paint.typeface = Typeface.DEFAULT; paint.textSize = 14f
        page.canvas.drawText("这是演示用的 PDF，不是真的文件。", 40f, 114f, paint)
        doc.finishPage(page)
        val out = ByteArrayOutputStream()
        doc.writeTo(out)
        doc.close()
        return out.toByteArray()
    }

    companion object {
        const val home = "/Users/me"
        const val project = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
        const val scopeFolder = project

        private val now = System.currentTimeMillis()
        private fun ago(minutes: Long): Long = now - minutes * 60_000

        private val readme = """
            # AgentSwitch

            手机遥控 Mac 上多个 AI agent 的任务编排层（示例内容）。

            ## 布局

            - `docs/` 设计与决策记录
            - `packages/daemon/` 服务
            - `packages/ios-app/` iPhone 应用

            ## 运行

                npm install
                npm test
        """.trimIndent()
        private val pkg = """
            {
              "name": "agentswitch-demo",
              "private": true,
              "scripts": {
                "test": "vitest run"
              }
            }
        """.trimIndent()
        private val app = """
            import { createServer } from "node:http";

            // The demo's server: answers every request with the time.
            export function serve(port: number) {
              return createServer((_req, res) => {
                res.end(new Date().toISOString());
              }).listen(port);
            }
        """.trimIndent()
        private const val env = "PORT=5173\nAPI_BASE=http://127.0.0.1:8080\nSESSION_SECRET=change-me\n"
        private const val key = "-----BEGIN OPENSSH PRIVATE KEY-----\n（示例，不是真的密钥）\n-----END OPENSSH PRIVATE KEY-----\n"

        /** The disk as it is now: it changes as the demo screens make, rename, move and receive files (files-v0 §12). */
        private val tree: MutableMap<String, Node> = made()

        private fun made(): MutableMap<String, Node> {
            val t = HashMap<String, Node>()
            fun dir(p: String, m: Long, dim: Boolean = false, locked: Boolean = false) { t[p] = Node(MacFileEntry.Kind.Dir, mtime = m, locked = locked, dim = dim) }
            fun file(p: String, m: Long, size: Long? = null, text: String? = null, sensitive: String? = null, locked: Boolean = false) {
                t[p] = Node(MacFileEntry.Kind.File, size ?: (text?.toByteArray(Charsets.UTF_8)?.size?.toLong() ?: 0), m, text, locked, sensitive = sensitive)
            }
            dir("/", ago(9000)); dir("/Users", ago(9000)); dir("/Applications", ago(9000)); dir("/Library", ago(9000)); dir("/System", ago(9000))
            dir("/Users/Shared", ago(9000)); dir(home, ago(3))
            dir("$home/.agentswitch", ago(3)); dir("$home/.agentswitch/nodes", ago(900), locked = true)
            file("$home/.agentswitch/local-token", ago(900), size = 64, locked = true)
            dir("$home/.agentswitch/terminals", ago(4))
            dir("$home/.secret-gate", ago(2000), locked = true)
            dir("$home/.ssh", ago(40000))
            file("$home/.ssh/config", ago(40000), text = "Host github.com\n  IdentityFile ~/.ssh/id_ed25519\n")
            file("$home/.ssh/id_ed25519", ago(40000), text = key, sensitive = "ssh")
            file("$home/.ssh/id_ed25519.pub", ago(40000), text = "ssh-ed25519 AAAA…（示例） me@mac\n")
            file("$home/.zshrc", ago(20000), text = "export PATH=\"\$HOME/.local/bin:\$PATH\"\n")
            dir("$home/Desktop", ago(30)); file("$home/Desktop/screenshot.png", ago(30), size = 412_000)
            dir("$home/Documents", ago(5000)); file("$home/Documents/plan.pdf", ago(5000), size = 1_240_000)
            dir("$home/Downloads", ago(9000)); file("$home/Downloads/dataset.zip", ago(9000), size = 182_000_000)
            dir("$home/Blog", ago(3000)); file("$home/Blog/index.md", ago(3000), text = "# 博客\n\n第一篇（示例）。\n")
            dir("$home/Desktop/WorkSpace", ago(30)); dir("$home/Desktop/WorkSpace/Projects", ago(30))
            dir(project, ago(2))
            file("$project/.env", ago(7000), text = env, sensitive = "env")
            dir("$project/.git", ago(2), dim = true)
            dir("$project/docs", ago(60)); file("$project/docs/files-v0.md", ago(60), text = "# 文件 v0（示例）\n\n主窗口右侧的文件栏。\n")
            file("$project/docs/logo.png", ago(4000), size = 24_600)
            // The page the demo terminal's screen names (`terminallink`, `terminalpath`).
            dir("$project/docs/design", ago(90)); dir("$project/docs/design/concepts", ago(90))
            file("$project/docs/design/concepts/split.html", ago(90), text = "<!doctype html>\n<title>Split</title>\n<p>分屏的演示页（示例）。</p>\n")
            dir("$project/node_modules", ago(9000), dim = true)
            dir("$project/src", ago(5)); file("$project/src/app.ts", ago(5), text = app); file("$project/src/store.ts", ago(12), size = 3980, text = app)
            // A minified file: one long line (`filespreviewlong`).
            dir("$project/dist", ago(5))
            file("$project/dist/app.min.js", ago(5), text = "(()=>{\"use strict\";var e={812:(e,t,n)=>{n.d(t,{A:()=>r});const r=function(e){return e.split(\"/\").filter(Boolean)}}};".repeat(40))
            file("$project/src/main.ts", ago(3000), text = "import { serve } from \"./app\";\n\nserve(8080);\n")
            file("$project/README.md", ago(300), text = readme); file("$project/package.json", ago(9000), text = pkg)
            return t
        }
    }
}
