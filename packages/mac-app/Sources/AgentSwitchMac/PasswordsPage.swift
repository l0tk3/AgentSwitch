import AgentSwitchMacCore
import AppKit
import LocalAuthentication
import SwiftUI
import UniformTypeIdentifiers

/// The password book (design-password-book.md; user #345-#351): a page of the main window. The list never holds a
/// password; one is fetched (`reveal`) after Touch ID, which is not asked again for five minutes, shown for twenty
/// seconds, and copied to a clipboard that is cleared after thirty. Each password is also a word the model never sees
/// (Settings › Redaction).
struct PasswordsPage: View {
    let state: MainWindowState
    @Environment(AppModel.self) private var app
    @State private var model = PasswordsModel()

    var body: some View {
        HStack(spacing: 0) {
            list.frame(width: 300)
            HairRule(color: Look.line, vertical: true)
            detail.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Look.ground)
        // Another node's book when the window is on that node (user #356).
        .task(id: "\(state.page == .passwords && state.windowVisible)|\(state.nodeId ?? "")") {
            let node = state.nodeId
            if model.node != node { model.switchNode(node) }
            model.client = { [app] in app.client(on: node) }
            if let demo = PasswordsDemo.current { model.show(demo: demo); return }
            guard state.page == .passwords && state.windowVisible else { return }
            await model.load()
        }
    }

    // MARK: the list

    private var list: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("", text: $model.query, prompt: Text("搜索名称、网址、账号")).textFieldStyle(.roundedBorder)
                Button { model.startNew() } label: { BracketLabel(word: "New") }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
            }
            .padding(12)
            HairRule(color: Look.line)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.shown) { e in
                        Button { model.select(e.id) } label: { row(e) }.buttonStyle(.plain)
                        HairRule(color: Look.line)
                    }
                    if model.items.isEmpty && model.loaded {
                        Text("密码本还是空的。点 New 加一条，或从浏览器导出的 CSV 导入。").font(.system(size: 12.5)).foregroundStyle(Look.ink2).padding(16)
                    }
                }
            }
            HairRule(color: Look.line)
            HStack {
                Text("\(model.items.count) 条").font(.system(size: 12)).foregroundStyle(Look.ink2).monospacedDigit()
                Spacer()
                Button("Import CSV…") { model.importCSV() }.buttonStyle(.borderless).font(.system(size: 12))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    private func row(_ e: PasswordItem) -> some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 6).fill(Look.raised)
                Text(String(e.name.prefix(1)).uppercased()).font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.ink)
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(e.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink).lineLimit(1)
                Text([e.account, e.sites.first].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11.5)).foregroundStyle(Look.ink2).lineLimit(1)
            }
            Spacer(minLength: 0)
            if e.hasTotp { Text("2FA").mono(10).foregroundStyle(Look.ink2) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(model.selected == e.id ? Color.signal.opacity(0.18) : Color.clear)
        .contentShape(Rectangle())
    }

    // MARK: the entry

    @ViewBuilder private var detail: some View {
        if model.editing {
            PasswordEditor(model: model)
        } else if let e = model.current {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(e.name).font(.system(size: 20, weight: .semibold)).foregroundStyle(Look.ink)
                        Spacer()
                        Button { model.startEdit() } label: { BracketLabel(word: "Edit") }.buttonStyle(BracketButtonStyle(size: 12))
                        Button { model.confirmingRemove = true } label: { BracketLabel(word: "Delete") }.buttonStyle(BracketButtonStyle(size: 12))
                    }
                    field("账号", e.account.isEmpty ? "—" : e.account, copy: e.account.isEmpty ? nil : { model.copyPlain(e.account) })
                    field("网址", e.sites.isEmpty ? "—" : e.sites.joined(separator: "\n"), copy: nil)
                    passwordField(e)
                    if e.hasTotp { totpField }
                    if e.hasNote { noteField }
                    if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Look.ink2) }
                }
                .padding(24)
                .frame(maxWidth: 620, alignment: .leading)
            }
            .confirmationDialog("删除「\(e.name)」？", isPresented: $model.confirmingRemove) {
                Button("Delete", role: .destructive) { Task { await model.remove() } }
            } message: { Text("删除后无法恢复。") }
        } else {
            VStack(spacing: 10) {
                Text("选一条，或者点 New 新建。").font(.system(size: 13)).foregroundStyle(Look.ink2)
                if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Look.ink2) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func field(_ label: String, _ value: String, copy: (() -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).mono(11).foregroundStyle(Look.ink2)
            HStack {
                Text(value).font(.system(size: 14)).foregroundStyle(Look.ink).textSelection(.enabled)
                Spacer()
                if let copy { Button("Copy", action: copy).buttonStyle(.borderless).font(.system(size: 12)) }
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Look.raised))
        }
    }

    private func passwordField(_ e: PasswordItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("密码").mono(11).foregroundStyle(Look.ink2)
            HStack {
                if let secret = model.secret?.password, model.showing {
                    Text(secret).font(.system(size: 14).monospaced()).foregroundStyle(Look.ink).textSelection(.enabled)
                } else {
                    Text(String(repeating: "•", count: min(max(e.length, 8), 24))).font(.system(size: 14).monospaced()).foregroundStyle(Look.ink2)
                }
                Spacer()
                Button(model.showing ? "Hide" : "Show") { Task { await model.toggleShow() } }.buttonStyle(.borderless).font(.system(size: 12))
                Button("Copy") { Task { await model.copyPassword() } }.buttonStyle(.borderless).font(.system(size: 12))
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Look.raised))
        }
    }

    private var totpField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("两步验证码").mono(11).foregroundStyle(Look.ink2)
            HStack {
                if let code = model.secret?.totp {
                    Text(code.code.prefix(3) + " " + code.code.suffix(3)).font(.system(size: 18, weight: .medium).monospaced()).foregroundStyle(Look.ink)
                    Text("\(code.left)s").mono(11).foregroundStyle(Look.ink2)
                } else {
                    Text("••• •••").font(.system(size: 18).monospaced()).foregroundStyle(Look.ink2)
                }
                Spacer()
                Button("Copy Code") { Task { await model.copyCode() } }.buttonStyle(.borderless).font(.system(size: 12))
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Look.raised))
        }
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("备注").mono(11).foregroundStyle(Look.ink2)
            HStack(alignment: .top) {
                if let note = model.secret?.note, model.showing {
                    Text(note).font(.system(size: 13)).foregroundStyle(Look.ink).textSelection(.enabled)
                } else {
                    Text("显示密码时一起显示。").font(.system(size: 13)).foregroundStyle(Look.ink2)
                }
                Spacer()
            }
            .padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Look.raised))
        }
    }
}

/// New, or Edit: a password left empty when editing stays as it was.
private struct PasswordEditor: View {
    @Bindable var model: PasswordsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(model.selected == nil ? "New Password" : "Edit Password").font(.system(size: 18, weight: .semibold)).foregroundStyle(Look.ink)
                labeled("名称") { TextField("", text: $model.draft.name, prompt: Text("比如 GitHub（工作）")) }
                labeled("网址") { TextField("", text: $model.draft.sites, prompt: Text("github.com，多个用逗号隔开")) }
                labeled("账号") { TextField("", text: $model.draft.account, prompt: Text("用户名或邮箱")) }
                labeled("密码") {
                    HStack {
                        SecureField("", text: $model.draft.password, prompt: Text(model.selected == nil ? "" : "留空：不改"))
                        Button("Generate") { Task { await model.generate() } }.buttonStyle(.borderless).font(.system(size: 12))
                    }
                }
                if let made = model.generated {
                    Text("已生成：\(made)").font(.system(size: 12).monospaced()).foregroundStyle(Look.ink2).textSelection(.enabled)
                }
                labeled("两步验证密钥（可选）") { SecureField("", text: $model.draft.totp, prompt: Text(model.selected == nil ? "base32，比如 JBSW Y3DP …" : "留空：不改")) }
                labeled("备注（可选）") { TextField("", text: $model.draft.note, prompt: Text(model.selected == nil ? "恢复码、安全问题" : "留空：不改"), axis: .vertical).lineLimit(3...6) }
                if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Color.waiting) }
                HStack {
                    Spacer()
                    Button { model.editing = false } label: { BracketLabel(word: "Cancel", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
                    Button { Task { await model.save() } } label: { BracketLabel(word: "Save") }.buttonStyle(BracketButtonStyle(role: .primary))
                        .disabled(model.draft.name.trimmingCharacters(in: .whitespaces).isEmpty || (model.selected == nil && model.draft.password.isEmpty))
                }
            }
            .textFieldStyle(.roundedBorder)
            .padding(24)
            .frame(maxWidth: 620, alignment: .leading)
        }
    }

    private func labeled<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).mono(11).foregroundStyle(Look.ink2)
            content().labelsHidden()
        }
    }
}

@MainActor
@Observable
final class PasswordsModel {
    @ObservationIgnored var client: () -> DaemonClient = { fatalError("no client") }
    /// The node whose book this is; nil: this Mac.
    @ObservationIgnored private(set) var node: String?

    /// Another node: nothing of the last one's is kept on screen.
    func switchNode(_ id: String?) { node = id; items = []; loaded = false; selected = nil; secret = nil; showing = false; editing = false; said = nil; provedAt = .distantPast }
    private(set) var items: [PasswordItem] = []
    private(set) var loaded = false
    var query = ""
    private(set) var selected: String?
    private(set) var secret: PasswordSecret?
    private(set) var showing = false
    var editing = false
    var draft = PasswordDraft()
    var generated: String?
    var said: String?
    var confirmingRemove = false
    @ObservationIgnored private var demo = false
    @ObservationIgnored private var provedAt = Date.distantPast
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    /// Touch ID is asked again after this long (design-password-book.md §2).
    static let grace: TimeInterval = 300

    var current: PasswordItem? { items.first { $0.id == selected } }

    var shown: [PasswordItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter { ([$0.name, $0.account] + $0.sites).contains { $0.lowercased().contains(q) } }
    }

    func show(demo: PasswordsDemo.Data) { self.demo = true; items = demo.items; selected = demo.selected; secret = demo.secret; showing = demo.showing; loaded = true; editing = demo.editing; if let d = demo.draft { draft = d } }

    func load() async {
        guard !demo else { return }
        do { items = try await client().passwords(); loaded = true } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    func select(_ id: String) {
        selected = id; secret = nil; showing = false; editing = false; said = nil
    }

    func startNew() { selected = nil; draft = PasswordDraft(); generated = nil; said = nil; editing = true }

    func startEdit() {
        guard let e = current else { return }
        draft = PasswordDraft(); draft.name = e.name; draft.sites = e.sites.joined(separator: ", "); draft.account = e.account
        generated = nil; said = nil; editing = true
    }

    func save() async {
        do {
            let e = try await client().savePassword(draft, id: selected)
            editing = false; draft = PasswordDraft(); generated = nil
            await load()
            select(e.id)
            said = "已保存。"
        } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    func remove() async {
        guard let id = selected else { return }
        do { try await client().removePassword(id); selected = nil; secret = nil; await load() } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
    }

    func generate() async {
        if let p = try? await client().generatePassword() { draft.password = p; generated = p }
    }

    /// The user proves it is them (Touch ID, or the login password), not again within `grace`.
    private func prove(_ why: String) async -> Bool {
        if Date().timeIntervalSince(provedAt) < Self.grace { return true }
        let ok = (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: why)) ?? false
        if ok { provedAt = Date() }
        return ok
    }

    private func fetch(_ why: String) async -> PasswordSecret? {
        guard let id = selected else { return nil }
        if !demo { guard await prove(why) else { return nil } }
        if demo { return secret }
        do { let s = try await client().revealPassword(id); secret = s; return s } catch { said = (error as? CommandError)?.message ?? error.localizedDescription; return nil }
    }

    func toggleShow() async {
        if showing { showing = false; return }
        guard await fetch("显示密码") != nil else { return }
        showing = true
        hideTask?.cancel()
        hideTask = Task { try? await Task.sleep(for: .seconds(20)); if !Task.isCancelled { showing = false; secret = nil } }
    }

    func copyPassword() async {
        guard let s = await fetch("复制密码") else { return }
        copySecret(s.password)
        said = "已复制，30 秒后从剪贴板清除。"
    }

    func copyCode() async {
        guard let s = await fetch("复制两步验证码"), let code = s.totp?.code else { return }
        copySecret(code)
        said = "验证码已复制，30 秒后从剪贴板清除。"
    }

    func copyPlain(_ text: String) { Clipboard.copy(text) }

    /// Copied as concealed (clipboard managers that honour it keep nothing), cleared after thirty seconds unless
    /// something else was copied meanwhile.
    private func copySecret(_ text: String) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
        board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        let count = board.changeCount
        Task { try? await Task.sleep(for: .seconds(30)); if board.changeCount == count { board.clearContents() } }
    }

    /// A CSV a browser or a password manager exported; the plain file is offered to the Trash after.
    func importCSV() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.commaSeparatedText, .plainText]
        guard panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        Task {
            do {
                let r = try await client().importPasswords(csv: text)
                await load()
                said = "导入 \(r.added) 条，更新 \(r.replaced) 条\(r.skipped > 0 ? "，跳过 \(r.skipped) 条没有密码的" : "")。"
                let alert = NSAlert()
                alert.messageText = "把明文 CSV 移到废纸篓？"
                alert.informativeText = "\(url.lastPathComponent) 里是明文密码。已经导入密码本，原文件不再需要。"
                alert.addButton(withTitle: "Move to Trash")
                alert.addButton(withTitle: "Keep")
                if alert.runModal() == .alertFirstButtonReturn { try? FileManager.default.trashItem(at: url, resultingItemURL: nil) }
            } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
        }
    }
}

/// Sample data for the design preview (`-designPreviewOnly passwords`): no service is asked.
enum PasswordsDemo {
    struct Data { let items: [PasswordItem]; let selected: String?; let secret: PasswordSecret?; let showing: Bool; let editing: Bool; let draft: PasswordDraft? }
    nonisolated(unsafe) static var current: Data?

    static func make(showing: Bool = false, editing: Bool = false) -> Data? {
        func decode<T: Decodable>(_ t: T.Type, _ json: String) -> T? { try? JSONDecoder().decode(t, from: Foundation.Data(json.utf8)) }
        guard let items = decode([PasswordItem].self, """
            [{"id":"p1","name":"GitHub（工作）","sites":["github.com"],"account":"lkz-work","tags":[],"updatedAt":0,"hasTotp":true,"hasNote":true,"length":20},
             {"id":"p2","name":"阿里云","sites":["aliyun.com","signin.aliyun.com"],"account":"ops@example.com","tags":[],"updatedAt":0,"hasTotp":false,"hasNote":false,"length":16},
             {"id":"p3","name":"Google Cloud","sites":["console.cloud.google.com"],"account":"me@example.com","tags":[],"updatedAt":0,"hasTotp":true,"hasNote":false,"length":18},
             {"id":"p4","name":"Vercel","sites":["vercel.com"],"account":"lkz","tags":[],"updatedAt":0,"hasTotp":false,"hasNote":false,"length":24}]
            """),
              let secret = decode(PasswordSecret.self, #"{"password":"x7#Kq2-Vn9!pLm4@Ws8e","note":"恢复码：4F2K-9QX1","totp":{"code":"482193","left":17}}"#)
        else { return nil }
        var draft: PasswordDraft?
        if editing { var d = PasswordDraft(); d.name = "Vercel"; d.sites = "vercel.com"; d.account = "lkz"; draft = d }
        return Data(items: items, selected: editing ? "p4" : "p1", secret: showing ? secret : nil, showing: showing, editing: editing, draft: draft)
    }
}
