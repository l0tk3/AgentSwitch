import AgentSwitchMacCore
import AppKit
import Foundation

extension RoomsDemo {
    /// Files for the made-up room's message: a picture drawn for the purpose (a sign-in page telling that the session
    /// ran out) and a file that is on every Mac, so the preview shows a picture and a file's card.
    static let demoFiles: String = "[\"\(demoPicture)\",\"/etc/hosts\"]"

    /// A sign-in page as a member would send a screenshot of it, drawn here (no file of anyone's).
    static let demoPicture: String = {
        let picture = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-rooms-login.png")
        let image = NSImage(size: NSSize(width: 480, height: 300), flipped: true) { rect in
            func fill(_ hex: Int, _ r: NSRect, radius: CGFloat = 6) {
                NSColor(calibratedRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1).setFill()
                NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
            }
            func text(_ s: String, _ p: NSPoint, size: CGFloat, hex: Int, bold: Bool = false) {
                let color = NSColor(calibratedRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
                (s as NSString).draw(at: p, withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular), .foregroundColor: color])
            }
            fill(0xEEF0F4, rect, radius: 0)
            fill(0xFFFFFF, NSRect(x: 0, y: 0, width: 480, height: 30), radius: 0)
            for (i, c) in [0xFF5F57, 0xFEBC2E, 0x28C840].enumerated() { fill(c, NSRect(x: 12 + i * 16, y: 10, width: 10, height: 10), radius: 5) }
            fill(0xF1F2F5, NSRect(x: 80, y: 7, width: 320, height: 16), radius: 8)
            text("app.example.com/login", NSPoint(x: 182, y: 8), size: 10, hex: 0x6B7280)
            fill(0xFFFFFF, NSRect(x: 130, y: 52, width: 220, height: 224), radius: 10)
            text("登录", NSPoint(x: 150, y: 66), size: 18, hex: 0x111827, bold: true)
            fill(0xFEF3C7, NSRect(x: 150, y: 100, width: 180, height: 26))
            text("登录已过期，请重新登录", NSPoint(x: 160, y: 105), size: 11, hex: 0x92400E)
            for (y, label) in [(136, "账号"), (176, "密码")] {
                fill(0xD1D5DB, NSRect(x: 150, y: CGFloat(y), width: 180, height: 30))
                fill(0xFFFFFF, NSRect(x: 151, y: CGFloat(y) + 1, width: 178, height: 28), radius: 5)
                text(label, NSPoint(x: 160, y: CGFloat(y) + 7), size: 12, hex: 0x9CA3AF)
            }
            fill(0x111827, NSRect(x: 150, y: 222, width: 180, height: 32))
            text("登录", NSPoint(x: 228, y: 229), size: 13, hex: 0xFFFFFF, bold: true)
            return true
        }
        if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: picture) }
        return picture.path
    }()

    /// The interface note the showcase room's lead put in its folder (a file with something in it, for its card).
    static let demoNote: String = {
        let note = FileManager.default.temporaryDirectory.appendingPathComponent("interface.md")
        try? "# /login\n\n`expiresAt`: when the token runs out, in milliseconds since 1970.\n".write(to: note, atomically: true, encoding: .utf8)
        return note.path
    }()

    /// The README's room (user #675): sessions of four agents at work on one change, one notice (a member asks whether
    /// to trust its folder), a screenshot one of them sent, and a question for the user at the end.
    static let showcase: RoomsDemo = {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func at(_ minutes: Int64) -> Int64 { now - minutes * 60_000 }
        let json = """
        {"room":{"id":"login","name":"重构登录模块","topic":"接口先定，三端跟着改","paused":false,"lastSeq":6,"readSeq":5},
         "seats":[
          {"handle":"you","kind":"user","terminal":null,"face":null,"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":null,"card":null},
          {"handle":"daemon","kind":"session","terminal":"t1","avatar":{"pixel":{"kind":"grid","id":"p1","palette":["611c17","ab7c51","ffffff","876658","dcd2ce","d29985","a26d3d","44c585","7dd6aa"],"rows":["................","....00000000....","...0000000000...","...0000000000...","...1111111111...","...1222112221...","..112341123411..","..112221122211..","...1111111111...","...1111551111...","...1115111111...","....11111111....",".......66.......","...6766666676...","..667777777766..","..667777788766.."]},"classic":{"kind":"emoji","id":"e1","emoji":"🦊","bg":2}},"face":{"rows":["#.#.#",".###.","##.##",".#.#.","#...#"],"color":0},"joinedAt":0,"addedBy":"you","canAdd":true,"byAgent":false,"left":null,"state":"busy",
           "card":{"agent":"claude-code","name":"daemon","cwd":"/Users/you/Projects/Shop/server","model":"claude-opus-5-5","profile":"Work","color":"mint","mode":"acceptEdits","node":null}},
          {"handle":"mac-app","kind":"session","terminal":"t2","avatar":{"pixel":null,"classic":{"kind":"emoji","emoji":"🐼","bg":4}},"face":{"rows":[".###.","#.#.#","#####","..#..",".#.#."],"color":6},"joinedAt":0,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"idle",
           "card":{"agent":"codex","name":"Mac App","cwd":"/Users/you/Projects/Shop/mac","model":"gpt-6-sol","profile":null,"mode":"default","node":null}},
          {"handle":"ios-app","kind":"session","terminal":"t3","avatar":{"pixel":null,"classic":{"kind":"emoji","emoji":"🐙","bg":7}},"face":{"rows":["##.##","#...#",".###.","#.#.#","##.##"],"color":3},"joinedAt":0,"addedBy":"you","canAdd":false,"byAgent":false,"left":null,"state":"waiting","asks":{"title":"Do you trust the files in this folder?","options":["Yes, proceed","No, exit"],"selected":0,"trust":true},
           "card":{"agent":"opencode","name":"ios-app","cwd":"/Users/you/Projects/Shop/ios","model":"deepseek-flash","profile":"Personal","color":"violet","mode":"default","node":null}},
          {"handle":"web","kind":"session","terminal":"t4","avatar":{"pixel":null,"classic":{"kind":"emoji","emoji":"🐨","bg":5}},"face":{"rows":["#...#",".#.#.","#####","#.#.#",".###."],"color":8},"joinedAt":0,"addedBy":"daemon","canAdd":false,"byAgent":true,"left":null,"state":"idle",
           "card":{"agent":"pi","name":"web","cwd":"/Users/you/Projects/Shop/web","model":"deepseek-flash","profile":null,"mode":null,"node":null}}],
         "messages":[
          {"seq":1,"from":"you","to":["daemon"],"text":"@daemon 登录接口加一个 `expiresAt`，改完告诉大家。","at":\(at(46))},
          {"seq":2,"task":1,"from":"daemon","to":["mac-app","ios-app","web"],"text":"@mac-app @ios-app @web `/login` 的返回多了 `expiresAt`（毫秒），说明放在共享文件夹。令牌过期时请回到登录页。","at":\(at(31)),"files":["\(RoomsDemo.demoNote)"]},
          {"seq":3,"task":2,"from":"mac-app","to":["daemon"],"replyTo":2,"text":"@daemon Mac 这边改好了，过期后回到登录页：","at":\(at(14)),"files":["\(RoomsDemo.demoPicture)"]},
          {"seq":4,"task":4,"from":"web","to":["daemon"],"text":"@daemon 网页的类型也改了，`npm test` 41 个全过。","at":\(at(9))},
          {"seq":5,"from":"daemon","to":["you"],"text":"@you @ios-app 在等你确认信任它的文件夹，确认后它就开始改 iPhone。","at":\(at(6))},
          {"seq":6,"from":"mac-app","to":["you"],"text":"@you Mac 和网页都好了，要不要先发一版？","at":\(at(2))}],
         "receipts":{"2":{"ios-app":"queued"}},
         "reads":{"1":["daemon"],"2":["mac-app","web"],"3":["daemon"],"4":["daemon"]},
         "notes":{"text":"接口：/login 返回 expiresAt（毫秒）","at":\(at(30)),"by":"daemon"},
         "folder":"/Users/you/Library/Application Support/AgentSwitch/room-files/login",
         "tasks":[
          {"n":1,"title":"定登录接口","state":"done","owner":"daemon","by":"you","updatedAt":\(at(31)),"note":"见 interface.md"},
          {"n":2,"title":"Mac 跟着改","state":"done","owner":"mac-app","by":"daemon","updatedAt":\(at(14)),"after":[1]},
          {"n":3,"title":"iPhone 跟着改","state":"blocked","note":"等你信任文件夹","owner":"ios-app","by":"daemon","updatedAt":\(at(12)),"after":[1]},
          {"n":4,"title":"网页跟着改","state":"done","owner":"web","by":"daemon","updatedAt":\(at(9)),"after":[1]}],
         "claims":[]}
        """
        let room = try! JSONDecoder().decode(Room.self, from: Data(json.utf8))
        return RoomsDemo(rooms: demo.rooms, room: room)
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
        [{"id":"login","name":"重构登录模块","topic":"接口先定，三端跟着改","paused":false,"members":5,"unread":1,"forYou":true,"attention":3,"faces":[{"handle":"daemon","face":{"rows":["#...#", ".###.", "#.#.#", ".###.", "#...#"],"color":2}},{"handle":"mac-app","face":{"rows":[".###.", "#.#.#", "#####", "..#..", ".#.#."],"color":6}},{"handle":"ios-app","face":{"rows":["##.##", "#...#", "..#..", "#...#", "##.##"],"color":4}},{"handle":"web","face":{"rows":["..#..", ".###.", "#####", ".#.#.", "#...#"],"color":8}}],
          "last":{"seq":6,"from":"mac-app","text":"@you 模型加好了，要不要现在就发一版？","at":\(at(2))}},
         {"id":"release","name":"发布检查","topic":"每次发版前过一遍","paused":true,"members":3,"unread":0,"forYou":false,"faces":[{"handle":"ios-app","face":{"rows":["##.##", "#...#", "..#..", "#...#", "##.##"],"color":4}},{"handle":"web","face":{"rows":["..#..", ".###.", "#####", ".#.#.", "#...#"],"color":8}}],
          "last":{"seq":9,"from":"you","text":"@all 先停一下","at":\(at(180))}},
         {"id":"docs","name":"文档","topic":"clash-v0 第 12 节","paused":false,"members":2,"unread":0,"forYou":false,"rounds":7,"faces":[{"handle":"mac-app","face":{"rows":[".###.", "#.#.#", "#####", "..#..", ".#.#."],"color":6}},{"handle":"daemon","face":{"rows":["#...#", ".###.", "#.#.#", ".###.", "#...#"],"color":2}},{"handle":"web","face":{"rows":["..#..", ".###.", "#####", ".#.#.", "#...#"],"color":8}}],"last":null}]
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
