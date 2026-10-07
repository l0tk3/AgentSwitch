import AgentSwitchKit
import PhotosUI
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): the live screen (drag to scroll — the wheel notches sent show at
/// its right; pinch for the text size; tap to put the keyboard away; a tap on a link — an address, a path of the Mac's —
/// opens it in the Mac's browser, a long press on one offers that, copying it and Safari), drawn in top down with a
/// scanline as it comes,
/// permission requests as cards over its top, the key bar and the reply box under it. A reply goes as typed (checked
/// for secret-looking text first) or, from the lock, through the Mac's sealer in the sealed box; `/` lists the agent's
/// commands; keys go by name. The menu renames or closes it (asked first; the record may go too). What needs you — a
/// permission, the exit, an error — glitches once; the questions are pixel boxes.
struct TerminalPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.interfaceLook) private var look
    @AppStorage("terminal.fontSize") private var fontSize: Double = 10
    @State private var page: TerminalPageModel
    @State private var reply = ""
    @State private var renaming = false
    @State private var choosingEffort = false
    @State private var newName = ""
    @State private var confirmClose = false
    /// The sealed box is open (the lock): the reply goes through the sealer.
    @State private var sealing = false
    /// The "+" menu, as the task composer's: camera, photos, files, a pasted image — sent as soon as they are chosen.
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var pickingFiles = false
    @State private var takingPhoto = false
    /// Placeholders to put into the reply box where the caret is (the field puts them there: it knows the caret).
    @State private var pendingTokens: [String] = []
    /// A direct reply that looks like it holds a secret, asked about before it goes.
    @State private var secretCheck: String?
    @FocusState private var replying: Bool
    /// Wheel notches sent in this drag (up positive), shown at the screen's right while it goes on.
    @State private var wheeled = 0
    @State private var wheelChipHides: Task<Void, Never>?
    /// A link held: its menu (terminal-v0 §1 iPhone 链接, 2026-10-03).
    @State private var linkMenu: LinkMenu?
    /// Said over the screen for a moment (`Link Copied`).
    @State private var said: String?
    @State private var saidHides: Task<Void, Never>?
    /// What the last turn changed, opened from the menu.
    @State private var lastTurnChanges = false

    /// The terminal as it was opened: where its agent worked until the list says otherwise.
    private let opened: TerminalInfo

    /// The session's record (the simple view) or the program's own screen: what this terminal was last shown as here.
    @State private var viewMode: TerminalViewMode
    @State private var record = SessionRecordModel()
    /// The transcript in full: every run of work open, thinking shown.
    @AppStorage("record.verbose") private var verbose = false
    /// The key bar under the record (the simple view keeps it away until it is wanted).
    @State private var showKeys = false

    init(terminal: TerminalInfo) {
        opened = terminal
        let size = UserDefaults.standard.object(forKey: "terminal.fontSize") as? Double ?? 10
        let mode = TerminalViewMode.saved(for: terminal.id)
        _viewMode = State(initialValue: mode)
        _page = State(initialValue: TerminalPageModel(terminal: terminal, fontSize: CGFloat(size), showsScreen: mode == .terminal))
    }

    private var simple: Bool { viewMode == .simple }
    /// The terminal as the list has it now (its folder, its session once the agent has said which).
    private var listed: TerminalInfo { model.terminals.terminals.first { $0.id == page.id } ?? opened }
    /// The program waits on something it drew itself: the keys come out on their own.
    private var prompting: Bool { page.status == .waiting && page.permissions.isEmpty }

    private func show(_ mode: TerminalViewMode) {
        guard mode != viewMode else { return }
        replying = false
        viewMode = mode
        mode.save(for: page.id)
        page.show(screen: mode == .terminal)
    }

    var body: some View { chrome(bars) }

    /// The record or the screen, under the page's bar and over its controls.
    private var bars: some View {
        Group {
            if simple {
                TerminalRecordView(page: page, record: record, terminal: listed, git: model.terminals.git[workdir]?.said, verbose: verbose) { show(.terminal) }
            } else {
                screen
            }
        }
        .background { (simple ? Theme.base : Color.black).ignoresSafeArea() }
        .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        // The whole height for the screen; back returns to the tabs.
        .toolbar(.hidden, for: .tabBar)
        // The screen keeps the Mac's (dark) terminal colours in light mode too: the bar over it reads light on dark. The
        // record follows the phone's appearance.
        .toolbarColorScheme(simple ? nil : .dark, for: .navigationBar)
        .toolbarBackground(simple ? Theme.base : Color.black, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                let status = page.permissions.isEmpty ? page.status : .waiting
                VStack(spacing: 1) {
                    // The folder the agent works in now and its git, as the Mac window's title (terminal-v0 §1,
                    // 2026-10-01, user: 手机上的标题栏没变); the terminal's name stays on its row in the list.
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(TerminalTree.lastComponent(workdir)).font(.headline).lineLimit(1)
                        if let git = model.terminals.git[workdir]?.said { Text(git).mono(12).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(page.name)
                    HStack(spacing: 5) {
                        TerminalStatusMark(status: status)
                        LookWord(page.permissions.isEmpty ? page.status.label : "Waiting").mono(11).foregroundStyle(.secondary)
                    }
                }
                .glitch(on: status, when: { $0 == .waiting || $0 == .exited })
            }
            // The other view of the same session (simple-view-v0 §1).
            ToolbarItem(placement: .topBarTrailing) {
                Button { show(simple ? .terminal : .simple) } label: {
                    // The terminal as the tab bar draws it (a framed prompt), not the characters `>_`, whose underscore runs long.
                    if look.isClassic { Image(systemName: simple ? "terminal" : "text.alignleft") }
                    else if simple { PixelSprite(rows: PixelArt.terminalWindow, pixel: 2, color: Theme.ink, strength: 1, shadow: false) }
                    else { Text("≡").mono(16, weight: .medium) }
                }
                .tint(look.isClassic ? Theme.signal : Theme.ink)
                .accessibilityLabel(simple ? "terminal view" : "simple view")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button(simple ? "Terminal View" : "Simple View", systemImage: simple ? "terminal" : "text.alignleft") { show(simple ? .terminal : .simple) }
                    if simple {
                        Button(verbose ? "Transcript: Normal" : "Transcript: Verbose", systemImage: "list.bullet.indent") { verbose.toggle() }
                        if record.hasSession, page.harness == "claude-code" || page.harness == "codex" {
                            Button("Changes", systemImage: "plusminus") { lastTurnChanges = true }
                        }
                    }
                    Divider()
                    Button("Rename", systemImage: "pencil") { newName = page.name; renaming = true }
                    Button("Close", systemImage: "xmark", role: .destructive) { if page.status == .exited && !canDeleteRecord { Task { await close() } } else { confirmClose = true } }
                } label: { if look.isClassic { Image(systemName: "ellipsis.circle") } else { Text("⋯").mono(17) } }
                .tint(look.isClassic ? Theme.signal : Theme.ink)
            }
        }
        .sheet(isPresented: $lastTurnChanges) {
            if let session = listed.agentSessionId { ChangesSheet(harness: listed.harness, session: session, work: nil) }
        }
        // The record of the terminal's session: read when the page opens in the simple view and when the agent says
        // which session it is; again whenever the Mac says it changed, and on a timer besides (OpenCode's sessions
        // share one database, and an older Mac says nothing).
        .task(id: "\(listed.harness)|\(listed.agentSessionId ?? "")|\(simple)") {
            guard simple else { return }
            record.follow(harness: listed.harness, session: listed.agentSessionId)
            await record.refresh(model.api)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(page.recordRev == nil ? (page.status == .working ? 3 : 10) : 20))
                guard !Task.isCancelled else { break }
                await record.refresh(model.api)
            }
        }
        .onChange(of: page.recordRev) { Task { await record.refresh(model.api) } }
        .onChange(of: page.status) { if simple { Task { await record.refresh(model.api) } } }
    }

    /// The program's own screen, with what floats over it.
    private var screen: some View {
        ZStack(alignment: .top) {
            TerminalScreen(controller: page.screen, onPinchEnded: { size in fontSize = Double(size) },
                           onWheel: { up, count in wheel(up: up, count: count) }, onTap: { point in tapped(point) },
                           onHold: { point in held(point) })
                .padding(.horizontal, 6)
                .background(page.ground)
                .screenRefresh(on: page.snapshots, ground: page.ground)
                .overlay(alignment: .trailing) { if wheeled != 0 { wheelChip } }
                .overlay(alignment: .bottom) { if let said { chip(said).padding(.bottom, 10) } }
                .overlay { if let place = page.away { TerminalAwayCover(page: page, place: place) } }
            if !page.drawn && page.away == nil {
                HStack(spacing: 6) {
                    BrailleSpinner(color: .secondary)
                    Text("Connecting").mono(12).foregroundStyle(.secondary)
                }
                .padding(.top, 60)
            }
            VStack(spacing: 10) {
                ForEach(page.permissions) { p in
                    if p.isQuestion { TerminalQuestionCard(page: page, permission: p) } else { TerminalPermissionCard(page: page, permission: p) }
                }
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.top, Theme.Space.s)
        }
    }

    /// The page's boxes, pickers and what it watches: the same in either view.
    private func chrome(_ content: some View) -> some View {
        content
        .alert("Rename", isPresented: $renaming) {
            TextField("名称（留空恢复自动命名）", text: $newName)
            Button("Save") { Task { await page.rename(newName) } }
            Button("Cancel", role: .cancel) {}
        }
        .pixelBox(isPresented: $confirmClose) {
            var actions: [PixelBox.Action] = []
            if canDeleteRecord { actions.append(.init(label: "Delete Record", role: .destructive) { Task { await close(deleteRecord: true) } }) }
            actions.append(.init(label: "Close", role: .primary) { Task { await close() } })
            return PixelBox(head: "Close", tone: .red,
                            message: "关闭「\(page.name)」？" + (canDeleteRecord ? "程序将结束并从列表移除。会话记录默认保留，之后可继续；删除记录后无法恢复。"
                                                                               : "程序将结束并从列表移除；会话记录保留，之后可继续。"),
                            actions: actions)
        }
        .pixelBox(item: $linkMenu) { menu in
            let link = menu.hit.link
            return PixelBox(head: link.text, cancel: nil,
                            actions: link.actions.map { action in .init(label: action.label(for: link)) { run(action, on: menu.hit) } },
                            anchor: menu.anchor, width: 264)
        }
        // Either way is an answer; a tap outside keeps the reply in the box.
        .pixelBox(item: $secretCheck) { text in
            PixelBox(head: "这段文字可能包含密码或令牌", tone: .amber, message: "加密发送时，Mac 会先把其中的凭据换成密文，再交给 agent。", cancel: nil,
                     actions: [.init(label: "Send as Typed") { Task { await send(text, sealed: false) } },
                               .init(label: "Sealed", role: .primary) { Task { await send(text, sealed: true) } }])
        }
        .onAppear {
            page.start(model.api, style: model.terminals.style)
            #if DEBUG
            switch UserDefaults.standard.string(forKey: "uiDemoScreen") {
            case "terminalsealed":
                reply = "my password is hunter2"
                // After the page has slid in, as a tap on the lock would: the box glitches open.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { sealing = true }
            case "terminalslash": reply = "/co"
            // What the last turn changed, as the menu's Changes would open it.
            case "simplechanges": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { lastTurnChanges = true }
            case "simpleeffort": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { choosingEffort = true }
            case "terminalkeyboard": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { replying = true }
            case "terminalclose": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { confirmClose = true }
            // A link held, as a long press on the address in the demo's screen would open its menu.
            case "terminallink": DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { holdFirstLink() }
            default: break
            }
            #endif
        }
        .onDisappear { page.stop() }
        // The title's git: the list (read from every tab) follows a `cd`; the folders' git is otherwise read only on the
        // terminals tab.
        .task {
            while !Task.isCancelled {
                await model.terminals.refreshGit(model.api)
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { addFiles(await PickedFiles.photos(items)) }
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                Task {
                    let (files, skipped) = await Task.detached(priority: .userInitiated) { PickedFiles.read(urls) }.value
                    if !skipped.isEmpty { page.error = "未发送：\(skipped.joined(separator: "、"))（超过 50 MB 或无法读取）" }
                    if !files.isEmpty { addFiles(files) }
                }
            case .failure(let failure): page.error = failure.localizedDescription
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { data in
                takingPhoto = false
                if let data { addFiles([UploadFile(name: "photo.jpg", type: "image/jpeg", data: data)]) }
            }
            .ignoresSafeArea()
        }
        // The reply box is for this phone: the size is its own.
        .onChange(of: replying) { if replying { page.userActed() } }
        // A placeholder deleted from the box takes its file out.
        .onChange(of: reply) { page.keepDraftFiles(in: reply) }
        // In the background the stream ends and the size goes back to the Mac; in front again, it is this phone's.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: page.suspend()
            case .active: page.resume()
            default: break
            }
        }
        .onChange(of: page.removed) { if page.removed { TerminalViewMode.forget(page.id); model.terminals.remove(page.id); dismiss() } }
        .onChange(of: fontSize) { page.screen.setFontSize(CGFloat(fontSize)) }
    }

    /// Where the agent is now, from the list as last read (it follows a `cd`).
    private var workdir: String { model.terminals.terminals.first { $0.id == page.id }?.workdir ?? opened.workdir }

    // MARK: the screen's taps (the cards over it are in TerminalCards.swift)

    /// A tap on the screen: on a link (or within a finger's slop of one), it opens in the Mac's browser — also when the
    /// program tracks the mouse, which would only get a click it has no use for. Else a click there when the program
    /// tracks the mouse (Claude Code's full screen: its options), the keyboard staying as it is; else the keyboard goes
    /// away.
    private func tapped(_ point: CGPoint) {
        page.userActed()
        if let hit = page.screen.link(at: point, workdir: workdir, tap: true) {
            page.screen.flash(hit)
            run(.openInBrowser, on: hit)
        } else if let cell = page.screen.clickCell(at: point) {
            Task { await page.click(col: cell.col, row: cell.row) }
        } else {
            replying = false
        }
    }

    /// A press held on a link: its menu by it (its whole address, then Open in Browser, Copy Link, Open in Safari).
    private func held(_ point: CGPoint) {
        guard let hit = page.screen.link(at: point, workdir: workdir) else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        page.screen.flash(hit)
        linkMenu = LinkMenu(hit: hit, anchor: page.screen.frame(of: hit))
    }

    /// One of a link's actions. A copy is said on the screen for a moment; a link that did not open in the Mac's
    /// browser says why in the page's line.
    private func run(_ action: LinkAction, on hit: ScreenLink) {
        Task {
            guard let words = await model.perform(action, on: hit.link, alternates: hit.alternates) else { return }
            if action == .copy { say(words) } else { page.error = words }
        }
    }

    private func say(_ words: String) {
        said = words
        saidHides?.cancel()
        saidHides = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1400))
            if !Task.isCancelled { said = nil }
        }
    }

    #if DEBUG
    /// The demo's long press: the first address on the screen.
    private func holdFirstLink() {
        let links = page.screen.links(workdir: workdir)
        guard let hit = links.first(where: { if case .web = $0.link { true } else { false } }) ?? links.first else { return }
        page.screen.flash(hit)
        linkMenu = LinkMenu(hit: hit, anchor: page.screen.frame(of: hit))
    }
    #endif

    private struct LinkMenu: Equatable {
        let hit: ScreenLink
        let anchor: CGRect
    }

    /// `Wheel ↑ 3`: what this drag has sent, gone 0.7 s after the last notch.
    private var wheelChip: some View {
        chip("Wheel \(wheeled > 0 ? "↑" : "↓") \(abs(wheeled))").padding(.trailing, 8).accessibilityHidden(true)
    }

    /// A few words over the screen for a moment: the wheel's notches, `Link Copied`.
    private func chip(_ words: String) -> some View {
        Text(words)
            .mono(11)
            .foregroundStyle(Color(white: 0.91))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.black)
            .overlay(Rectangle().strokeBorder(Color(white: 0.91), lineWidth: 1))
            .allowsHitTesting(false)
    }

    private func wheel(up: Bool, count: Int) {
        page.wheel(up: up, count: count)
        guard page.wheelWorks else { return }
        wheeled += up ? count : -count
        wheelChipHides?.cancel()
        wheelChipHides = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            wheeled = 0
        }
    }

    // MARK: keys and reply

    /// What an option needs first, within one screen: ⏎ (the one solid cap) and ⌫, the arrows, the numbers (terminal-v0 §1,
    /// 2026-10-01, user: 回车应该更靠前更显眼，有选项时需要用它选；要加一个退格，不然按上去的 1 2 3 删不掉).
    static let keys: [(TerminalKey, String)] = [(.enter, "⏎"), (.backspace, "⌫"), (.up, "↑"), (.down, "↓"), (.one, "1"), (.two, "2"),
                                                (.three, "3"), (.y, "y"), (.n, "n"), (.esc, "esc"), (.tab, "tab"), (.shiftTab, "⇧tab"),
                                                (.left, "←"), (.right, "→"), (.pageUp, "pgup"), (.pageDown, "pgdn"), (.ctrlC, "^C")]

    private var controls: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty { suggestionList }
            if commandsMissing {
                Text("命令补全需要更新 Mac 上的 AgentSwitch。").font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l).padding(.vertical, 8)
                    .background(Theme.raised)
            }
            HairRule()
            if let error = page.error {
                HStack {
                    Text(error).font(.footnote).foregroundStyle(Theme.failed).lineLimit(2)
                    Spacer()
                    Button { page.error = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 15) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Theme.Space.l).padding(.top, 6)
                .glitch(on: error, onAppear: true)
            }
            if simple { TasksRow(plan: record.plan) }
            if !simple || showKeys || prompting {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if replying {
                        Button { replying = false } label: { Image(systemName: "keyboard.chevron.compact.down").font(.system(size: 14)) }
                            .buttonStyle(KeyCapStyle())
                            .accessibilityLabel("hide keyboard")
                    }
                    ForEach(Self.keys, id: \.0) { key, label in
                        Button { Task { await page.press(key) } } label: { Text(label).mono(13, weight: key == .enter ? .semibold : .regular) }
                            .buttonStyle(KeyCapStyle(solid: key == .enter))
                            .disabled(page.status == .exited)
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, 8)
            }
            } else {
                Color.clear.frame(height: 8)
            }
            composer
            if let note = page.sealedNote {
                Text(note).mono(11).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l).padding(.bottom, 6)
            }
            if simple { sessionLine }
        }
        // Down to the screen's bottom edge, under the keyboard too: its rounded corners and the gap above it would
        // otherwise show the window's light ground.
        .background { (simple ? Theme.base : page.ground).ignoresSafeArea(edges: .bottom) }
        // One dark block with the screen whatever the phone's appearance (ui-v0 §7): the keys, the reply box, the
        // sealed box and its keyboard take the dark palette. Under the record they follow the phone.
        .modifier(DarkBlock(on: !simple))
    }

    /// Under the reply box in the simple view: how it asks, the model, how full its context is.
    private var sessionLine: some View {
        let mode = RecordDisplay.mode(record.mode) ?? RecordDisplay.mode(listed.mode) ?? listed.mode.capitalized
        return HStack(spacing: 6) {
            // Skipping every permission is said in the colour of a warning (2026-10-07, as on the Mac).
            Text(mode).lineLimit(1).foregroundStyle(mode == "Bypass" ? AnyShapeStyle(Theme.failed) : AnyShapeStyle(.tertiary))
            Text("·")
            modelMenu
            effortButton
            Spacer(minLength: 4)
            if let context = RecordDisplay.context(record.usage) { Text("Context \(context)").lineLimit(1) }
        }
        .mono(11).foregroundStyle(.tertiary)
        .padding(.horizontal, Theme.Space.l).padding(.bottom, 6)
    }

    /// The model it is on, as far as anything says: what the agent last reported, the model of its last answer, the one
    /// it was started with.
    private var currentModel: String? {
        RecordDisplay.model(now: page.modelNow ?? listed.modelNow, record: record.usage?.model, started: listed.model)
    }

    /// How hard it thinks now: the level just asked for here, the last turn's in the record, the one it was started at.
    private var currentEffort: String? {
        EffortDisplay.level(asked: page.effortAsked, record: record.usage?.effort, started: listed.effort)
    }

    /// Claude Code's level is chosen on a slider of its own beside the model (the others choose theirs on their screen).
    private var slidesEffort: Bool {
        page.harness == "claude-code" && page.status != .exited && !EffortDisplay.levels(model.terminals.list, harness: page.harness, current: currentModel).isEmpty
    }

    /// How hard it thinks, and a slider to change it (2026-10-07, user: 思考强度改成滑块调节): it takes a new level
    /// while it works too (the next request of the turn runs at it), not while it waits for an answer.
    @ViewBuilder private var effortButton: some View {
        if slidesEffort {
            let levels = EffortDisplay.levels(model.terminals.list, harness: page.harness, current: currentModel)
            let answering = page.status == .waiting || !page.permissions.isEmpty
            Text("·")
            Button { choosingEffort = true } label: {
                HStack(spacing: 3) {
                    Text(currentEffort.map(EffortDisplay.name) ?? EffortDisplay.word(page.harness)).lineLimit(1)
                    LookGlyph(glyph: "▾", symbol: "chevron.down", size: 10)
                }
                .mono(12, weight: .medium).foregroundStyle(.secondary)
                .padding(.vertical, 8).padding(.trailing, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -8)
            .accessibilityLabel(EffortDisplay.word(page.harness).lowercased())
            .popover(isPresented: $choosingEffort, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                EffortPicker(levels: levels, level: currentEffort, enabled: !answering,
                             note: answering ? "它正在等待回答，回答后再调整。" : "会记成这个模型的默认；Max 只用于这一次。",
                             choose: { level in Task { await page.setEffort(level) } }) {
                    LookWord(EffortDisplay.word(page.harness)).mono(13, weight: .semibold).foregroundStyle(Theme.ink)
                }
                .frame(width: 290)
                .padding(16)
                .presentationCompactAdaptation(.popover)
                .followsLook()
            }
        }
    }

    /// The model and how hard it thinks, and a menu to change either (docs/simple-view-v0.md §5.4, terminal-v0 §1
    /// 思考强度). Claude Code takes `/model <id>` and `/effort <level>` as commands: the Mac types them. The other agents
    /// choose in a picker of their own: the menu opens it in the terminal view.
    private var modelMenu: some View {
        let options = model.terminals.list?.models[page.harness] ?? []
        let resting = page.status == .idle && page.permissions.isEmpty
        let word = EffortDisplay.word(page.harness)
        return Menu {
            if page.status == .exited {
                Button("终端已结束") {}.disabled(true)
            } else if page.harness == "claude-code", !options.isEmpty {
                if resting {
                    Section("Model · Claude Code 会把它记成新会话的默认模型") {
                        ForEach(options.filter { !$0.older }) { option in modelButton(option) }
                        let older = options.filter(\.older)
                        if !older.isEmpty { Menu("Older", systemImage: "clock") { ForEach(older) { option in modelButton(option) } } }
                    }
                } else {
                    Section("Model") { Button("它正在工作或等待回答，结束后再切换") {}.disabled(true) }
                }
            } else {
                // Its own picker, on its own screen (Codex chooses the reasoning with the model there).
                Button(page.harness == "codex" ? "Model and Reasoning in Terminal…" : "Choose in Terminal…", systemImage: "terminal") {
                    show(.terminal)
                    Task { _ = await page.send(RecordDisplay.modelPicker(page.harness), sealed: false) }
                }
                .disabled(!resting)
                if let picker = EffortDisplay.picker(page.harness) {
                    Button("\(word) in Terminal…", systemImage: "terminal") {
                        show(.terminal)
                        Task { _ = await page.send(picker, sealed: false) }
                    }
                    .disabled(!resting)
                }
            }
        } label: {
            HStack(spacing: 3) {
                if page.changingModel { BrailleSpinner(color: .secondary) }
                Text([currentModel.map(ModelName.display) ?? "Model", slidesEffort ? nil : currentEffort.map(EffortDisplay.name)].compactMap { $0 }.joined(separator: " · ")).lineLimit(1)
                LookGlyph(glyph: "▾", symbol: "chevron.down", size: 10)
            }
            .mono(12, weight: .medium)
            .foregroundStyle(.secondary)
            // A line of small words is hard to hit: the menu takes the room around its own.
            .padding(.vertical, 8).padding(.trailing, 10)
            .contentShape(Rectangle())
        }
        .padding(.vertical, -8)
        .accessibilityLabel("model and \(word.lowercased())")
    }

    private func modelButton(_ option: TerminalModelOption) -> some View {
        Button {
            Task {
                guard await page.setModel(option.id) != nil else { return }
                // The list says which model it is on once the agent has said (the stream does at once, where it can).
                try? await Task.sleep(for: .seconds(1))
                await model.terminals.refreshList(model.api)
            }
        } label: {
            if RecordDisplay.isCurrent(option, model: currentModel) { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
        }
    }

    /// While it works and nothing is typed, the send key stops it (esc).
    private var stops: Bool {
        simple && page.status == .working && page.permissions.isEmpty && reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !page.sending
    }

    /// One box for both ways of replying, so switching keeps the text and the keyboard as they were (one text field,
    /// never swapped): typed as it is, with the lock beside it; or, from the lock, the desktop's sealed composer
    /// (ui-v0 §7.4) — a framed box with a signal head bar naming the terminal and a hard dithered shadow, glitching as it
    /// opens; the reply then goes through the sealer and the box closes.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !page.draftFiles.isEmpty { draftStrip }
            if sealing {
                // The head: black on the signal colour; in the classic look the lock in the accent and plain words.
                HStack(spacing: 8) {
                    PixelSprite(rows: PixelArt.lock, pixel: 2, color: look.isClassic ? Theme.signal : .black, strength: 1, shadow: false, picture: .lockSmall, onDark: false)
                    Text("Sealed → \(page.name)").mono(12, weight: look.isClassic ? .semibold : .regular).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { toggleSealing() } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 15).frame(width: 28, height: 26) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("cancel")
                }
                .foregroundStyle(look.isClassic ? Theme.ink : .black)
                .padding(.leading, look.isClassic ? 12 : 8)
                .frame(height: look.isClassic ? 34 : 26)
                .background(look.isClassic ? Color.clear : Theme.signal)
            }
            HStack(alignment: .bottom, spacing: Theme.Space.s) {
                if !sealing {
                    // Pictures and files for the agent: their paths go into its prompt (Claude Code: [Image #n]); write on
                    // and send. The same words as the task composer's "+".
                    Menu {
                        Button("Camera", systemImage: "camera") { replying = false; takingPhoto = true }
                            .disabled(!CameraPicker.isAvailable)
                        Button("Photos", systemImage: "photo.on.rectangle") { replying = false; pickingPhotos = true }
                        Button("Files", systemImage: "folder") { replying = false; pickingFiles = true }
                        Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImages() }
                        // The keys are out of the way under the record until they are wanted.
                        if simple { Button(showKeys ? "Hide Keys" : "Keys", systemImage: "keyboard") { showKeys.toggle() } }
                    } label: {
                        if look.isClassic {
                            Image(systemName: "plus.circle").font(.system(size: 26, weight: .light)).foregroundStyle(Theme.ink.opacity(0.72))
                                .frame(width: 34, height: 38)
                        } else {
                            Text("+").font(.system(size: 20, weight: .regular, design: .monospaced)).foregroundStyle(Theme.ink.opacity(0.72))
                                .frame(width: 38, height: 38)
                                .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                        }
                    }
                    .tint(Theme.ink)
                    .disabled(page.sending || page.status == .exited)
                    .accessibilityLabel("attach")
                    Button { toggleSealing() } label: { PixelSprite(rows: PixelArt.lock, pixel: 3, color: Theme.signal, strength: 1) }
                        .buttonStyle(SquareIconButtonStyle(active: false))
                        .accessibilityLabel("sealed reply")
                }
                ReplyField(prompt: sealing ? "Message" : "回复", text: $reply, pending: $pendingTokens)
                    .font(sealing ? .system(size: 14, design: .monospaced) : .body)
                    .lineLimit(sealing ? 2...6 : 1...5)
                    .focused($replying)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, look.isClassic && !sealing ? 14 : 12)
                    .padding(.vertical, 9)
                    // A framed line; a round field on its own ground in the classic look.
                    .grounded(look.isClassic && !sealing ? Theme.raised : Color.clear, radius: Theme.Radius.bubble)
                    .framed(sealing || look.isClassic ? Color.clear : Theme.line, radius: Theme.Radius.bubble)
                if !sealing {
                    Button { Task { if stops { await page.press(.esc) } else { await sendDirect() } } } label: { sendLabel }
                        .buttonStyle(SquareIconButtonStyle(active: canSend || page.sending || stops))
                        .disabled(!canSend && !stops)
                        .accessibilityLabel(stops ? "stop" : "send")
                }
            }
            .padding(.horizontal, sealing ? 0 : Theme.Space.l)
            .padding(.top, sealing ? 4 : 0)
            if sealing {
                HStack(spacing: Theme.Space.s) {
                    Text("凭据在 Mac 上换成密文后再交给 agent").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { Task { await send(reply, sealed: true) } } label: {
                        if page.sending { BrailleSpinner(color: Theme.base) } else { ButtonWord("Send") }
                    }
                    .buttonStyle(SquareButtonStyle(prominent: true))
                    .fixedSize()
                    .disabled(!canSend)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
        }
        // The sealed box: an ink frame over a dithered shadow; a round card in the classic look.
        .grounded(sealing ? (look.isClassic ? Theme.panel : Theme.base) : Color.clear, radius: 14)
        .framed(sealing ? (look.isClassic ? Theme.line : Theme.ink) : Color.clear, radius: 14)
        .background(DitherShadow().offset(x: 6, y: 6).opacity(sealing ? 1 : 0))
        .glitch(on: sealing)
        .padding(.leading, sealing ? Theme.Space.l : 0)
        .padding(.trailing, sealing ? Theme.Space.l + 6 : 0)
        .padding(.bottom, sealing ? Theme.Space.m + 6 : Theme.Space.s)
    }

    private func pasteImages() {
        let images = PickedFiles.pastedImages()
        guard !images.isEmpty else { page.error = "剪贴板中无图片"; return }
        addFiles(images)
    }

    /// Picked files: kept for the reply, their placeholders put where the caret is; nothing is sent yet.
    private func addFiles(_ files: [UploadFile]) {
        let tokens = page.addDraftFiles(files)
        guard !tokens.isEmpty else { return }
        pendingTokens += tokens
        replying = true
    }

    /// The reply's files above the box: the picture (or the file's name), its number as the placeholder says, × to take
    /// it out (its placeholder goes too).
    private var draftStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(page.draftFiles) { d in
                    ZStack(alignment: .topTrailing) {
                        VStack(alignment: .leading, spacing: 3) {
                            Group {
                                if let thumbnail = d.thumbnail {
                                    Image(uiImage: thumbnail).resizable().scaledToFill()
                                } else {
                                    Image(systemName: "doc").font(.system(size: 18)).foregroundStyle(Theme.ink.opacity(0.7))
                                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                                }
                            }
                            .frame(width: 48, height: 48)
                            .clipped()
                            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                            Text(d.isImage ? "#\(d.number)" : "#\(d.number) \(d.name)").mono(10).foregroundStyle(.secondary).lineLimit(1).frame(maxWidth: 96, alignment: .leading)
                        }
                        Button {
                            reply = TerminalDraft.remove(d.token, from: reply)
                            page.removeDraftFile(d)
                        } label: {
                            LookGlyph(glyph: "×", symbol: "xmark", size: 12).foregroundStyle(Theme.base).frame(width: 18, height: 18)
                                .grounded(Theme.ink, radius: 9)
                        }
                        .buttonStyle(.plain)
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("remove \(d.token)")
                    }
                }
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
    }

    /// Between the two ways; the keyboard stays as it was.
    private func toggleSealing() {
        withAnimation(.snappy(duration: 0.18)) { sealing.toggle() }
    }

    @ViewBuilder
    private var sendLabel: some View {
        if page.sending {
            BrailleSpinner(color: Theme.base)
        } else if stops {
            if look.isClassic { Image(systemName: "stop.fill").font(.system(size: 13, weight: .bold)) } else { Text("■").font(.system(size: 15, weight: .bold, design: .monospaced)) }
        } else if look.isClassic {
            Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
        } else {
            Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced))
        }
    }

    // MARK: slash commands

    private var suggestions: [SlashCommand] { sealing ? [] : SlashCommand.matching(reply, in: page.commands) }

    /// `/` typed on a Mac that cannot list the commands: say so instead of showing nothing.
    private var commandsMissing: Bool {
        !sealing && page.commandsUnavailable && reply.hasPrefix("/") && !reply.contains(where: \.isWhitespace)
    }

    /// What `/` may be: tap one to put it in the box (a space after it, ready for arguments).
    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Theme.line.frame(height: 1)
            ForEach(suggestions) { c in
                Button { reply = "/\(c.name) " } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("/\(c.name)").mono(13, weight: .medium).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                        Text(c.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                        if c.source != "builtin" { Text(c.source).mono(10).foregroundStyle(.tertiary) }
                    }
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.raised)
    }

    private var canSend: Bool {
        !page.sending && page.status != .exited && !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Typed straight in, unless it looks like a secret: then asked which way.
    private func sendDirect() async {
        guard canSend else { return }
        if SecretHint.looksSecret(reply) { secretCheck = reply; return }
        await send(reply, sealed: false)
    }

    private func send(_ text: String, sealed: Bool) async {
        if await page.send(text, sealed: sealed) {
            if reply == text { reply = "" }
            if sealed { toggleSealing() }
        }
    }

    /// It wrote a session of its own that the Mac can delete (one continued in place stays: the Mac refuses).
    /// Closing deletes the record with it only for Claude Code (the record it reported starting; the service deletes no
    /// other agent's on close), as the web page offers it; other sessions are deleted from the list.
    private var canDeleteRecord: Bool { page.ownsRecord && page.harness == "claude-code" }

    private func close(deleteRecord: Bool = false) async {
        if await page.close(deleteRecord: deleteRecord) {
            model.terminals.remove(page.id)
            dismiss()
        }
    }
}

/// The reply box: a multi-line field that puts placeholders (`[Image #1]`) where the caret is — on iOS 18 and later,
/// where the field says where its caret is; at the end before that.
private struct ReplyField: View {
    let prompt: String
    @Binding var text: String
    @Binding var pending: [String]

    var body: some View {
        if #available(iOS 18.0, *) {
            CaretField(prompt: prompt, text: $text, pending: $pending)
        } else {
            TextField(prompt, text: $text, axis: .vertical)
                .onChange(of: pending) {
                    guard !pending.isEmpty else { return }
                    text = TerminalDraft.insert(pending, into: text, at: nil).text
                    pending = []
                }
        }
    }
}

@available(iOS 18.0, *)
private struct CaretField: View {
    let prompt: String
    @Binding var text: String
    @Binding var pending: [String]
    @State private var selection: TextSelection?

    var body: some View {
        TextField(prompt, text: $text, selection: $selection, axis: .vertical)
            .onChange(of: pending) {
                guard !pending.isEmpty else { return }
                var at: Int?
                if case .selection(let range)? = selection?.indices, range.lowerBound <= text.endIndex {
                    at = text.distance(from: text.startIndex, to: range.lowerBound)
                }
                let result = TerminalDraft.insert(pending, into: text, at: at)
                text = result.text
                pending = []
                let caret = text.index(text.startIndex, offsetBy: min(result.caret, text.count))
                selection = TextSelection(insertionPoint: caret)
            }
    }
}

/// The dark palette for what sits with a terminal's screen; nothing under the record, which follows the phone.
private struct DarkBlock: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.environment(\.colorScheme, .dark) } else { content }
    }
}
