import AgentSwitchMacCore
import AppKit
import LocalAuthentication
import SwiftUI

/// 替换词 (2026-11-25, user #318-#332): what the model never sees. Terminals started from AgentSwitch talk to their
/// model through the gateway, which puts a placeholder in place of each word on the way out and the word back on the
/// way in; the user's own configuration is untouched. One list for everything, one more per room; the logs of both
/// sides, and their cleaning.
struct RedactionView: View {
    @Environment(AppModel.self) private var model
    @State private var state: RedactionState?
    @State private var problem: String?
    @State private var said: String?
    @State private var value = ""
    @State private var replace = ""
    @State private var logs: [RedactLog] = []
    @State private var logDir = ""
    @State private var cleanDays = 3

    var body: some View {
        Form {
            if let state {
                settings(state)
                // Off: nothing of it is there to use (user #343), the rooms' words neither.
                if state.settings.enabled {
                    words(state)
                    logSection(state)
                }
            } else if let problem {
                Text(problem).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.help("Refresh")
            }
        }
        .task {
            if let d = RedactionDemo.current { state = d.state; logs = d.logs; logDir = "/demo"; said = d.said; return }
            await load()
        }
    }

    // MARK: settings

    private func settings(_ s: RedactionState) -> some View {
        Section {
            Toggle("Replace Words in Model Traffic", isOn: bind(\.enabled, "enabled"))
            if s.settings.enabled {
                Toggle("Replace My User Name", isOn: bind(\.username, "username"))
                Toggle("Replace This Computer's Name", isOn: bind(\.host, "host"))
            }
            if !s.gateway && s.settings.enabled {
                Text("这台机器上没有找到网关程序，终端照常启动、不经过网关。").foregroundStyle(.orange)
            }
        } header: {
            SectionLabel("Model Traffic")
        } footer: {
            Footer(s.settings.enabled ? "从 AgentSwitch 启动的终端（Claude Code、Codex、OpenCode、pi）访问模型时经过内置网关：下面的词和各房间（房间菜单 › Words…）的词，在发给模型前换成占位符，回来时换回原词。只对之后启动的终端生效；不改你的任何配置，原来的代理照常是出口。" : "已关闭：新开的终端不经过网关，替换词和各房间的替换词都不可用。")
        }
    }

    private func bind(_ key: WritableKeyPath<RedactSettings, Bool>, _ name: String) -> Binding<Bool> {
        Binding(get: { state?.settings[keyPath: key] ?? false }, set: { on in
            Task { await patch([name: on]) }
        })
    }

    // MARK: words

    private func words(_ s: RedactionState) -> some View {
        Section {
            ForEach(s.words) { w in wordRow(w) { Task { await remove(w, room: nil) } } }
            HStack(spacing: 8) {
                TextField("", text: $value, prompt: Text("要替换的词"))
                TextField("", text: $replace, prompt: Text("替换成（留空：加盐哈希）"))
                Button("Add") { Task { await add(value, replace, room: nil) } }
                    .disabled(value.trimmingCharacters(in: .whitespaces).count < 3)
            }
            .labelsHidden()
            if let said { Text(said).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
        } header: {
            SectionLabel("Words")
        } footer: {
            Footer("默认换成 h_ 加 10 个字符的加盐哈希（每个 profile 的盐不同），模型方无法反推。自己指定的替换太简单（少于 6 个字符、普通词、纯数字）时只替换不还原。替换词加密保存，钥匙在钥匙串里。")
        }
    }

    private func wordRow(_ w: RedactWord, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Text(w.value).font(.body.monospaced()).lineLimit(1).truncationMode(.middle)
            Image(systemName: "arrow.right").foregroundStyle(.tertiary)
            Text(w.replace ?? "加盐哈希").foregroundStyle(w.replace == nil ? .secondary : .primary).lineLimit(1)
            if !w.restore { Text("只替换").font(.caption).foregroundStyle(.orange) }
            Spacer()
            Button("Remove", action: remove).buttonStyle(.borderless)
        }
    }

    // MARK: logs

    private func logSection(_ s: RedactionState) -> some View {
        Section {
            Toggle("Keep Logs", isOn: bind(\.log, "log"))
            Stepper("保留 \(s.settings.keepDays) 天", value: Binding(get: { s.settings.keepDays }, set: { d in Task { await patch(["keepDays": d]) } }), in: 0...365)
            ForEach(logs) { l in
                HStack(spacing: 10) {
                    Text(l.day).monospacedDigit()
                    Text("终端 \(l.terminal)").foregroundStyle(.secondary)
                    Spacer()
                    Button("Before (\(size(l.before)))") { Task { await openLog(l, side: "before") } }.buttonStyle(.borderless).disabled(l.before == 0)
                    Button("After (\(size(l.after)))") { Task { await openLog(l, side: "after") } }.buttonStyle(.borderless).disabled(l.after == 0)
                }
            }
            HStack(spacing: 10) {
                Button("Clean All") { Task { await clean(nil) } }.disabled(logs.isEmpty).fixedSize()
                Spacer()
                Text("清理 \(cleanDays) 天前的").monospacedDigit()
                Stepper("", value: $cleanDays, in: 1...365).labelsHidden().fixedSize()
                Button("Clean Older") { Task { await clean(cleanDays) } }.disabled(logs.isEmpty).fixedSize()
            }
        } header: {
            SectionLabel("Logs")
        } footer: {
            Footer("Before：agent 发出和收到的原样内容（含原词，打开前要验证身份）。After：模型那边实际收到和发回的内容。按终端、按天分文件，每份最多 64 MB。")
        }
    }

    private func size(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }

    // MARK: calls

    private func load() async {
        do {
            let s = try await model.client.redaction()
            state = s
            problem = nil
            let l = try await model.client.redactLogs()
            logs = l.logs
            logDir = l.dir
        } catch {
            problem = (error as? CommandError)?.message ?? error.localizedDescription
        }
    }

    private func patch(_ p: [String: Any]) async {
        do { _ = try await model.client.setRedaction(try JSONSerialization.data(withJSONObject: p)); await load() } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    private func add(_ v: String, _ r: String, room: String?) async {
        do {
            let (_, warning) = try await model.client.addRedactWord(v.trimmingCharacters(in: .whitespaces), replace: r.trimmingCharacters(in: .whitespaces), room: room)
            said = warning
            value = ""; replace = ""
            await load()
        } catch {
            said = (error as? CommandError)?.message ?? error.localizedDescription
        }
    }

    private func remove(_ w: RedactWord, room: String?) async {
        do { try await model.client.removeRedactWord(w.id, room: room); await load() } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    private func clean(_ days: Int?) async {
        do { let n = try await model.client.cleanRedactLogs(olderThan: days); said = "已删除 \(n) 个日志文件。"; await load() } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    /// A day's log opened in the user's own viewer; the side with the words in it after the user proves it is them.
    private func openLog(_ l: RedactLog, side: String) async {
        let url = URL(fileURLWithPath: logDir).appendingPathComponent(l.terminal).appendingPathComponent("\(l.day).\(side).jsonl")
        if side == "before" {
            let ctx = LAContext()
            let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "查看脱敏前的日志（含原词）")) ?? false
            guard ok else { return }
        }
        NSWorkspace.shared.open(url)
    }
}

extension RedactionState {
    /// The same, switched off (the design preview's second picture).
    var turnedOff: RedactionState {
        let json = (try? JSONEncoder().encode(Shadow(self, enabled: false))) ?? Data()
        return (try? JSONDecoder().decode(RedactionState.self, from: json)) ?? self
    }
    private struct Shadow: Encodable {
        let settings: RedactSettings; let words: [W]; let gateway: Bool; let logDir: String
        struct W: Encodable { let id: String; let value: String; let replace: String?; let restore: Bool; let addedAt: Int64 }
        init(_ s: RedactionState, enabled: Bool) {
            var set = s.settings; set.enabled = enabled
            settings = set; words = s.words.map { W(id: $0.id, value: $0.value, replace: $0.replace, restore: $0.restore, addedAt: $0.addedAt) }; gateway = s.gateway; logDir = s.logDir
        }
    }
}

/// Sample data for the design preview (`-designPreviewOnly redaction`): no service is asked.
enum RedactionDemo {
    struct Data { let state: RedactionState; let logs: [RedactLog]; let rooms: [RoomSummary]; let roomWords: [RedactWord]; let said: String? }
    nonisolated(unsafe) static var current: Data?

    static func make() -> Data? {
        func decode<T: Decodable>(_ t: T.Type, _ json: String) -> T? { try? JSONDecoder().decode(t, from: Foundation.Data(json.utf8)) }
        guard let state = decode(RedactionState.self, """
            {"settings":{"enabled":true,"username":true,"host":false,"log":true,"keepDays":3,"hosts":[]},
             "words":[{"id":"a1","value":"sk-live-51Hx••••9fQ","restore":true,"addedAt":0},
                      {"id":"a2","value":"张三丰","replace":"PERSON_A","restore":true,"addedAt":0},
                      {"id":"a3","value":"13800138000","replace":"A","restore":false,"addedAt":0}],
             "gateway":true,"logDir":"/demo"}
            """),
              let logs = decode([RedactLog].self, """
            [{"terminal":"3f9a2c1b","day":"2026-11-25","before":1843200,"after":1839104},
             {"terminal":"7d01e4aa","day":"2026-11-25","before":524288,"after":522240},
             {"terminal":"3f9a2c1b","day":"2026-11-24","before":9437184,"after":9420800}]
            """),
              let rooms = decode([RoomSummary].self, """
            [{"id":"df8433f731","name":"聊天室功能设计探讨","topic":"","paused":false,"members":3,"last":null,"unread":0,"forYou":false,"rounds":null,"terminals":[]}]
            """),
              let roomWords = decode([RedactWord].self, """
            [{"id":"r1","value":"project-falcon","restore":true,"addedAt":0}]
            """)
        else { return nil }
        return Data(state: state, logs: logs, rooms: rooms, roomWords: roomWords, said: "「A」少于 6 个字符，换回时没法和普通文字区分：只替换，不还原（模型看到它，你看到的也是它）。")
    }
}
