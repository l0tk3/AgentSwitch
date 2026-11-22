import AgentSwitchKit
import SwiftUI

/// The Mac's files on the phone (docs/files-v0.md §5): a stack of pages, one level at a time, as iOS Files has them — the
/// folder's name in the bar with the Mac under it, its whole path under the bar (every level a button), the list, and
/// `Select` and `⋯` (hidden files, the order, home). The classic look is iOS Files' list; the pixel look draws the level
/// in tree lines, a folder's `▸` opening one level in place. A file opens its preview. The Files tab and `+` › Files on
/// Mac over a terminal are this same browser; what differs is where the picks go (`FilesSession.Mode`).
struct FilesBrowser: View {
    let session: FilesSession
    /// Picks that are to land (checked, and asked about when one may hold a password).
    var onPick: ([MacPick]) -> Void

    var body: some View {
        @Bindable var session = session
        NavigationStack(path: $session.stack) {
            FolderPage(path: session.root, session: session, onPick: onPick, first: true)
                .id(session.root ?? "")
                .navigationDestination(for: FilesRoute.self) { route in
                    switch route {
                    case .folder(let p): FolderPage(path: p, session: session, onPick: onPick, first: false)
                    case .file(let p): FilePreviewPage(path: p, session: session, onPick: onPick)
                    }
                }
        }
        .sensitiveQuestion(session)
        .fileChangeQuestions(session)
    }
}

/// `+` › Files on Mac over a terminal's page: the browser at the terminal's folder, a large sheet; what is picked lands
/// in that terminal's reply box.
struct MacFilesSheet: View {
    @State private var session: FilesSession
    let onPick: ([MacPick]) -> Void

    /// `file`: a file tapped on the terminal's screen, its preview on top of its folder's page (files-v0 §12.4.2).
    init(terminal: String, start: String, file: String? = nil, onPick: @escaping ([MacPick]) -> Void) {
        let session = FilesSession(mode: .sheet(terminal: terminal), root: start)
        if let file { session.stack = [.file(file)] }
        _session = State(initialValue: session)
        self.onPick = onPick
    }

    var body: some View {
        FilesBrowser(session: session, onPick: onPick)
            .presentationDetents([.large])
    }
}

/// `Show in Files` from an earlier session's page (docs/files-v0.md §12.4.1; 2026-10-18, user: 弹出页面然后点击done返回):
/// the browser over the page at the session's folder, `Done` back to it. No reply box here: `Add to Reply…` asks which
/// terminal, and that terminal's page opens with them.
struct MacFilesOverSheet: View {
    @State private var session: FilesSession

    init(start: String) { _session = State(initialValue: FilesSession(mode: .over, root: start)) }

    var body: some View {
        FilesBrowser(session: session) { _ in }
            .sheet(isPresented: Binding(get: { session.choosing != nil }, set: { if !$0 { session.choosing = nil } })) {
                TerminalChooser(picks: session.choosing ?? [], session: session).followsLook()
            }
            .presentationDetents([.large])
    }
}

/// One folder's page.
struct FolderPage: View {
    let session: FilesSession
    var onPick: ([MacPick]) -> Void
    /// The browser's first page (its `Done` in a sheet).
    let first: Bool
    @State private var folder: FolderModel
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @AppStorage(FilesPrefs.hiddenKey) private var hidden = false
    @AppStorage(FilesPrefs.sortKey) private var sortRaw = FileSort.name.rawValue
    // ⋯ › Upload's three sources (as the terminal page's `+`, files-v0 §12.8).
    @State private var takingPhoto = false
    @State private var pickingPhotos = false
    @State private var pickingFiles = false

    init(path: String?, session: FilesSession, onPick: @escaping ([MacPick]) -> Void, first: Bool) {
        self.session = session
        self.onPick = onPick
        self.first = first
        _folder = State(initialValue: FolderModel(asked: path))
    }

    private var sort: FileSort { FileSort(rawValue: sortRaw) ?? .name }
    private var mac: String { model.profile?.name ?? "Mac" }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if model.connection.endpoint == nil && model.fileSource == nil { ConnectionBanner().padding(Theme.Space.l) }
                content
            }
        }
        .background { ZStack { Theme.base; if !look.isClassic { Scanlines() } }.ignoresSafeArea() }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if let path = folder.path { PathRow(path: path, session: session) }
                HairRule()
            }
            .background(Theme.base)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if session.selecting {
                SelectBar(session: session, give: { give(session.picked) },
                          share: session.asksTerminal ? { session.share(session.picked.map(\.path), model.fileSource) } : nil,
                          trash: session.asksTerminal ? { askTrash(session.picked.map(\.path)) } : nil)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(false)
        .toolbar(session.selecting && session.inTab ? .hidden : .automatic, for: .tabBar)
        .toolbar { toolbar }
        .task(id: hidden) { await folder.follow({ model.fileSource }, hidden: { hidden }) }
        #if DEBUG
        // `filesopen`: the pixel look's `▸` on `src`, as a tap would open it in place.
        .task {
            guard first, UserDefaults.standard.string(forKey: "uiDemoScreen") == "filesopen" else { return }
            try? await Task.sleep(for: .milliseconds(400))
            await folder.toggle("\(DemoFiles.project)/src", model.fileSource, hidden: hidden)
        }
        #endif
        .onChange(of: folder.folder?.path) { _, path in
            if session.inTab, let path { model.files.remember(path, on: model.profile?.fingerprint) }
            if let home = folder.folder?.home { model.files.home = home }
        }
        // Back on this page from one further in: this is where the tab is now.
        .onAppear { if session.inTab, let path = folder.folder?.path { model.files.remember(path, on: model.profile?.fingerprint) } }
        .refreshable { await folder.load(model.fileSource, hidden: hidden) }
        // Changed from this phone just now (made, renamed, moved, landed): read again at once.
        .onChange(of: model.files.changed) { Task { await folder.load(model.fileSource, hidden: hidden) } }
        // What was just made or landed lights up once.
        .task(id: model.files.lit) {
            guard model.files.lit != nil else { return }
            try? await Task.sleep(for: .milliseconds(1600))
            model.files.lit = nil
        }
        .sheet(isPresented: $pickingPhotos) { PhotoFilesPicker { send($0) }.ignoresSafeArea() }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { send(FilesStore.copies(of: urls)) }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { jpeg in
                takingPhoto = false
                if let jpeg, let file = FilesStore.cameraFile(jpeg) { send([file]) }
            }
            .ignoresSafeArea()
        }
    }

    /// The names in this folder now: what a new name is checked against, and what an upload asks about.
    private var taken: Set<String> { Set(folder.folder?.entries.map(\.name) ?? []) }

    /// Picked files on their way into this folder; a name taken here is asked about once for all of them.
    private func send(_ files: [URL]) {
        guard let dir = folder.folder?.path, !files.isEmpty else { return }
        model.files.macName = mac
        let asking = model.files.send(files, to: dir, taken: taken) { model.fileSource }
        if !asking.isEmpty {
            session.clashing = FilesSession.Clashing(uploads: asking, names: model.files.uploads.filter { asking.contains($0.id) }.map(\.name))
        }
    }

    /// To the Mac's Trash, asked about first; a folder a terminal runs in says so (files-v0 §12.3).
    private func askTrash(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        let running = paths.lazy.compactMap { FilesSession.runningIn($0, model.terminals.terminals) }.first
        session.trashing = FilesSession.Trashing(paths: paths, terminal: running?.name)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(folder.path.map(MacPath.name) ?? "Files").font(.headline).lineLimit(1)
                if session.selecting && session.asksTerminal {
                    Text("\(session.picked.count) Selected").mono(11).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    // The tab's first page switches Macs; a folder further in, or a sheet over a terminal, only says which.
                    MacLine(switches: first && session.inTab)
                }
            }
        }
        if first, !session.inTab || session.closes, !session.selecting {
            ToolbarItem(placement: .cancellationAction) {
                Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                if session.selecting { session.endSelecting() } else { session.selecting = true }
            } label: {
                if look.isClassic { Text(session.selecting ? "Cancel" : "Select") } else { Text(session.selecting ? "Cancel" : "Select").mono(15) }
            }
            .tint(look.isClassic ? Theme.signal : Theme.ink)
            .disabled(folder.folder == nil)
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                // New and Upload first, into the folder shown (files-v0 §12.3, §12.8).
                Section {
                    Button("New Folder", systemImage: "folder.badge.plus") { if let dir = folder.folder?.path { session.naming = FilesSession.Naming(kind: .folder(in: dir), taken: taken, value: "") } }
                    Button("New File", systemImage: "doc.badge.plus") { if let dir = folder.folder?.path { session.naming = FilesSession.Naming(kind: .file(in: dir), taken: taken, value: "") } }
                    Menu {
                        Button("Camera", systemImage: "camera") { takingPhoto = true }.disabled(!CameraPicker.isAvailable)
                        Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                        Button("Files", systemImage: "folder") { pickingFiles = true }
                    } label: { Label("Upload", systemImage: "arrow.up.doc") }
                }
                .disabled(folder.folder == nil || folder.folder?.path == "/")
                Toggle(isOn: $hidden) { Label("Show Hidden Files", systemImage: "eye") }
                Picker(selection: $sortRaw) {
                    ForEach(FileSort.allCases, id: \.rawValue) { s in Text(s.title).tag(s.rawValue) }
                } label: { Label("Sort By", systemImage: "arrow.up.arrow.down") }
                .pickerStyle(.menu)
                Divider()
                Button("Home", systemImage: "house") { session.root = nil; session.stack = [] }
            } label: { LookGlyph.more }
            .tint(look.isClassic ? Theme.signal : Theme.ink)
        }
    }

    @ViewBuilder private var content: some View {
        if let refusal = folder.refusal {
            note(refusal.sentence(mac: mac), home: refusal == .scope || refusal == .notFound)
        } else if let level = folder.folder {
            if let failure = folder.failure { Text(failure).font(.footnote).foregroundStyle(Theme.failed).padding(Theme.Space.l) }
            if let gone = folder.gone {
                Text("\(mac) 上没有“\(MacPath.name(gone))”，已打开它最近的上一层。").font(.footnote).foregroundStyle(.secondary)
                    .padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.m)
            }
            ForEach(model.files.uploads.filter { $0.dir == level.path }) { up in
                UploadRow(upload: up, stop: { model.files.stop(up.id) }, retry: { model.files.retry(up.id) { model.fileSource } })
            }
            let entries = sort.sorted(level.entries)
            if entries.isEmpty && !model.files.uploads.contains(where: { $0.dir == level.path }) {
                note(level.scoped ? "仅显示授权范围内的项目。" : "此文件夹为空。")
            } else {
                ForEach(Array(entries.enumerated()), id: \.element.id) { i, entry in
                    row(entry, in: level.path, last: i == entries.count - 1 && !folder.isOpen(MacPath.join(level.path, entry.name)), depth: 0, underLast: false)
                    // The pixel look's folder opened in place: its level under it.
                    if !look.isClassic, entry.isFolder, let kids = folder.opened[MacPath.join(level.path, entry.name)] {
                        let sorted = sort.sorted(kids.filter { hidden || !$0.hidden })
                        ForEach(Array(sorted.enumerated()), id: \.element.id) { k, kid in
                            row(kid, in: MacPath.join(level.path, entry.name), last: k == sorted.count - 1, depth: 1, underLast: i == entries.count - 1)
                        }
                    }
                }
                footer(level, shown: entries.count)
            }
        } else if let failure = folder.failure {
            note(failure)
        } else {
            HStack(spacing: 8) { BrailleSpinner(color: .secondary); Text("Loading").mono(12).foregroundStyle(.secondary) }.padding(Theme.Space.l)
        }
    }

    private func note(_ words: String, home: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Text(words).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if home {
                Button { session.root = nil; session.stack = [] } label: { ButtonWord("Home") }
                    .buttonStyle(SquareButtonStyle(expand: false))
            }
        }
        .padding(Theme.Space.l)
    }

    private func footer(_ level: MacFolder, shown: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if level.scoped { Text("仅显示授权范围内的项目。").font(.footnote).foregroundStyle(.secondary) }
            if level.more > 0 { Text("还有 \(level.more) 项未列出。").font(.footnote).foregroundStyle(.secondary) }
            Text([shown == 1 ? "1 Item" : "\(shown) Items", level.hiddenCount > 0 && !hidden ? "\(level.hiddenCount) Hidden" : nil].compactMap { $0 }.joined(separator: " · "))
                .mono(11).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
    }

    /// One entry: a tap opens it (a folder's page, a file's preview) or, while selecting, picks it; a locked one does
    /// nothing.
    private func row(_ entry: MacFileEntry, in dir: String, last: Bool, depth: Int, underLast: Bool) -> some View {
        let path = MacPath.join(dir, entry.name)
        let pick = MacPick(path: path, isFolder: entry.isFolder)
        // A tap on the row, not a button around it: the pixel look's `▸` in it is a button of its own.
        return FileRow(entry: entry, picked: session.isPicked(path) || model.files.lit == path, selecting: session.selecting, last: last, depth: depth, underLast: underLast,
                       open: folder.isOpen(path), toggle: entry.isFolder && depth == 0 && !entry.locked ? { Task { await folder.toggle(path, model.fileSource, hidden: hidden) } } : nil)
            .onTapGesture {
                guard !entry.locked else { return }
                if session.selecting { session.togglePick(pick) } else { session.stack.append(entry.isFolder ? .folder(path) : .file(path)) }
            }
            .contextMenu { if !entry.locked && !session.selecting { rowMenu(entry, path: path, dir: dir) } }
            .accessibilityAddTraits(entry.locked ? [] : .isButton)
            .accessibilityHint(entry.locked ? "此处存放 AgentSwitch 的凭据，无法在此打开。" : "")
    }

    /// A long press on a row (files-v0 §12.3, iOS Files): give it, share it, its path; its new name; the Mac's Trash
    /// last and red (HIG Context menus). What cannot be changed here has no Rename… or Move to Trash; a folder no Share….
    @ViewBuilder private func rowMenu(_ entry: MacFileEntry, path: String, dir: String) -> some View {
        Section {
            Button(session.asksTerminal ? "Add to Reply…" : "Add to Reply", systemImage: "arrowshape.turn.up.left") { give([MacPick(path: path, isFolder: entry.isFolder)]) }
            if !entry.isFolder { Button("Share…", systemImage: "square.and.arrow.up") { session.share([path], model.fileSource) } }
            Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        }
        if entry.changeable {
            Section {
                Button("Rename…", systemImage: "pencil") {
                    let names = dir == folder.folder?.path ? taken : Set(folder.opened[dir]?.map(\.name) ?? [])
                    session.naming = FilesSession.Naming(kind: .rename(path), taken: names, value: entry.name)
                }
            }
            Section { Button("Move to Trash", systemImage: "trash", role: .destructive) { askTrash([path]) } }
        }
    }

    /// `Add to Reply` (here) or `Add to Reply…` (the Files tab): each file asked about on the Mac first.
    private func give(_ picks: [MacPick]) {
        guard !picks.isEmpty else { return }
        Task {
            let checked = await session.checked(picks, model.fileSource)
            if session.asksTerminal {
                session.choosing = checked
            } else {
                // The terminal's page closes the sheet as it takes them.
                session.land(checked) { landed in
                    session.endSelecting()
                    onPick(landed)
                }
            }
        }
    }
}

/// One entry's row: iOS Files' (an icon, the name, when and how big, a chevron for a folder) or the pixel look's (tree
/// lines, `▸` for a folder, the name with `/`, its size).
struct FileRow: View {
    let entry: MacFileEntry
    let picked: Bool
    let selecting: Bool
    let last: Bool
    var depth = 0
    var underLast = false
    var open = false
    /// The pixel look's `▸`: the folder opened in place.
    var toggle: (() -> Void)?
    @Environment(\.interfaceLook) private var look

    private var faint: Bool { entry.hidden || entry.dim || entry.locked }
    private var meta: String {
        if entry.locked { return "" }
        let when = FileTime.short(entry.mtime)
        if entry.isFolder { return when }
        let size = FileSize.short(entry.size)
        return when.isEmpty ? size : "\(when) · \(size)"
    }

    var body: some View {
        if look.isClassic { classic } else { pixel }
    }

    private var classic: some View {
        HStack(spacing: 12) {
            if selecting && !entry.locked {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle").font(.system(size: 21))
                    .foregroundStyle(picked ? Theme.signal : Theme.inkDim)
            }
            FileIcon(entry: entry).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(entry.name).font(.system(size: 16)).foregroundStyle(faint ? Theme.secondaryInk : Theme.ink).lineLimit(1).truncationMode(.middle)
                    if let link = entry.link { Text("→ \(MacPath.name(link.target))").font(.system(size: 13)).foregroundStyle(.tertiary).lineLimit(1) }
                }
                if !meta.isEmpty { Text(meta).font(.system(size: 12.5)).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 6)
            if entry.isFolder && !selecting && !entry.locked { LookGlyph.onward(13).foregroundStyle(.tertiary) }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, Theme.Space.l)
        .background(picked ? Theme.signal.opacity(0.10) : Color.clear)
        .overlay(alignment: .bottom) { Theme.line.frame(height: 0.5).padding(.leading, selecting ? 92 : 58) }
        .contentShape(Rectangle())
    }

    private var pixel: some View {
        HStack(spacing: 0) {
            if selecting && !entry.locked {
                Text(picked ? "[x]" : "[ ]").code(13).foregroundStyle(picked ? Theme.signal : Theme.secondaryInk).padding(.trailing, 8)
            }
            Text((depth > 0 ? (underLast ? "   " : "│  ") : "") + (last ? "└─" : "├─")).code(13).foregroundStyle(Theme.inkDim)
            if entry.isFolder && !entry.locked {
                if let toggle {
                    Button(action: toggle) { Text(open ? "▾" : "▸").code(13).foregroundStyle(Theme.secondaryInk).frame(minWidth: 22, minHeight: 34) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(open ? "收起" : "展开")
                } else {
                    Text("▸").code(13).foregroundStyle(Theme.inkDim).frame(minWidth: 22)
                }
            } else {
                Text("─ ").code(13).foregroundStyle(Theme.inkDim)
            }
            Text(entry.name + (entry.isFolder ? "/" : ""))
                .code(13.5, weight: entry.isFolder && !faint ? .bold : .regular)
                .foregroundStyle(faint ? Theme.inkDim : Theme.ink)
                .lineLimit(1).truncationMode(.middle)
            if entry.locked { Text(" ⌧").code(13).foregroundStyle(Theme.inkDim) }
            if let link = entry.link { Text(" → \(MacPath.name(link.target))").code(12).foregroundStyle(Theme.inkDim).lineLimit(1) }
            Spacer(minLength: 8)
            if !entry.isFolder && !entry.locked {
                Text(FileSize.short(entry.size)).mono(11).foregroundStyle(.tertiary)
            }
        }
        .frame(minHeight: 40)
        .padding(.horizontal, Theme.Space.l)
        .background(picked ? Theme.raised : Color.clear)
        .overlay(alignment: .leading) { if picked { Theme.signal.frame(width: 3) } }
        .overlay(alignment: .bottom) { HairRule() }
        .contentShape(Rectangle())
    }
}

/// An entry's icon in the classic look: the folder in the accent, a file by its kind, the lock.
struct FileIcon: View {
    let entry: MacFileEntry

    var body: some View {
        Image(systemName: entry.locked ? "lock" : entry.isFolder ? "folder" : entry.kind == .link ? "link" : Self.symbol(for: entry.name))
            .font(.system(size: 21, weight: .light))
            .foregroundStyle(entry.isFolder && !entry.locked && !entry.dim && !entry.hidden ? Theme.signal : Theme.secondaryInk)
    }

    static func symbol(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "heic", "gif", "webp", "tiff", "bmp": return "photo"
        case "pdf": return "doc.richtext"
        case "csv", "xlsx", "xls", "numbers": return "tablecells"
        case "zip", "tar", "gz", "tgz", "7z", "dmg": return "doc.zipper"
        case "mp3", "m4a", "wav", "aac", "flac": return "waveform"
        case "mp4", "mov", "m4v", "webm": return "film"
        case "ts", "tsx", "js", "jsx", "swift", "py", "rs", "go", "c", "h", "cpp", "java", "kt", "rb", "sh", "json", "yaml", "yml", "toml", "html", "css":
            return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }
}

/// The folder's whole path under the bar (files-v0 §3.2): from `/`, every level a button that goes back to it. When it
/// does not fit, `/` and the levels nearest this folder stay and the ones between fold into `…`, a menu of them (as the
/// Mac's path control folds its middle) — so every level is still one tap away and the row never has to be scrolled.
struct PathRow: View {
    let path: String
    let session: FilesSession
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let levels = MacPath.levels(path)
        // The whole path first, then with one more level folded each time: the first that fits is drawn.
        ViewThatFits(in: .horizontal) {
            ForEach(0..<max(1, levels.count - 1), id: \.self) { folded in row(levels, folding: folded) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 8)
    }

    /// `/`, then `folded` levels as `…`, then the rest.
    private func row(_ levels: [(name: String, path: String)], folding folded: Int) -> some View {
        let shown = [levels[0]] + Array(levels.dropFirst(1 + folded))
        let hidden = Array(levels.dropFirst().prefix(folded))
        return HStack(spacing: look.isClassic ? 6 : 0) {
            level(levels[0], current: levels.count == 1)
            if !hidden.isEmpty {
                separator(afterRoot: true)
                Menu {
                    ForEach(hidden.reversed(), id: \.path) { l in Button(l.name, systemImage: "folder") { session.go(to: l.path) } }
                } label: { chip("…", current: false) }
                .accessibilityLabel("上层文件夹")
            }
            ForEach(Array(shown.dropFirst().enumerated()), id: \.element.path) { i, l in
                separator(afterRoot: i == 0 && hidden.isEmpty)
                level(l, current: l.path == levels.last?.path)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    /// Between two levels ` / `; after `/` itself only a space (`/ Users / me`). The classic look's chips need none.
    @ViewBuilder private func separator(afterRoot: Bool) -> some View {
        if !look.isClassic { Text(afterRoot ? " " : " / ").code(12.5).foregroundStyle(Theme.inkDim) }
    }

    private func level(_ l: (name: String, path: String), current: Bool) -> some View {
        Button { session.go(to: l.path) } label: { chip(l.name, current: current) }
            .buttonStyle(.plain)
            .accessibilityLabel(l.path)
    }

    @ViewBuilder private func chip(_ name: String, current: Bool) -> some View {
        if look.isClassic {
            Text(name).font(.system(size: 12.5, weight: current ? .semibold : .regular))
                .foregroundStyle(current ? Theme.signal : Theme.ink)
                .padding(.horizontal, 9).padding(.vertical, 3)
                .background(current ? Theme.signal.opacity(0.16) : Theme.raised, in: Capsule())
        } else {
            Text(name).code(12.5, weight: current ? .bold : .regular).foregroundStyle(current ? Theme.ink : Theme.secondaryInk)
        }
    }
}

/// While selecting: where they go; on the Files tab also share them and move them to the Mac's Trash (iOS Files' select
/// bar; files-v0 §12.3), the count then under the title.
struct SelectBar: View {
    let session: FilesSession
    let give: () -> Void
    var share: (() -> Void)?
    var trash: (() -> Void)?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 0) {
            HairRule()
            HStack(spacing: Theme.Space.m) {
                if let share, let trash {
                    let files = !session.picked.isEmpty && session.picked.allSatisfy { !$0.isFolder }
                    icon(PixelArt.share, "square.and.arrow.up", "Share", action: share).disabled(!files)
                    icon(PixelArt.trash, "trash", "Move to Trash", action: trash).disabled(session.picked.isEmpty)
                } else {
                    Text("\(session.picked.count) Selected").mono(13).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if session.checking { BrailleSpinner(color: .secondary) }
                Button(action: give) { ButtonWord(session.asksTerminal ? "Add to Reply…" : "Add to Reply (\(session.picked.count))") }
                    .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                    .disabled(session.picked.isEmpty || session.checking)
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, 10)
        }
        .background(Theme.base)
    }

    private func icon(_ rows: [String], _ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                if look.isClassic { Image(systemName: symbol).font(.system(size: 19)) } else { PixelSprite(rows: rows, pixel: 2, color: Theme.ink, strength: 1, shadow: false) }
            }
            .frame(minWidth: 36, minHeight: 32)
        }
        .tint(look.isClassic ? Theme.signal : Theme.ink)
        .accessibilityLabel(label)
    }
}
