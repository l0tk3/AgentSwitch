import AgentSwitchMacCore
import AppKit
import LocalAuthentication
import SwiftUI
import UniformTypeIdentifiers

/// The password book's window opened from a view that has no hold of the controller: `node` nil is this Mac.
@MainActor enum PasswordsOpener {
    static var show: (String?) -> Void = { _ in }
    /// A room's own book (user #416): the node, the room's id and its name.
    static var showRoom: (String?, String, String) -> Void = { _, _, _ in }
    static let help = "Passwords ⌘⇧L"
}

/// The password book's window (user #400: 和设置一样点击以后弹出来一个页面): one, as the settings' is; opened again from
/// a window on another node it shows that node's book (user #356).
@MainActor
final class PasswordsWindowController {
    /// A room's own book (user #416: 每个room里应该还有个私有的密码本…也是弹出式的).
    struct RoomBook: Equatable { let id: String; let name: String }

    private let model: AppModel
    /// The book of everything's window.
    private(set) var window: NSWindow?
    private var node: String?
    /// The rooms' own, a window each, by node and room.
    private var roomWindows: [String: NSWindow] = [:]
    /// Told when a window opens (true) or the last closes (false), for the Dock icon.
    var onVisibilityChange: (Bool) -> Void = { _ in }
    private var observers: [NSObjectProtocol] = []
    private var keyMonitor: Any?

    init(model: AppModel) { self.model = model }

    static let contentSize = NSSize(width: 860, height: 560)

    func show(node: String?) {
        if let window, self.node != node { Self.fill(window, model: model, node: node, room: nil) }
        let window = self.window ?? made(node: node, room: nil, autosave: "AgentSwitchPasswords")
        self.window = window
        self.node = node
        front(window)
    }

    func show(node: String?, room: RoomBook) {
        let key = "\(node ?? "")|\(room.id)"
        let window = roomWindows[key] ?? made(node: node, room: room, autosave: "AgentSwitchRoomPasswords")
        roomWindows[key] = window
        // The room may have been renamed since.
        window.title = Self.title(model: model, node: node, room: room)
        front(window)
    }

    private func front(_ window: NSWindow) {
        onVisibilityChange(true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private var all: [NSWindow] { (window.map { [$0] } ?? []) + roomWindows.values }

    /// The window, not yet on screen; `-designPreview` draws the same one off-screen.
    static func makeWindow(model: AppModel, node: String?, room: RoomBook? = nil, windowClass: NSWindow.Type = NSWindow.self, appearance: NSAppearance? = nil) -> NSWindow {
        let window = windowClass.init(contentRect: NSRect(origin: .zero, size: contentSize),
                                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.appearance = appearance
        fill(window, model: model, node: node, room: room)
        window.setContentSize(contentSize)
        window.contentMinSize = NSSize(width: 640, height: 400)
        window.isReleasedWhenClosed = false
        return window
    }

    private static func title(model: AppModel, node: String?, room: RoomBook?) -> String {
        let book = room.map { "Passwords · \($0.name)" } ?? "Passwords"
        return model.nodes.node(node).map { "\(book) — \($0.name)" } ?? book
    }

    private static func fill(_ window: NSWindow, model: AppModel, node: String?, room: RoomBook?) {
        let size = window.contentView?.frame.size
        let host = NSHostingController(rootView: PasswordsPage(node: node, room: room?.id).environment(model).followsWindow())
        host.sizingOptions = []
        window.contentViewController = host
        if let size, size.width > 0 { window.setContentSize(size) }
        window.title = title(model: model, node: node, room: room)
    }

    private func made(node: String?, room: RoomBook?, autosave: String) -> NSWindow {
        let window = Self.makeWindow(model: model, node: node, room: room)
        window.center()
        if room == nil || roomWindows.isEmpty { window.setFrameAutosaveName(autosave) }
        observers.append(NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] note in
            nonisolated(unsafe) let closing = note.object as? NSWindow
            MainActor.assumeIsolated {
                guard let self else { return }
                self.roomWindows = self.roomWindows.filter { $0.value !== closing }
                if !self.all.contains(where: { $0 !== closing && $0.isVisible }) { self.onVisibilityChange(false) }
            }
        })
        // ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z in its fields, and ⌘W: a menu bar app has no menus to send them.
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                nonisolated(unsafe) let key = event
                let taken = MainActor.assumeIsolated { self?.key(key) ?? false }
                return taken ? nil : event
            }
        }
        return window
    }

    private func key(_ event: NSEvent) -> Bool {
        guard let target = event.window, let window = all.first(where: { $0 === target || target.sheetParent === $0 }) else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), !flags.contains(.control), !flags.contains(.option) else { return false }
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if key == "w", !flags.contains(.shift), target === window { window.performClose(nil); return true }
        guard target.firstResponder is NSText else { return false }
        let action: Selector? = switch (key, flags.contains(.shift)) {
        case ("c", false): #selector(NSText.copy(_:))
        case ("v", false): #selector(NSText.paste(_:))
        case ("x", false): #selector(NSText.cut(_:))
        case ("a", false): #selector(NSText.selectAll(_:))
        case ("z", false): Selector(("undo:"))
        case ("z", true): Selector(("redo:"))
        default: nil
        }
        guard let action else { return false }
        return NSApp.sendAction(action, to: nil, from: target)
    }
}

/// The password book (design-password-book.md; user #345-#351), in a window of its own (PasswordsWindowController). The
/// list never holds a password; one is fetched (`reveal`) after Touch ID, which is not asked again for five minutes,
/// shown for twenty seconds; a copy stays on the clipboard (user #377). Each password is also a word the model never
/// sees (Settings › Redaction).
struct PasswordsPage: View {
    /// The node whose book this is; nil: this Mac (user #356).
    let node: String?
    /// A room's own book (user #416); nil: the book of everything.
    var room: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.onScreen) private var onScreen
    @Environment(\.interfaceLook) private var look
    @State private var model = PasswordsModel()

    var body: some View {
        HStack(spacing: 0) {
            // The classic look: the list is a card that floats on the window's ground (docs/design-rules.md §2).
            list.sideCard(leading: Look.panelGap, trailing: Look.panelGap, bottom: Look.panelGap).padding(.top, look.isClassic ? Look.panelGap : 0)
                .frame(width: 300 + (look.isClassic ? 2 * Look.panelGap : 0))
            HairRule(color: look.isClassic ? .clear : Look.line, vertical: true)
            detail.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Look.ground)
        .task(id: onScreen) {
            if model.node != node || model.room != room { model.switchNode(node); model.room = room }
            model.client = { [app, node] in app.client(on: node) }
            if let demo = PasswordsDemo.current { model.show(demo: demo); return }
            guard onScreen else { return }
            await model.load()
        }
    }

    // MARK: the list

    /// The book's list (2026-11-26, user #456: 密码本太难看了 — it was a system search field, grey letter squares and
    /// five stacked boxes): a quiet search field with the `+` beside it, each entry a coloured tile of its first letter
    /// with its name and account.
    private var list: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    LookGlyph(glyph: "⌕", symbol: "magnifyingglass", size: 12).foregroundStyle(Look.faint)
                    TextField("", text: $model.query, prompt: Text("Search")).textFieldStyle(.plain).font(.system(size: 13))
                }
                .padding(.horizontal, 9).frame(height: 28)
                .grounded(Look.raised, radius: Look.controlRadius)
                Button { model.startNew() } label: {
                    LookGlyph(glyph: "+", symbol: "plus", size: 14).foregroundStyle(Look.ink).frame(width: 28, height: 28).grounded(Look.raised, radius: Look.controlRadius)
                }
                .buttonStyle(.plain).help("New Password")
            }
            .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 8)
            HairRule(color: look.isClassic ? .clear : Look.line)
            ScrollView {
                LazyVStack(spacing: look.isClassic ? 2 : 0) {
                    ForEach(model.shown) { e in
                        Button { model.select(e.id) } label: { row(e) }.buttonStyle(.plain)
                        HairRule(color: look.isClassic ? .clear : Look.line)
                    }
                    if model.items.isEmpty && model.loaded {
                        Text("密码本还是空的。点 + 新建一条，或导入浏览器导出的 CSV。").font(.system(size: 12.5)).foregroundStyle(Look.ink2).padding(16)
                    }
                }
            }
            HairRule(color: look.isClassic ? .clear : Look.line)
            HStack {
                Text(model.items.count == 1 ? "1 Item" : "\(model.items.count) Items").font(.system(size: 11.5)).foregroundStyle(Look.faint).monospacedDigit()
                Spacer()
                Button("Import CSV…") { model.importCSV() }.buttonStyle(.plain).font(.system(size: 11.5)).foregroundStyle(Look.ink2)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
        }
    }

    private func row(_ e: PasswordItem) -> some View {
        HStack(spacing: 10) {
            PasswordTile(name: e.name, side: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(e.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink).lineLimit(1)
                Text(e.account.isEmpty ? (e.sites.first ?? "") : e.account).font(.system(size: 11.5)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        // The row chosen: tinted, with round corners clear of the card's edges in the classic look (design-rules §3.3).
        .background(RoundedRectangle(cornerRadius: look.isClassic ? Look.controlRadius : 0, style: .continuous).fill(model.selected == e.id ? Color.signal.opacity(0.18) : Color.clear))
        .padding(.horizontal, look.isClassic ? 6 : 0)
        .contentShape(Rectangle())
    }

    // MARK: the entry

    /// One entry: its tile, name and site at the head; under them one card whose rows are the account, the site, the
    /// password, the code and the note — a label, the value, and what can be done with it at the row's end.
    @ViewBuilder private var detail: some View {
        if model.editing {
            PasswordEditor(model: model)
        } else if let e = model.current {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        PasswordTile(name: e.name, side: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1)
                            if let site = e.sites.first { Text(site).font(.system(size: 12.5)).foregroundStyle(Look.ink2).lineLimit(1) }
                        }
                        Spacer(minLength: 8)
                        Button { model.startEdit() } label: { BracketLabel(word: "Edit") }.buttonStyle(BracketButtonStyle(size: 12))
                        Button { model.confirmingRemove = true } label: { BracketLabel(word: "Delete") }.buttonStyle(BracketButtonStyle(role: .destructive, size: 12))
                    }
                    VStack(spacing: 0) {
                        PasswordRow(label: "Account") {
                            Text(e.account.isEmpty ? "—" : e.account).font(.system(size: 13)).foregroundStyle(e.account.isEmpty ? Look.faint : Look.ink).textSelection(.enabled).lineLimit(1)
                        } actions: {
                            if !e.account.isEmpty { PasswordAction("Copy") { model.copyPlain(e.account) } }
                        }
                        if !e.sites.isEmpty {
                            PasswordRow(label: "Website") {
                                Text(e.sites.joined(separator: "\n")).font(.system(size: 13)).foregroundStyle(Look.ink).textSelection(.enabled)
                            } actions: { EmptyView() }
                        }
                        PasswordRow(label: "Password", last: !e.hasTotp && !e.hasNote) {
                            if let secret = model.secret?.password, model.showing {
                                Text(secret).font(.system(size: 13).monospaced()).foregroundStyle(Look.ink).textSelection(.enabled).lineLimit(2)
                            } else {
                                Text(String(repeating: "•", count: min(max(e.length, 8), 20))).font(.system(size: 13).monospaced()).foregroundStyle(Look.ink2)
                            }
                        } actions: {
                            PasswordAction(model.showing ? "Hide" : "Show") { Task { await model.toggleShow() } }
                            PasswordAction("Copy") { Task { await model.copyPassword() } }
                        }
                        if e.hasTotp {
                            PasswordRow(label: "Code", last: !e.hasNote) {
                                if let code = model.secret?.totp {
                                    HStack(spacing: 8) {
                                        Text(code.code.prefix(3) + " " + code.code.suffix(3)).font(.system(size: 15, weight: .medium).monospaced()).foregroundStyle(Look.ink)
                                        Text("\(code.left)s").font(.system(size: 11.5)).monospacedDigit().foregroundStyle(code.left <= 5 ? Color.waiting : Look.faint)
                                    }
                                } else {
                                    Text("••• •••").font(.system(size: 15).monospaced()).foregroundStyle(Look.ink2)
                                }
                            } actions: {
                                PasswordAction("Copy") { Task { await model.copyCode() } }
                            }
                        }
                        if e.hasNote {
                            PasswordRow(label: "Note", last: true) {
                                if let note = model.secret?.note, model.showing {
                                    Text(note).font(.system(size: 13)).foregroundStyle(Look.ink).textSelection(.enabled)
                                } else {
                                    Text("••••••").font(.system(size: 13).monospaced()).foregroundStyle(Look.ink2).help("和密码一起显示")
                                }
                            } actions: { EmptyView() }
                        }
                    }
                    .grounded(Look.panel, radius: Look.cardRadius)
                    .framed(look.isClassic ? Look.ring : Look.line, radius: Look.cardRadius)
                    .lifted()
                    if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Look.ink2) }
                }
                .padding(.horizontal, 28).padding(.vertical, 24)
                .frame(maxWidth: 600, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .confirmationDialog("删除「\(e.name)」？", isPresented: $model.confirmingRemove) {
                Button("Delete", role: .destructive) { Task { await model.remove() } }
            } message: { Text("删除后无法恢复。") }
        } else {
            VStack(spacing: 10) {
                LookGlyph(glyph: "▣", symbol: "lock", size: 26).foregroundStyle(Look.faint)
                Text("No Password Selected").font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink2)
                if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Look.ink2) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// An entry's tile: its first letter on one of the ten soft colours, the same one for the same name.
private struct PasswordTile: View {
    let name: String
    let side: CGFloat
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let color = Color.faces[Int(name.unicodeScalars.reduce(UInt32(7)) { ($0 &* 31) &+ $1.value } % 10)]
        Text(String(name.prefix(1)).uppercased()).font(.system(size: side * 0.44, weight: .semibold)).foregroundStyle(Color.white)
            .frame(width: side, height: side)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? side * 0.26 : 0, style: .continuous).fill(color))
    }
}

/// One row of an entry's card: the label in its own column, the value, and what can be done at the end; a faint line
/// under every row but the last.
private struct PasswordRow<Value: View, Actions: View>: View {
    let label: String
    var last = false
    @ViewBuilder let value: () -> Value
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.system(size: 12.5)).foregroundStyle(Look.ink2).frame(width: 76, alignment: .leading)
            value().frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 12) { actions() }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .overlay(alignment: .bottom) { if !last { HairRule(color: Look.line).padding(.leading, 14) } }
    }
}

/// A word at a row's end that does something: quiet until the pointer is on it.
private struct PasswordAction: View {
    let word: String
    let action: () -> Void
    @State private var hovering = false

    init(_ word: String, action: @escaping () -> Void) { self.word = word; self.action = action }

    var body: some View {
        Button(action: action) { Text(word).font(.system(size: 12, weight: .medium)).foregroundStyle(hovering ? Color.signal : Look.ink2) }
            .buttonStyle(.plain).onHover { hovering = $0 }
    }
}

/// New, or Edit: a password left empty when editing stays as it was.
private struct PasswordEditor: View {
    @Bindable var model: PasswordsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.selected == nil ? "New Password" : "Edit Password").font(.system(size: 17, weight: .semibold)).foregroundStyle(Look.ink)
                VStack(spacing: 0) {
                    row("Name") { TextField("", text: $model.draft.name, prompt: Text("GitHub")) }
                    row("Website") { TextField("", text: $model.draft.sites, prompt: Text("github.com")) }
                    row("Account") { TextField("", text: $model.draft.account, prompt: Text("name@example.com")) }
                    row("Password") {
                        HStack(spacing: 10) {
                            SecureField("", text: $model.draft.password, prompt: Text(model.selected == nil ? "" : "Unchanged"))
                            PasswordAction("Generate") { Task { await model.generate() } }
                        }
                    }
                    row("Code Key") { SecureField("", text: $model.draft.totp, prompt: Text(model.selected == nil ? "Optional" : "Unchanged")) }
                    row("Note", last: true) { TextField("", text: $model.draft.note, prompt: Text(model.selected == nil ? "Optional" : "Unchanged"), axis: .vertical).lineLimit(1...5) }
                }
                .textFieldStyle(.plain).font(.system(size: 13))
                .grounded(Look.panel, radius: Look.cardRadius)
                .framed(look.isClassic ? Look.ring : Look.line, radius: Look.cardRadius)
                    .lifted()
                if let made = model.generated {
                    Text(made).font(.system(size: 12.5).monospaced()).foregroundStyle(Look.ink).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                        .grounded(Look.raised, radius: Look.controlRadius)
                }
                if let said = model.said { Text(said).font(.system(size: 12)).foregroundStyle(Color.waiting) }
                HStack {
                    Spacer()
                    Button { model.editing = false } label: { BracketLabel(word: "Cancel", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
                    Button { Task { await model.save() } } label: { BracketLabel(word: "Save") }.buttonStyle(BracketButtonStyle(role: .primary))
                        .disabled(model.draft.name.trimmingCharacters(in: .whitespaces).isEmpty || (model.selected == nil && model.draft.password.isEmpty))
                }
            }
            .padding(.horizontal, 28).padding(.vertical, 24)
            .frame(maxWidth: 600, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func row<C: View>(_ label: String, last: Bool = false, @ViewBuilder _ content: () -> C) -> some View {
        let field = content().labelsHidden()
        return PasswordRow(label: label, last: last) { field } actions: { EmptyView() }
    }
}

@MainActor
@Observable
final class PasswordsModel {
    @ObservationIgnored var client: () -> DaemonClient = { fatalError("no client") }
    /// The node whose book this is; nil: this Mac.
    @ObservationIgnored private(set) var node: String?
    /// The room whose own book this is (user #416); nil: the book of everything.
    @ObservationIgnored var room: String?

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
        do { items = try await client().passwords(room: room); loaded = true } catch { said = (error as? CommandError)?.message ?? error.localizedDescription }
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
            let e = try await client().savePassword(draft, id: selected, room: room)
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
        said = "已复制。"
    }

    func copyCode() async {
        guard let s = await fetch("复制两步验证码"), let code = s.totp?.code else { return }
        copySecret(code)
        said = "验证码已复制。"
    }

    func copyPlain(_ text: String) { Clipboard.copy(text) }

    /// Copied as any text is; it stays on the clipboard until something else is copied (user #377).
    private func copySecret(_ text: String) { Clipboard.copy(text) }

    /// A CSV a browser or a password manager exported; the plain file is offered to the Trash after.
    func importCSV() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.commaSeparatedText, .plainText]
        guard panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        Task {
            do {
                let r = try await client().importPasswords(csv: text, room: room)
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
