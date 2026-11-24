import AgentSwitchMacCore
import AppKit
import Foundation

extension RoomsDemo {
    /// Files for the made-up room's message: a picture drawn for the purpose and a file that is on every Mac, so the
    /// preview shows a picture and a file's card.
    static let demoFiles: String = {
        let picture = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-rooms-demo.png")
        let image = NSImage(size: NSSize(width: 480, height: 270), flipped: false) { rect in
            NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.24, alpha: 1).setFill(); rect.fill()
            NSColor(calibratedRed: 0.98, green: 0.36, blue: 0.55, alpha: 1).setFill(); NSRect(x: 40, y: 60, width: 150, height: 150).fill()
            NSColor(calibratedRed: 0.45, green: 0.85, blue: 0.65, alpha: 1).setFill(); NSBezierPath(ovalIn: NSRect(x: 250, y: 70, width: 170, height: 130)).fill()
            return true
        }
        if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: picture) }
        return "[\"\(picture.path)\",\"/etc/hosts\"]"
    }()

    /// A made-up room for the design preview (`MainWindowPreview`): four sessions in their states, a reply, a message
    /// for the user not yet seen, and receipts still open.
    static let demo: RoomsDemo = {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func at(_ minutes: Int64) -> Int64 { now - minutes * 60_000 }
        let json = """
        {"room":{"id":"login","name":"重构登录模块","topic":"接口先定，三端跟着改","paused":false,"lastSeq":6,"readSeq":5,"rounds":6,"roundsLimit":6},
         "seats":[
          {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
          {"handle":"daemon","kind":"session","terminal":"t1","avatar":{"pixel":{"kind":"grid","id":"p1","palette":["611c17","ab7c51","ffffff","876658","dcd2ce","d29985","a26d3d","44c585","7dd6aa"],"rows":["................","....00000000....","...0000000000...","...0000000000...","...1111111111...","...1222112221...","..112341123411..","..112221122211..","...1111111111...","...1111551111...","...1115111111...","....11111111....",".......66.......","...6766666676...","..667777777766..","..667777788766.."]},"classic":{"kind":"emoji","id":"e1","emoji":"🦊","bg":2}},"face":{"rows":["#.#.#",".###.","##.##",".#.#.","#...#"],"color":0},"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"busy",
           "card":{"agent":"claude-code","name":"daemon","cwd":"/Users/you/Projects/AgentSwitch/packages/daemon","model":"claude-fable-5-2","profile":"Work","color":"mint","mode":"acceptEdits","node":null}},
          {"handle":"mac-app","kind":"session","terminal":"t2","face":{"rows":[".###.","#.#.#","#####","..#..",".#.#."],"color":6},"joinedAt":0,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"idle","kit":false,
           "card":{"agent":"codex","name":"Mac App","cwd":"/Users/you/Projects/AgentSwitch/packages/mac-app","model":"gpt-6-sol","profile":null,"mode":"default","node":null}},
          {"handle":"ios-app","kind":"session","terminal":"t3","avatar":{"pixel":null,"classic":{"kind":"emoji","emoji":"🐙","bg":7}},"face":{"rows":["##.##","#...#",".###.","#.#.#","##.##"],"color":3},"joinedAt":0,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"waiting","asks":{"title":"Do you trust the files in this folder?","options":["Yes, proceed","No, exit"],"selected":0,"trust":true},
           "card":{"agent":"opencode","name":"ios-app","cwd":"/Users/you/Projects/AgentSwitch/packages/ios-app","model":"deepseek-flash","profile":"Personal","color":"violet","mode":"default","node":null}},
          {"handle":"web","kind":"session","terminal":"t4","face":{"rows":["#...#",".#.#.","#####","#.#.#",".###."],"color":8},"joinedAt":0,"addedBy":"daemon","canAdd":false,"byAgent":true,"left":null,"state":"exited",
           "card":{"agent":"pi","name":"web","cwd":"/Users/you/Projects/Web","model":"deepseek-flash","profile":null,"mode":null,"node":null}}],
         "messages":[
          {"seq":1,"from":"you","to":["daemon"],"text":"@daemon 登录接口的返回里加一个 `expiresAt`，改完告诉另外两边。","at":\(at(42))},
          {"seq":2,"task":1,"from":"daemon","to":["mac-app","ios-app"],"text":"@mac-app @ios-app 接口我改完了，`/login` 的返回多了一个 `expiresAt` 字段，你们两边的模型要跟着加。","at":\(at(30))},
          {"seq":3,"from":"daemon","to":[],"text":"**测试**也补上了，三个用例：\\n- 正常登录\\n- *过期*的令牌\\n- 错误密码","at":\(at(29)),"files":\(RoomsDemo.demoFiles)},
          {"seq":4,"task":1,"from":"mac-app","to":["daemon"],"replyTo":2,"text":"@daemon 收到。是毫秒还是秒？","at":\(at(12))},
          {"seq":5,"task":1,"from":"daemon","to":["mac-app","web"],"text":"@mac-app 毫秒。@web 你那边的类型也要改。","at":\(at(10))},
          {"seq":6,"from":"mac-app","to":["you"],"text":"@you 模型加好了，要不要现在就发一版？","at":\(at(2))}],
         "receipts":{"2":{"ios-app":"queued"},"5":{"web":"ended"}},
         "reads":{"1":["daemon"],"2":["mac-app"],"5":["mac-app"]},
         "notes":{"text":"接口：/login 返回 expiresAt（毫秒）\\n待办：web 的类型","at":\(at(20)),"by":"daemon"},
         "folder":"/Users/you/Library/Application Support/AgentSwitch/room-files/login",
         "tasks":[
          {"n":1,"title":"定登录接口","state":"done","owner":"daemon","by":"you","updatedAt":\(at(30)),"note":"见 interface.md"},
          {"n":2,"title":"Mac 的模型跟着改","detail":"加 expiresAt，毫秒","state":"doing","owner":"mac-app","by":"daemon","updatedAt":\(at(12)),"after":[1]},
          {"n":3,"title":"iPhone 的模型跟着改","state":"blocked","note":"等你信任文件夹","owner":"ios-app","by":"daemon","updatedAt":\(at(12)),"after":[1]},
          {"n":4,"title":"发一版","state":"todo","by":"you","updatedAt":\(at(5)),"after":[2,3]}],
         "claims":[{"handle":"mac-app","paths":["/Users/you/Projects/AgentSwitch/packages/mac-app/Sources/Login.swift","/Users/you/Projects/AgentSwitch/packages/mac-app/Sources/Session.swift"],"why":"T2","at":\(at(10)),"until":\(at(-20))}]}
        """
        let room = try! JSONDecoder().decode(Room.self, from: Data(json.utf8))
        let list = try! JSONDecoder().decode([RoomSummary].self, from: Data("""
        [{"id":"login","name":"重构登录模块","topic":"接口先定，三端跟着改","paused":false,"members":5,"unread":1,"forYou":true,"attention":3,
          "last":{"seq":6,"from":"mac-app","text":"@you 模型加好了，要不要现在就发一版？","at":\(at(2))}},
         {"id":"release","name":"发布检查","topic":"每次发版前过一遍","paused":true,"members":3,"unread":0,"forYou":false,
          "last":{"seq":9,"from":"you","text":"@all 先停一下","at":\(at(180))}},
         {"id":"docs","name":"文档","topic":"clash-v0 第 12 节","paused":false,"members":2,"unread":0,"forYou":false,"rounds":7,"last":null}]
        """.utf8))
        return RoomsDemo(rooms: list, room: room)
    }()

    static let attention: [RoomAttention] = try! JSONDecoder().decode([RoomAttention].self, from: Data("""
    [{"room":"login","roomName":"重构登录模块","kind":"question","seq":6,"handle":"mac-app","text":"@you 模型加好了，要不要现在就发一版？","at":\(Int64(Date().timeIntervalSince1970 * 1000) - 120_000)},
     {"room":"login","roomName":"重构登录模块","kind":"trust","handle":"ios-app","terminal":"t3","text":"Do you trust the files in this folder?","at":\(Int64(Date().timeIntervalSince1970 * 1000) - 600_000)},
     {"room":"login","roomName":"重构登录模块","kind":"blocked","task":3,"handle":"ios-app","text":"iPhone 的模型跟着改：等你信任文件夹","at":\(Int64(Date().timeIntervalSince1970 * 1000) - 720_000)}]
    """.utf8))

    static let library: RoomAvatarLibrary = try! JSONDecoder().decode(RoomAvatarLibrary.self, from: Data("""
    {"faces":[{"id":"f1","rows":["#.#.#",".###.","##.##",".#.#.","#...#"],"color":0},{"id":"f2","rows":[".###.","#.#.#","#####","..#..",".#.#."],"color":3},{"id":"f3","rows":["##.##","#...#",".###.","#.#.#","##.##"],"color":6}],
     "art":[{"id":"p1","palette":["611c17","ab7c51","ffffff","876658","dcd2ce","d29985","a26d3d","44c585","7dd6aa"],"rows":["................","....00000000....","...0000000000...","...0000000000...","...1111111111...","...1222112221...","..112341123411..","..112221122211..","...1111111111...","...1111551111...","...1115111111...","....11111111....",".......66.......","...6766666676...","..667777777766..","..667777788766.."]}],
     "emoji":[{"id":"e1","emoji":"🦊"},{"id":"e2","emoji":"🐼"},{"id":"e3","emoji":"🐨"},{"id":"e21","emoji":"🤖"},{"id":"e22","emoji":"👾"}]}
    """.utf8))

    static let models: RoomModels = try! JSONDecoder().decode(RoomModels.self, from: Data("""
    {"agents":{"claude-code":{"current":"work","models":[{"id":"opus","name":"Opus 5.5"},{"id":"fable","name":"Fable 5.2"},{"id":"sonnet","name":"Sonnet 5.5"},{"id":"haiku","name":"Haiku 5.5"},{"id":"claude-opus-4-8","name":"Opus 4.8","older":true}],
       "profiles":[{"id":"default","name":"Default","off":[]},{"id":"work","name":"Work","off":["haiku"]},{"id":"p3","name":"Personal","off":["haiku","sonnet"]},
         {"id":"dpsk","name":"dpsk","off":[],"source":"profile","model":"deepseek-flash","baseUrl":"https://api.deepseek.com/anthropic","models":[{"id":"deepseek-flash","name":"deepseek-flash"}]}]},
     "codex":{"current":"default","models":[{"id":"gpt-6-sol","name":"GPT-6 Sol"},{"id":"gpt-6-mini","name":"GPT-6 Mini"}],"profiles":[{"id":"default","name":"Default","off":["gpt-6-mini"]}]}}}
    """.utf8))

    static let files: RoomFiles = {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return try! JSONDecoder().decode(RoomFiles.self, from: Data("""
        {"folder":"/Users/you/Library/Application Support/AgentSwitch/room-files/login","more":false,"files":[
          {"path":"interface.md","size":2140,"modifiedAt":\(now - 30 * 60_000)},
          {"path":"review/mac-app.md","size":18432,"modifiedAt":\(now - 3 * 3_600_000)},
          {"path":"plan.md","size":812,"modifiedAt":\(now - 26 * 3_600_000)}]}
        """.utf8))
    }()
}
