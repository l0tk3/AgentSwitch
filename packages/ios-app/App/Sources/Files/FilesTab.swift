import AgentSwitchKit
import AgentSwitchLive
import SwiftUI

/// The `Files` page (docs/files-v0.md §5; 2026-10-16, user: 开一个标签页吧; since 2026-11-22 a sheet from the Terminals
/// page's top bar, docs/chatroom-v0.md §10: its place in the tab bar is Rooms'): the Mac's files, opened where it was last on
/// this Mac (the first time, the Mac's home folder), or at a terminal's folder from its row (`Show in Files`). Nobody
/// to give to here: `Add to Reply…` asks which terminal, then opens that terminal's page with the files in its reply
/// box.
struct FilesTab: View {
    /// It is up as a sheet: its first page has `Done`.
    var inSheet = false
    @Environment(AppModel.self) private var model
    @State private var session = FilesSession(mode: .tab, root: nil)
    @State private var started = false

    var body: some View {
        Group {
            if started { FilesBrowser(session: session) { _ in } } else { Theme.base.ignoresSafeArea() }
        }
        .sheet(isPresented: Binding(get: { session.choosing != nil }, set: { if !$0 { session.choosing = nil } })) {
            TerminalChooser(picks: session.choosing ?? [], session: session).followsLook()
        }
        .onAppear { session.closes = inSheet; start() }
        .onChange(of: model.files.openRequest) { start() }
        // Another Mac: where the tab was on that one.
        .onChange(of: model.profile?.fingerprint) {
            session.endSelecting()
            session.root = model.files.lastPlace(on: model.profile?.fingerprint)
            session.stack = []
        }
    }

    private func start() {
        if let asked = model.files.openRequest {
            model.files.openRequest = nil
            session.endSelecting()
            session.root = asked
            session.stack = []
            started = true
            #if DEBUG
            demo()
            #endif
            return
        }
        guard !started else { return }
        session.root = model.files.lastPlace(on: model.profile?.fingerprint)
        started = true
    }
}

#if DEBUG
extension FilesTab {
    /// The demo screens' pages, as taps would open them (`-uiDemoScreen files…`, AgentSwitchApp).
    private func demo() {
        let p = DemoFiles.project
        switch UserDefaults.standard.string(forKey: "uiDemoScreen") {
        case "filespreview": session.root = "\(p)/src"; session.stack = [.file("\(p)/src/app.ts")]
        case "filespreviewlong": session.root = "\(p)/dist"; session.stack = [.file("\(p)/dist/app.min.js")]
        case "filesimage": session.root = "\(p)/docs"; session.stack = [.file("\(p)/docs/logo.png")]
        case "filesselect", "fileschoose":
            session.root = "\(p)/src"
            session.selecting = true
            session.togglePick(MacPick(path: "\(p)/src/app.ts", isFolder: false))
            session.togglePick(MacPick(path: "\(p)/src/store.ts", isFolder: false))
            if UserDefaults.standard.string(forKey: "uiDemoScreen") == "fileschoose" { session.choosing = session.picked }
        case "filessensitive":
            UserDefaults.standard.set(true, forKey: FilesPrefs.hiddenKey)
            session.stack = [.file("\(p)/.env")]
            session.choosing = [MacPick(path: "\(p)/.env", isFolder: false, sensitive: true)]
        // Changing files (docs/files-v0.md §12), as ⋯, a long press and Select would open them.
        case "filesnew":
            session.root = p
            session.naming = FilesSession.Naming(kind: .folder(in: p), taken: ["docs", "src", "node_modules", "README.md", "package.json"], value: "fixtures")
        case "filesnameerror":
            session.root = p
            session.naming = FilesSession.Naming(kind: .folder(in: p), taken: ["docs"], value: "docs", error: "此位置已有“docs”。请换一个名称。")
        case "filestrash": session.root = "\(p)/src"; session.trashing = FilesSession.Trashing(paths: ["\(p)/src/app.ts"])
        case "filestrashbusy": session.root = p; session.trashing = FilesSession.Trashing(paths: ["\(p)/src"], terminal: "iPhone 终端标签页")
        case "filesselectbar":
            session.root = "\(p)/src"
            session.selecting = true
            session.togglePick(MacPick(path: "\(p)/src/app.ts", isFolder: false))
            session.togglePick(MacPick(path: "\(p)/src/store.ts", isFolder: false))
        case "filesshare": session.root = "\(p)/docs"; session.stack = [.file("\(p)/docs/logo.png")]; session.share(["\(p)/docs/logo.png"], model.fileSource)
        case "filesupload", "filesclash":
            session.root = "\(p)/docs"
            let made = ["IMG_0412.HEIC", "IMG_0413.HEIC"] + (UserDefaults.standard.string(forKey: "uiDemoScreen") == "filesclash" ? ["logo.png"] : [])
            let files = made.compactMap { name -> URL? in
                let to = FilesStore.holder().appendingPathComponent(name)
                return (try? Data(count: 2_400_000).write(to: to)) != nil ? to : nil
            }
            let asking = model.files.send(files, to: "\(p)/docs", taken: ["files-v0.md", "logo.png"]) { model.fileSource }
            if !asking.isEmpty { session.clashing = FilesSession.Clashing(uploads: asking, names: ["logo.png"]) }
        default: break
        }
    }
}
#endif

/// `Add to Reply…`: which of this Mac's terminals the files go to, the one used last first (agent, name, folder). A file
/// that may hold a password is asked about once it is known where it goes.
struct TerminalChooser: View {
    let picks: [MacPick]
    let session: FilesSession
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var asking: TerminalInfo?

    private var terminals: [TerminalInfo] {
        model.terminals.terminals.filter(\.isRunning).sorted { max($0.lastOutputAt, $0.createdAt) > max($1.lastOutputAt, $1.createdAt) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if terminals.isEmpty {
                        Text("没有开着的终端。请先在 Terminals 页新建一个。").font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                    }
                    ForEach(terminals) { t in
                        Button { choose(t) } label: { row(t) }.buttonStyle(.plain)
                    }
                }
            }
            .background { Theme.base.ignoresSafeArea() }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    HairRule()
                    Text("选的文件会落进这个终端的回复框，最近用过的终端在前。").font(.footnote).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(Theme.Space.l)
                }
                .background(Theme.base)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Add to Reply").font(.headline)
                        Text(picks.count == 1 ? "1 File" : "\(picks.count) Files").mono(11).foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Cancel") } else { Text("Cancel").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .alert(SensitiveWarning.title, isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), presenting: asking) { t in
            Button("Cancel", role: .cancel) {
                let rest = picks.filter { !$0.sensitive }
                asking = nil
                if !rest.isEmpty { deliver(rest, to: t) }
            }
            Button("Add") { asking = nil; deliver(picks, to: t) }
        } message: { _ in
            Text(SensitiveWarning.message(picks.filter(\.sensitive).map(\.name)))
        }
        #if DEBUG
        // The question, as choosing the first terminal would ask it.
        .onAppear {
            if UserDefaults.standard.string(forKey: "uiDemoScreen") == "filessensitive", let t = terminals.first {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { asking = t }
            }
        }
        #endif
    }

    private func row(_ t: TerminalInfo) -> some View {
        HStack(spacing: 12) {
            PixelSprite(rows: PixelArt.agents[t.harness] ?? PixelArt.square, pixel: 2, color: .secondary, strength: 0.9, shadow: false)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(t.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(model.files.home.map { MacPath.short(t.workdir, home: $0) } ?? MacPath.tilde(t.workdir)).mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 6)
            TerminalStatusMark(status: t.permissions.isEmpty ? t.status : .waiting)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? 50 : 0) }
        .contentShape(Rectangle())
    }

    private func choose(_ t: TerminalInfo) {
        if picks.contains(where: \.sensitive) { asking = t } else { deliver(picks, to: t) }
    }

    /// To the terminal's page: the tab switches to Terminals, opens it, and its page takes the files.
    private func deliver(_ landed: [MacPick], to t: TerminalInfo) {
        model.files.handoff = .init(terminal: t.id, picks: landed)
        session.choosing = nil
        session.endSelecting()
        dismiss()
        model.openTerminal(t.id)
    }
}

extension ShadedSprite {
    /// The Files tab's picture in the pixel look (the app's own; not one of the three shared copies): a folder, its tab
    /// and back panel darker, the front panel raised — a light edge above and left, a dark one below and right.
    static let folder = ShadedSprite([
        ".dddddd.........", "dkkkkkkdddddddd.", "dkkkkkkkkkkkkkkd", "WWWWWWWWWWWWWWW#", "W##############m", "W##############m",
        "W##############m", "W##############m", "W##############m", "W##############m", "#mmmmmmmmmmmmmmd",
    ])
}
