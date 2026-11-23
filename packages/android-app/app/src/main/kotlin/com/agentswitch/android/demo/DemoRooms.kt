package com.agentswitch.android.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.agentswitch.kit.api.RoomClaim
import com.agentswitch.kit.api.RoomDetail
import com.agentswitch.kit.api.RoomFace
import com.agentswitch.kit.api.RoomFile
import com.agentswitch.kit.api.RoomFiles
import com.agentswitch.kit.api.RoomInfo
import com.agentswitch.kit.api.RoomList
import com.agentswitch.kit.api.RoomMessage
import com.agentswitch.kit.api.RoomNotes
import com.agentswitch.kit.api.RoomSeat
import com.agentswitch.kit.api.RoomSummary
import com.agentswitch.kit.api.RoomTask
import com.agentswitch.kit.api.RoomTaskCounts
import com.agentswitch.kit.api.SeatCard

/**
 * The Rooms tab's sample rooms (docs/chatroom-v0.md §9, §10), for looking at the screens with no Mac: `rooms` (the
 * list), `room` (one room's page), `roommembers` and `roomcard` (who is changing which files), `roomtasks`, `roomtask`
 * and `roomtasknew` (the task list, one task, a new one), `roomfiles` (the shared folder). The room's messages come
 * with files: two pictures (one the user's, one a session's) and two text files, read from [bytes].
 */
object DemoRooms {
    const val room = "ab12cd34ef"
    private const val repo = "/Users/me/Desktop/WorkSpace/Projects/AgentSwitch"
    private const val folder = "/Users/me/.agentswitch/room-files/$room"
    private fun ago(minutes: Int): Long = DemoData.now - minutes * 60_000L

    private val daemonFace = RoomFace(listOf("#.#.#", ".###.", "##.##", ".###.", "#.#.#"), 3)
    private val webFace = RoomFace(listOf("##.##", "#...#", "..#..", "#...#", "##.##"), 2)
    private val docsFace = RoomFace(listOf(".###.", "#.#.#", "#####", "#...#", ".#.#."), 6)

    private val seats = listOf(
        RoomSeat(handle = RoomSeat.you, kind = "user", joinedAt = ago(300), canAdd = true),
        RoomSeat(
            handle = "daemon", terminal = "a1b2c3d4", face = daemonFace, joinedAt = ago(299), canAdd = true, stateName = "busy", kit = true,
            card = SeatCard(agent = "claude-code", name = "daemon", cwd = "$repo/packages/daemon", model = "claude-opus-5-5", profile = "Work", colorName = "mint", mode = "default"),
        ),
        RoomSeat(
            handle = "web", terminal = "t2", face = webFace, joinedAt = ago(298), stateName = "idle", kit = true,
            card = SeatCard(agent = "codex", name = "web", cwd = "$repo/packages/web", model = "gpt-6-luna", mode = "auto"),
        ),
        RoomSeat(
            handle = "docs", terminal = "t3", face = docsFace, joinedAt = ago(120), addedBy = "daemon", byAgent = true, stateName = "waiting", kit = true,
            card = SeatCard(agent = "claude-code", name = "docs", cwd = "$repo/docs", model = "claude-sonnet-4-6", mode = "default"),
        ),
    )

    private val tasks = listOf(
        RoomTask(n = 1, title = "定登录接口", stateName = "done", owner = "daemon", by = RoomSeat.you, createdAt = ago(280), updatedAt = ago(200), note = "接口写在 api.md：POST /login，返回 token 和过期时间"),
        RoomTask(n = 2, title = "服务端实现 /login 和刷新 token", detail = "按 api.md。密码错误五次后锁十分钟；刷新 token 只能用一次。", stateName = "doing", owner = "daemon", by = RoomSeat.you, createdAt = ago(270), updatedAt = ago(35), after = listOf(1)),
        RoomTask(n = 3, title = "登录页：表单、错误提示、记住我", stateName = "doing", owner = "web", by = "daemon", createdAt = ago(260), updatedAt = ago(50), after = listOf(1)),
        RoomTask(n = 4, title = "联调：登录页接上真实接口", stateName = "todo", owner = "web", by = RoomSeat.you, createdAt = ago(250), updatedAt = ago(250), after = listOf(2, 3)),
        RoomTask(n = 5, title = "写登录流程的说明文档", detail = "放到共享文件夹，给之后接手的人看。", stateName = "todo", by = "daemon", createdAt = ago(110), updatedAt = ago(110), after = listOf(4)),
        RoomTask(n = 6, title = "补登录失败的测试", stateName = "todo", by = "web", createdAt = ago(40), updatedAt = ago(40)),
        RoomTask(n = 7, title = "把旧的 session cookie 逻辑标成废弃", stateName = "done", owner = "docs", by = "daemon", createdAt = ago(100), updatedAt = ago(60), note = "见 deprecations.md"),
    )

    private val claims = listOf(
        RoomClaim(handle = "daemon", paths = listOf("packages/daemon/src/api/login.ts", "packages/daemon/src/auth/", "packages/daemon/tests/login.test.ts", "packages/daemon/src/api/app.ts"), why = "实现 /login", at = ago(30), until = DemoData.now + 25 * 60_000L),
        RoomClaim(handle = "web", paths = listOf("packages/web/src/pages/Login.tsx"), at = ago(12), until = DemoData.now + 18 * 60_000L),
    )

    private val messages = listOf(
        RoomMessage(seq = 1, from = RoomSeat.you, to = listOf("daemon", "web"), text = "@daemon @web 这周把登录做完。先定接口，任务我写在任务表里了，页面草图见图。", at = ago(280), files = listOf("$folder/sketch.jpg")),
        RoomMessage(seq = 2, from = "daemon", to = listOf("web", RoomSeat.you), replyTo = 1, text = "接口定好了 @web @you，见 `api.md`。T1 已完成，我接着做 T2。", at = ago(200), files = listOf("$folder/api.md")),
        RoomMessage(seq = 3, from = "web", to = listOf("daemon"), text = "@daemon 收到。我领了 T3，在改 `Login.tsx`，现在的样子见截图。", at = ago(50), files = listOf("$folder/screens/login.png"), task = 3),
        RoomMessage(seq = 4, from = "daemon", text = "我在改 `src/auth/` 和 `login.ts`，改完之前先别动这两处。", at = ago(30), task = 2),
        RoomMessage(seq = 5, from = "docs", to = listOf(RoomSeat.you), text = "@you 旧 cookie 逻辑已标成废弃（T7），清单在共享文件夹的 `deprecations.md`。", at = ago(8), files = listOf("$folder/deprecations.md")),
    )

    val detail = RoomDetail(
        room = RoomInfo(id = room, name = "登录", topic = "这周把登录做完：先定接口，再分头实现。", createdAt = ago(300), lastSeq = 5, readSeq = 4),
        seats = seats, messages = messages,
        notes = RoomNotes(text = "接口：POST /login → { token, expiresAt }\n约定：改公共文件前先在房间里说一声。", at = ago(190), by = "daemon"),
        folder = folder, tasks = tasks, claims = claims,
    )

    val files = RoomFiles(
        folder = folder,
        files = listOf(
            RoomFile("deprecations.md", size = 1_840, modifiedAt = ago(9)),
            RoomFile("screens/login-error.png", size = 284_112, modifiedAt = ago(48)),
            RoomFile("screens/login.png", size = 301_577, modifiedAt = ago(52)),
            RoomFile("api.md", size = 4_206, modifiedAt = ago(201)),
            RoomFile("sketch.jpg", size = 96_420, modifiedAt = ago(281)),
            RoomFile("data/users-sample.json", size = 12_403_200, modifiedAt = ago(60 * 26)),
        ),
    )

    /** A made-up picture: a page with a form on it — a title, two fields, a button in `accent`. */
    private fun picture(width: Int, height: Int, ground: Int, accent: Int, format: Bitmap.CompressFormat): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val paint = Paint()
        fun fill(color: Int, x: Float, y: Float, w: Float, h: Float) { paint.color = color; c.drawRect(x, y, x + w, y + h, paint) }
        val light = Color.red(ground) > 128
        val ink = if (light) Color.rgb(40, 40, 46) else Color.rgb(232, 232, 236)
        val field = if (light) Color.rgb(226, 226, 232) else Color.rgb(52, 52, 60)
        fill(ground, 0f, 0f, width.toFloat(), height.toFloat())
        val left = width * 0.14f
        val wide = width * 0.72f
        fill(ink, left, height * 0.14f, wide * 0.45f, height * 0.05f)
        fill(field, left, height * 0.3f, wide, height * 0.1f)
        fill(field, left, height * 0.46f, wide, height * 0.1f)
        fill(accent, left, height * 0.66f, wide, height * 0.11f)
        val out = java.io.ByteArrayOutputStream()
        bitmap.compress(format, 85, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    /** The room's files as their bytes, by where each would be on the Mac: the timeline's pictures and what a tap opens. */
    val bytes: Map<String, ByteArray> by lazy {
        mapOf(
            "$folder/sketch.jpg" to picture(640, 480, Color.rgb(246, 244, 238), Color.rgb(60, 60, 68), Bitmap.CompressFormat.JPEG),
            "$folder/screens/login.png" to picture(390, 720, Color.rgb(22, 22, 26), Color.rgb(255, 45, 85), Bitmap.CompressFormat.PNG),
            "$folder/screens/login-error.png" to picture(390, 720, Color.rgb(22, 22, 26), Color.rgb(255, 159, 10), Bitmap.CompressFormat.PNG),
            "$folder/api.md" to "# 登录接口\n\n## POST /login\n\n请求：`{ \"name\": string, \"password\": string }`\n\n返回：`{ \"token\": string, \"expiresAt\": number }`\n\n- 密码错误五次后锁十分钟。\n- 刷新 token 只能用一次。\n".toByteArray(),
            "$folder/deprecations.md" to "# 废弃清单\n\n- `session` cookie：改用 token，下个版本删除。\n- `GET /whoami`：改用 `GET /me`。\n".toByteArray(),
        )
    }

    val list = RoomList(listOf(
        RoomSummary(
            id = room, name = "登录", topic = detail.room.topic, createdAt = ago(300), members = 4,
            faces = listOf(RoomSummary.Sitter("daemon", daemonFace), RoomSummary.Sitter("web", webFace), RoomSummary.Sitter("docs", docsFace)),
            last = RoomSummary.Last(seq = 5, from = "docs", text = messages.last().text, at = ago(8)), unread = 1, forYou = true,
            tasks = RoomTaskCounts(todo = 3, doing = 2, done = 2),
        ),
        RoomSummary(id = "cd34ef56ab", name = "博客迁移", topic = "换主题之后的构建问题", paused = true, createdAt = ago(3000), members = 2, last = RoomSummary.Last(seq = 12, from = RoomSeat.you, text = "先停一下，明天再说", at = ago(1400))),
    ))
}
