#if DEBUG
import AgentSwitchKit
import Foundation
import UIKit

/// The sample screens' rooms (`-uiDemo YES -uiDemoScreen rooms|room|roompaused|roomrounds|roomnotes|roomtasks|roomtaskadd|roomfiles|roommembers|roomcard|roomadd|roomnew`):
/// made up, as the Mac would give them.
enum DemoRooms {
    static let roomId = "a1b2c3d4e5"
    /// The dispatch desk (调度台): what the Dispatch tab shows.
    static let deskId = "desk000000"

    static var isDemo: Bool { UserDefaults.standard.bool(forKey: "uiDemo") }
    static var screen: String? { UserDefaults.standard.string(forKey: "uiDemoScreen") }

    static var list: RoomList {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return decode("""
        {"rooms":[
          {"id":"\(deskId)","name":"调度台","topic":"跟调度说要做什么","paused":false,"createdAt":0,"members":2,"faces":[],"desk":true,
           "last":{"seq":9,"from":"dispatch","text":"@you 已经开了 2 个会话去做订阅页，进度在「手机订阅」里。","at":\(now - 60_000)},"unread":1,"forYou":true},
          {"id":"\(roomId)","name":"手机订阅","topic":"让手机上的 Stash 和 Clash 拉到适配的配置","paused":false,"createdAt":1,"members":7,"faces":[],
           "last":{"seq":38,"from":"daemon","text":"@you 两个版本都用真的 mihomo 内核验过了。","at":\(now - 120_000)},"unread":2,"forYou":true,"tasks":{"todo":3,"doing":1,"done":2},"attention":3},
          {"id":"b1b2c3d4e5","name":"DayHub 发布","topic":"","paused":true,"createdAt":2,"members":3,"faces":[],
           "last":{"seq":12,"from":"you","text":"@all 先停一下，等我看完迁移脚本","at":\(now - 3_600_000)},"unread":0,"forYou":false},
          {"id":"c1b2c3d4e5","name":"文档整理","topic":"把 v0 文档里过期的段落标出来","paused":false,"createdAt":3,"members":2,"faces":[],"last":null,"unread":0,"forYou":false,"rounds":7,"attention":1},
          {"id":"d1b2c3d4e5","name":"安卓 Classic","topic":"","paused":false,"createdAt":4,"members":3,"faces":[],
           "last":{"seq":5,"from":"android","text":"图标都换好了，菜单在键盘上面。","at":\(now - 90_000_000)},"unread":3,"forYou":false}]}
        """)
    }

    static func detail(_ id: String) -> RoomDetail? {
        guard isDemo else { return nil }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if id == deskId {
            return decode("""
            {"room":{"id":"\(deskId)","name":"调度台","topic":"跟调度说要做什么","paused":false,"createdAt":0,"createdBy":"you","lastSeq":9,"readSeq":8,"rounds":null,"roundsLimit":6,"desk":true},
             "seats":[
              {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
              {"handle":"dispatch","kind":"session","terminal":"t-dispatch","face":{"rows":["#.#.#",".###.","#####",".###.","#.#.#"],"color":1},"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"idle","kit":true,
               "card":{"agent":"claude-code","name":"dispatch","cwd":"/Users/me/Projects","model":"claude-opus-5-5","profile":"Work","mode":"auto","node":null}}],
             "messages":[
              {"seq":7,"from":"you","to":[],"text":"手机上要能拉 Clash 订阅，iPhone 和安卓都做。","at":\(now - 900_000)},
              {"seq":8,"from":"dispatch","to":["you"],"replyTo":7,"text":"@you 好。开了房间「手机订阅」，拉了 daemon、mac-app、ios-app、android 四个会话进去，先定接口。","at":\(now - 840_000)},
              {"seq":9,"from":"dispatch","to":["you"],"text":"@you 已经开了 2 个会话去做订阅页，进度在「手机订阅」里。","at":\(now - 60_000)}]}
            """)
        }
        guard id == roomId else { return nil }
        func seat(_ handle: String, _ rows: String, _ color: Int, _ state: String, agent: String, model: String, profile: String?, dot: String?, canAdd: Bool = false, byAgent: Bool = false, by: String = "you") -> String {
            let face = rows.split(separator: " ").map { "\"\($0)\"" }.joined(separator: ",")
            return """
            {"handle":"\(handle)","kind":"session","terminal":"\(handle == "daemon" ? "a1b2c3d4" : "t-\(handle)")","face":{"rows":[\(face)],"color":\(color)},"joinedAt":1,"addedBy":"\(by)","canAdd":\(canAdd),"byAgent":\(byAgent),"left":null,"state":"\(state)","kit":\(handle != "ios-app"),
             "card":{"agent":"\(agent)","name":"\(handle)","cwd":"/Users/me/Projects/AgentSwitch/packages/\(handle)","model":"\(model)","profile":\(profile.map { "\"\($0)\"" } ?? "null"),\(dot.map { "\"color\":\"\($0)\"," } ?? "")"mode":"auto","node":null},"avatar":\(DemoAvatars.seat(handle))}
            """
        }
        let paused = screen == "roompaused"
        let rounds = screen == "roomrounds" ? "7" : "null"
        return decode("""
        {"room":{"id":"\(roomId)","name":"手机订阅","topic":"让手机上的 Stash 和 Clash 拉到适配的配置","paused":\(paused),"createdAt":1,"createdBy":"you","lastSeq":39,"readSeq":35,"rounds":\(rounds),"roundsLimit":6},
         "seats":[
          {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":1,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
          \(seat("daemon", "#.#.# .###. ##.## .###. #.#.#", 0, "busy", agent: "claude-code", model: "claude-fable-5-2", profile: "Work", dot: "violet", canAdd: true)),
          \(seat("mac-app", "##.## #...# ..#.. #.#.# .###.", 2, "idle", agent: "claude-code", model: "claude-opus-5-5", profile: "Work", dot: "violet")),
          \(seat("ios-app", ".###. #.#.# ##### ..#.. ##.##", 6, "waiting", agent: "codex", model: "gpt-6-sol", profile: nil, dot: nil)),
          \(seat("android", "#...# .#.#. ##.## #.#.# .###.", 4, "limited", agent: "opencode", model: "deepseek-flash", profile: "Side", dot: "mint", byAgent: true, by: "daemon")),
          \(seat("web", "..#.. .###. #.#.# ##.## #...#", 8, "signed_out", agent: "claude-code", model: "claude-sonnet-5-5", profile: "Old", dot: "sand")),
          \(seat("gate", "##.## ..#.. #.#.# ##### .#.#.", 9, "reconnecting", agent: "pi", model: "deepseek-flash", profile: nil, dot: nil))],
         "messages":[
          {"seq":31,"from":"you","to":["daemon"],"text":"@daemon 手机的订阅接口定了吗？","at":\(now - 86_400_000 - 600_000)},
          {"seq":32,"from":"daemon","to":["mac-app","ios-app"],"replyTo":31,"text":"接口定了：**`GET /clash` 多一个 `phone`**，里面是 `on`、`listening`、`links`、`problem`。@mac-app @ios-app 可以开始了。","at":\(now - 86_400_000 - 540_000),"task":1},
          {"seq":33,"from":"mac-app","to":[],"text":"收到，卡片今天做完。先看一眼样子：","at":\(now - 1_500_000),"files":["\(folder)/shots/stash-profile.png"],"task":2},
          {"seq":34,"from":"mac-app","to":["daemon"],"text":"@daemon `links` 里局域网和 Tailscale 的顺序固定吗？","at":\(now - 1_440_000),"task":2},
          {"seq":35,"from":"daemon","to":["mac-app"],"replyTo":32,"text":"固定，**局域网在前**。","at":\(now - 1_380_000),"task":1},
          {"seq":36,"from":"you","to":["web","gate","ios-app"],"text":"@web @gate @ios-app 文档里的地址也要跟着改","at":\(now - 900_000),"files":["/Users/me/Projects/AgentSwitch/docs/clash-v0.md","/Users/me/Projects/AgentSwitch/packages/daemon/src/clash/phone.ts"]},
          {"seq":37,"from":"ios-app","to":["you"],"replyTo":36,"text":"@you 订阅页的字段名还没定，`links` 是数组还是对象？定了我接着做。","at":\(now - 600_000),"task":4,"expects":"answer"},
          {"seq":38,"from":"daemon","to":["android","ios-app"],"text":"@android @ios-app `PROCESS-NAME` 的规则手机上都去掉了，重新拉一次配置。","at":\(now - 300_000),"task":3},
          {"seq":39,"from":"daemon","to":["you"],"text":"@you 两个版本都用真的 mihomo 内核验过了。","at":\(now - 120_000),"files":["\(folder)/mihomo-check.md","\(folder)/shots/clash-rules.png"],"task":3}],
         "receipts":{"36":{"web":"ended","gate":"queued"},"38":{"android":"queued","ios-app":"delivered"}},
         "reads":{"31":["daemon"],"36":["ios-app"],"38":["ios-app"]},
         "taskStats":{"1":{"wakes":4,"chars":8210,"posts":6,"calls":19},"2":{"wakes":3,"chars":5120,"posts":4,"calls":12},"4":{"wakes":5,"chars":23400,"posts":7,"calls":41}},
         "notes":{"text":"接口\\n- GET /clash 多一个 phone：on、listening、links、problem\\n- links 里局域网在前，Tailscale 在后\\n\\n待办\\n- [ ] 文档里的地址跟着改（@web）\\n- [x] 手机上去掉 PROCESS-NAME 规则","at":\(now - 1_300_000),"by":"daemon"},
         "folder":"\(folder)",
         "tasks":[
          {"n":1,"title":"定下手机订阅的接口","state":"done","owner":"daemon","by":"you","createdAt":\(now - 90_000_000),"updatedAt":\(now - 86_000_000),"note":"GET /clash 多一个 phone，写进置顶笔记了"},
          {"n":2,"title":"Mac 上的订阅卡片","detail":"局域网和 Tailscale 两个地址，局域网在前","state":"doing","owner":"mac-app","by":"daemon","createdAt":\(now - 86_000_000),"updatedAt":\(now - 1_500_000),"after":[1]},
          {"n":3,"title":"手机上去掉 PROCESS-NAME 规则","state":"done","owner":"daemon","by":"daemon","createdAt":\(now - 80_000_000),"updatedAt":\(now - 300_000)},
          {"n":4,"title":"iPhone 的订阅页","state":"blocked","owner":"ios-app","by":"you","createdAt":\(now - 70_000_000),"updatedAt":\(now - 600_000),"after":[1],"note":"等字段名：links 是数组还是对象"},
          {"n":5,"title":"文档里的地址跟着改","detail":"docs/clash-v0.md 的 §4 和 README","state":"todo","owner":"web","by":"you","createdAt":\(now - 900_000),"updatedAt":\(now - 900_000)},
          {"n":6,"title":"用真的 Stash 和 Clash 各拉一次配置","state":"todo","by":"daemon","createdAt":\(now - 600_000),"updatedAt":\(now - 600_000),"after":[2,4]},
          {"n":7,"title":"安卓的订阅页","state":"todo","owner":"android","by":"you","createdAt":\(now - 500_000),"updatedAt":\(now - 500_000),"after":[1,4]}],
         "claims":[
          {"handle":"daemon","paths":["packages/daemon/src/clash/phone.ts","packages/daemon/tests/clashPhone.test.ts","docs/clash-v0.md"],"why":"给 phone 加 problem 字段","at":\(now - 600_000),"until":\(now + 1_500_000)},
          {"handle":"mac-app","paths":["packages/mac-app/Sources/Settings/ClashCard.swift"],"at":\(now - 300_000),"until":\(now + 2_400_000)}]}
        """)
    }

    /// 等你处理, as `GET /rooms/attention` would give it.
    static var attention: [RoomAttentionItem] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let made: RoomAttention = decode("""
        {"items":[
          {"room":"\(roomId)","roomName":"手机订阅","kind":"permission","handle":"ios-app","terminal":"t-ios-app","text":"","at":\(now - 60_000)},
          {"room":"\(roomId)","roomName":"手机订阅","kind":"question","handle":"ios-app","seq":37,"task":4,"text":"@you 订阅页的字段名还没定，links 是数组还是对象？定了我接着做。","at":\(now - 600_000)},
          {"room":"\(roomId)","roomName":"手机订阅","kind":"blocked","handle":"ios-app","task":4,"text":"iPhone 的订阅页：等字段名：links 是数组还是对象","at":\(now - 610_000)},
          {"room":"c1b2c3d4e5","roomName":"文档整理","kind":"rounds","text":"7","at":\(now - 1_800_000)}]}
        """)
        return made.items
    }

    static let folder = "/Users/me/.agentswitch/room-files/\(roomId)"

    /// The room's shared folder (`roomfiles`), as `GET /rooms/:id/files` would give it.
    static var files: RoomFiles {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return decode("""
        {"folder":"\(folder)","files":[
          {"path":"mihomo-check.md","size":4812,"modifiedAt":\(now - 130_000)},
          {"path":"shots/stash-profile.png","size":1843200,"modifiedAt":\(now - 1_200_000)},
          {"path":"shots/clash-rules.png","size":962560,"modifiedAt":\(now - 1_260_000)},
          {"path":"phone-config/stash.yaml","size":18432,"modifiedAt":\(now - 5_400_000)},
          {"path":"phone-config/clash.yaml","size":17920,"modifiedAt":\(now - 5_460_000)},
          {"path":"api-notes.md","size":731,"modifiedAt":\(now - 86_400_000 - 500_000)},
          {"path":"old/process-name-rules.patch","size":212,"modifiedAt":\(now - 4 * 86_400_000)}],"more":false}
        """)
    }

    /// A file of the sample room's shared folder as the room's file route would give it: a made-up screenshot for a
    /// picture, a few lines for the rest; nil for a file elsewhere on the Mac.
    static func bytes(_ path: String) -> Data? {
        guard let under = RoomFiles.relative(path, in: folder) else { return nil }
        if RoomMessage.isPicture(path) { return DemoData.picture(under.contains("clash") ? 1 : 0) }
        return Data("# \(RoomMessage.fileName(path))\n\nStash 和 Clash 各拉了一次配置，都用真的 mihomo 内核验过：规则 412 条，没有 PROCESS-NAME。\n".utf8)
    }

    private static func decode<T: Decodable>(_ text: String) -> T {
        // Made up here: a mistake in it is a mistake in this file.
        try! JSONDecoder().decode(T.self, from: Data(text.utf8))
    }
}
#endif
