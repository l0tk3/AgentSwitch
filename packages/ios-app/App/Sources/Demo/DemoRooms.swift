#if DEBUG
import AgentSwitchKit
import Foundation

/// The sample screens' rooms (`-uiDemo YES -uiDemoScreen rooms|room|roompaused|roommembers|roomcard|roomnew|roommention`):
/// made up, as the Mac would give them.
enum DemoRooms {
    static let roomId = "a1b2c3d4e5"

    static var isDemo: Bool { UserDefaults.standard.bool(forKey: "uiDemo") }
    static var screen: String? { UserDefaults.standard.string(forKey: "uiDemoScreen") }

    static var list: RoomList {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return decode("""
        {"rooms":[
          {"id":"\(roomId)","name":"手机订阅","topic":"让手机上的 Stash 和 Clash 拉到适配的配置","paused":false,"createdAt":1,"members":7,"faces":[],
           "last":{"seq":38,"from":"daemon","text":"@you 两个版本都用真的 mihomo 内核验过了。","at":\(now - 120_000)},"unread":2,"forYou":true},
          {"id":"b1b2c3d4e5","name":"DayHub 发布","topic":"","paused":true,"createdAt":2,"members":3,"faces":[],
           "last":{"seq":12,"from":"you","text":"@all 先停一下，等我看完迁移脚本","at":\(now - 3_600_000)},"unread":0,"forYou":false},
          {"id":"c1b2c3d4e5","name":"文档整理","topic":"把 v0 文档里过期的段落标出来","paused":false,"createdAt":3,"members":2,"faces":[],"last":null,"unread":0,"forYou":false,"rounds":7},
          {"id":"d1b2c3d4e5","name":"安卓 Classic","topic":"","paused":false,"createdAt":4,"members":3,"faces":[],
           "last":{"seq":5,"from":"android","text":"图标都换好了，菜单在键盘上面。","at":\(now - 90_000_000)},"unread":3,"forYou":false}]}
        """)
    }

    static func detail(_ id: String) -> RoomDetail? {
        guard isDemo, id == roomId else { return nil }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func seat(_ handle: String, _ rows: String, _ color: Int, _ state: String, agent: String, model: String, profile: String?, dot: String?, canAdd: Bool = false, byAgent: Bool = false, by: String = "you") -> String {
            let face = rows.split(separator: " ").map { "\"\($0)\"" }.joined(separator: ",")
            return """
            {"handle":"\(handle)","kind":"session","terminal":"\(handle == "daemon" ? "a1b2c3d4" : "t-\(handle)")","face":{"rows":[\(face)],"color":\(color)},"joinedAt":1,"addedBy":"\(by)","canAdd":\(canAdd),"byAgent":\(byAgent),"left":null,"state":"\(state)","kit":\(handle != "ios-app"),
             "card":{"agent":"\(agent)","name":"\(handle)","cwd":"/Users/me/Projects/AgentSwitch/packages/\(handle)","model":"\(model)","profile":\(profile.map { "\"\($0)\"" } ?? "null"),\(dot.map { "\"color\":\"\($0)\"," } ?? "")"mode":"auto","node":null}}
            """
        }
        let paused = screen == "roompaused"
        let rounds = screen == "roomrounds" ? "7" : "null"
        return decode("""
        {"room":{"id":"\(roomId)","name":"手机订阅","topic":"让手机上的 Stash 和 Clash 拉到适配的配置","paused":\(paused),"createdAt":1,"createdBy":"you","lastSeq":38,"readSeq":36,"rounds":\(rounds),"roundsLimit":6},
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
          {"seq":32,"from":"daemon","to":["mac-app","ios-app"],"replyTo":31,"text":"接口定了：`GET /clash` 多一个 `phone`，里面是 `on`、`listening`、`links`、`problem`。@mac-app @ios-app 可以开始了。","at":\(now - 86_400_000 - 540_000)},
          {"seq":33,"from":"mac-app","to":[],"text":"收到，卡片今天做完。","at":\(now - 1_500_000)},
          {"seq":34,"from":"mac-app","to":["daemon"],"text":"@daemon `links` 里局域网和 Tailscale 的顺序固定吗？","at":\(now - 1_440_000)},
          {"seq":35,"from":"daemon","to":["mac-app"],"replyTo":34,"text":"固定，局域网在前。","at":\(now - 1_380_000)},
          {"seq":36,"from":"you","to":["web","gate"],"text":"@web @gate 文档里的地址也要跟着改","at":\(now - 900_000),"files":["/Users/me/Projects/AgentSwitch/docs/clash-v0.md","/Users/me/Projects/AgentSwitch/packages/daemon/src/clash/phone.ts"]},
          {"seq":37,"from":"daemon","to":["android","ios-app"],"text":"@android @ios-app `PROCESS-NAME` 的规则手机上都去掉了，重新拉一次配置。","at":\(now - 300_000)},
          {"seq":38,"from":"daemon","to":["you"],"text":"@you 两个版本都用真的 mihomo 内核验过了。","at":\(now - 120_000)}],
         "receipts":{"36":{"web":"ended","gate":"queued"},"37":{"android":"queued","ios-app":"delivered"}},
         "notes":{"text":"接口\\n- GET /clash 多一个 phone：on、listening、links、problem\\n- links 里局域网在前，Tailscale 在后\\n\\n待办\\n- [ ] 文档里的地址跟着改（@web）\\n- [x] 手机上去掉 PROCESS-NAME 规则","at":\(now - 1_300_000),"by":"daemon"}}
        """)
    }

    private static func decode<T: Decodable>(_ text: String) -> T {
        // Made up here: a mistake in it is a mistake in this file.
        try! JSONDecoder().decode(T.self, from: Data(text.utf8))
    }
}
#endif
