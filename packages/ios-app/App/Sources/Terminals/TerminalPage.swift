import AgentSwitchKit
import PhotosUI
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): the live screen (drag to scroll — the wheel notches sent show at
/// its right; pinch for the text size; tap to put the keyboard away), drawn in top down with a scanline as it comes,
/// permission requests as cards over its top, the key bar and the reply box under it. A reply goes as typed (checked
/// for secret-looking text first) or, from the lock, through the Mac's sealer in the sealed box; `/` lists the agent's
/// commands; keys go by name. The menu renames or closes it (asked first; the record may go too). What needs you — a
/// permission, the exit, an error — glitches once; the questions are pixel boxes.
struct TerminalPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("terminal.fontSize") private var fontSize: Double = 10
    @State private var page: TerminalPageModel
    @State private var reply = ""
    @State private var renaming = false
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

    /// The terminal as it was opened: where its agent worked until the list says otherwise.
    private let opened: TerminalInfo

    init(terminal: TerminalInfo) {
        opened = terminal
        let size = UserDefaults.standard.object(forKey: "terminal.fontSize") as? Double ?? 10
        _page = State(initialValue: TerminalPageModel(terminal: terminal, fontSize: CGFloat(size)))
    }

    var body: some View {
        ZStack(alignment: .top) {
            TerminalScreen(controller: page.screen, onPinchEnded: { size in fontSize = Double(size) },
                           onWheel: { up, count in wheel(up: up, count: count) }, onTap: { point in tapped(point) })
                .padding(.horizontal, 6)
                .background(page.ground)
                .screenRefresh(on: page.snapshots, ground: page.ground)
                .overlay(alignment: .trailing) { if wheeled != 0 { wheelChip } }
                .overlay { if let place = page.away { awayCover(place) } }
            if !page.drawn && page.away == nil {
                HStack(spacing: 6) {
                    BrailleSpinner(color: .secondary)
                    Text("Connecting").mono(12).foregroundStyle(.secondary)
                }
                .padding(.top, 60)
            }
            VStack(spacing: 10) {
                ForEach(page.permissions) { p in
                    if p.isQuestion { questionCard(p) } else { permissionCard(p) }
                }
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.top, Theme.Space.s)
        }
        .background { Color.black.ignoresSafeArea() }
        .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        // The whole height for the screen; back returns to the tabs.
        .toolbar(.hidden, for: .tabBar)
        // The screen keeps the Mac's (dark) terminal colours in light mode too: the bar over it reads light on dark.
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(Color.black, for: .navigationBar)
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
                        Text(page.permissions.isEmpty ? page.status.label : "Waiting").mono(11).foregroundStyle(.secondary)
                    }
                }
                .glitch(on: status, when: { $0 == .waiting || $0 == .exited })
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Rename", systemImage: "pencil") { newName = page.name; renaming = true }
                    Button("Close", systemImage: "xmark", role: .destructive) { if page.status == .exited && !canDeleteRecord { Task { await close() } } else { confirmClose = true } }
                } label: { Text("⋯").mono(17) }
                .tint(Theme.ink)
            }
        }
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
            case "terminalkeyboard": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { replying = true }
            case "terminalclose": DispatchQueue.main.asyncAfter(deadline: .now() + 2) { confirmClose = true }
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
        .onChange(of: page.removed) { if page.removed { model.terminals.remove(page.id); dismiss() } }
        .onChange(of: fontSize) { page.screen.setFontSize(CGFloat(fontSize)) }
    }

    /// Where the agent is now, from the list as last read (it follows a `cd`).
    private var workdir: String { model.terminals.terminals.first { $0.id == page.id }?.workdir ?? opened.workdir }

    // MARK: permission requests

    private func permissionCard(_ p: TerminalPermission) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting)
                Text("Permission · \(p.tool)").mono(12, weight: .semibold).foregroundStyle(Theme.waiting)
            }
            Text(p.detail).font(.callout.monospaced()).foregroundStyle(Theme.ink).lineLimit(6).textSelection(.enabled)
            HStack(spacing: Theme.Space.m) {
                Button("[ Deny ]") { Task { await page.decide(p, allow: false) } }.buttonStyle(SquareButtonStyle(destructive: true))
                Button("[ Allow ]") { Task { await page.decide(p, allow: true) } }.buttonStyle(SquareButtonStyle(prominent: true))
            }
        }
        .padding(14)
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        // The floating layer's hard, dithered shadow (§7.3), not a blur.
        .background(DitherShadow().offset(x: 6, y: 6))
        .glitch(on: p.id, onAppear: true)
    }

    /// A question the agent asks (Claude Code's AskUserQuestion; docs/terminal-v0.md §3 "选择题", phone.html?ask;
    /// 2026-10-01, user: 能不能hook的更精细，直接用这个框来选agent给的选项): no allow / deny — each question with its options
    /// to tap, one (`< >` / `<x>`) or several (`[ ]` / `[x]`), and Other to write in; `[ Submit ]` once every question
    /// has an answer. The agent gets them as its own dialog would give them, and that dialog closes.
    private func questionCard(_ p: TerminalPermission) -> some View {
        let picks = page.picks(p)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: .black)
                Text("Question").mono(12, weight: .semibold)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color.black)
            .padding(.horizontal, 8)
            .frame(minHeight: 24)
            .background(Theme.waiting)
            // Four questions of four options each may not fit over the screen: then they scroll.
            ViewThatFits(in: .vertical) {
                questions(p, picks)
                ScrollView { questions(p, picks) }.frame(maxHeight: 420)
            }
            HStack {
                Spacer()
                Button("[ Submit ]") { Task { await page.answer(p) } }
                    .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                    .disabled(!picks.isComplete || page.answering.contains(p.id))
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 12)
        }
        .background(Theme.base)
        .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
        .background(DitherShadow().offset(x: 6, y: 6))
        .glitch(on: p.id, onAppear: true)
    }

    private func questions(_ p: TerminalPermission, _ picks: QuestionPicks) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(p.questions.enumerated()), id: \.offset) { i, q in
                VStack(alignment: .leading, spacing: 0) {
                    if !q.header.isEmpty { Text("// \(q.header)").mono(11).foregroundStyle(.secondary) }
                    Text(q.question).font(.callout).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2).padding(.bottom, 4)
                    ForEach(q.options, id: \.label) { o in
                        let on = picks.isPicked(o.label, in: i)
                        Button { page.updatePicks(p) { $0.pick(o.label, in: i) } } label: {
                            choice(q, on: on) {
                                Text(o.label).mono(13)
                                if !o.description.isEmpty { Text(o.description).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    // Writing in Other picks it: in place of the option picked (one), or beside them (several).
                    choice(q, on: picks.hasOther(in: i)) {
                        TextField(q.options.isEmpty ? "Answer" : "Other",
                                  text: Binding(get: { page.picks(p).other(in: i) }, set: { text in page.updatePicks(p) { $0.write(text, in: i) } }))
                            .mono(13)
                            .foregroundStyle(Theme.ink)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        DottedRule()
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
    }

    /// One option's row: its mark — `< >` / `<x>` for one, `[ ]` / `[x]` for several (ui-v0 §7.2.6) — and what it says,
    /// in ink once picked.
    private func choice<Content: View>(_ q: TerminalQuestion, on: Bool, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(q.multiSelect ? (on ? "[x]" : "[ ]") : (on ? "<x>" : "< >")).mono(13)
            VStack(alignment: .leading, spacing: 2) { content() }
            Spacer(minLength: 0)
        }
        .foregroundStyle(on ? Theme.ink : Color.secondary)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    /// A tap on the screen: a click there when the program tracks the mouse (Claude Code's full screen: its options,
    /// its links), the keyboard staying as it is; else the keyboard goes away.
    private func tapped(_ point: CGPoint) {
        page.userActed()
        if let cell = page.screen.clickCell(at: point) {
            Task { await page.click(col: cell.col, row: cell.row) }
        } else {
            replying = false
        }
    }

    // MARK: in use elsewhere

    /// The terminal is in use on another screen (terminal-v0 §1 "不在用的一端显示占位", phone.html?away): the frame as it
    /// was behind a 50 % dither, a box saying where, glitching in; a tap anywhere takes the size back here.
    private func awayCover(_ place: String) -> some View {
        let (head, line) = Self.awayCopy[place] ?? ("On Web", "这个终端正在浏览器中使用。")
        return ZStack {
            page.ground.opacity(0.45)
            CheckerTile(color: page.screen.view.nativeBackgroundColor)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.base)
                    Text(head).mono(12, weight: .semibold)
                }
                .foregroundStyle(Theme.base)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                .background(Theme.ink)
                Text(line).font(.callout).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12).padding(.top, 12)
                HStack {
                    Spacer()
                    Button("[ Take Over ]") { page.claim() }.buttonStyle(SquareButtonStyle(prominent: true))
                }
                .padding(12)
            }
            .background(Theme.base)
            .overlay(Rectangle().strokeBorder(Theme.ink, lineWidth: 1))
            .background(DitherShadow().offset(x: 6, y: 6))
            .padding(.horizontal, 28)
            .glitch(on: place, onAppear: true)
        }
        .contentShape(Rectangle())
        .onTapGesture { page.claim() }
    }

    private static let awayCopy: [String: (String, String)] = [
        "mac": ("On Mac", "这个终端正在 Mac 上使用。"),
        "iphone": ("On iPhone", "这个终端正在另一台 iPhone 上使用。"),
        "web": ("On Web", "这个终端正在浏览器中使用。"),
    ]

    /// `Wheel ↑ 3`: what this drag has sent, gone 0.7 s after the last notch.
    private var wheelChip: some View {
        Text("Wheel \(wheeled > 0 ? "↑" : "↓") \(abs(wheeled))")
            .mono(11)
            .foregroundStyle(Color(white: 0.91))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.black)
            .overlay(Rectangle().strokeBorder(Color(white: 0.91), lineWidth: 1))
            .padding(.trailing, 8)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
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
            DottedRule()
            if let error = page.error {
                HStack {
                    Text(error).font(.footnote).foregroundStyle(Theme.failed).lineLimit(2)
                    Spacer()
                    Button { page.error = nil } label: { Text("×").mono(15) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Theme.Space.l).padding(.top, 6)
                .glitch(on: error, onAppear: true)
            }
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
            composer
            if let note = page.sealedNote {
                Text(note).mono(11).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l).padding(.bottom, 6)
            }
        }
        // Down to the screen's bottom edge, under the keyboard too: its rounded corners and the gap above it would
        // otherwise show the window's light ground.
        .background { page.ground.ignoresSafeArea(edges: .bottom) }
        // One dark block with the screen whatever the phone's appearance (ui-v0 §7): the keys, the reply box, the
        // sealed box and its keyboard take the dark palette.
        .environment(\.colorScheme, .dark)
    }

    /// One box for both ways of replying, so switching keeps the text and the keyboard as they were (one text field,
    /// never swapped): typed as it is, with the lock beside it; or, from the lock, the desktop's sealed composer
    /// (ui-v0 §7.4) — a framed box with a signal head bar naming the terminal and a hard dithered shadow, glitching as it
    /// opens; the reply then goes through the sealer and the box closes.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !page.draftFiles.isEmpty { draftStrip }
            if sealing {
                HStack(spacing: 8) {
                    PixelSprite(rows: PixelArt.lock, pixel: 2, color: .black)
                    Text("Sealed → \(page.name)").mono(12).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { toggleSealing() } label: { Text("×").mono(15).frame(width: 28, height: 26) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("cancel")
                }
                .foregroundStyle(.black)
                .padding(.leading, 8)
                .frame(height: 26)
                .background(Theme.signal)
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
                    } label: {
                        Text("+").font(.system(size: 20, weight: .regular, design: .monospaced)).foregroundStyle(Theme.ink.opacity(0.72))
                            .frame(width: 38, height: 38)
                            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                    }
                    .tint(Theme.ink)
                    .disabled(page.sending || page.status == .exited)
                    .accessibilityLabel("attach")
                    Button { toggleSealing() } label: { PixelSprite(rows: PixelArt.lock, pixel: 3, color: Theme.signal) }
                        .buttonStyle(SquareIconButtonStyle(active: false))
                        .accessibilityLabel("sealed reply")
                }
                ReplyField(prompt: sealing ? "Message" : "回复", text: $reply, pending: $pendingTokens)
                    .font(sealing ? .system(size: 14, design: .monospaced) : .body)
                    .lineLimit(sealing ? 2...6 : 1...5)
                    .focused($replying)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .overlay(Rectangle().strokeBorder(sealing ? Color.clear : Theme.line, lineWidth: 1))
                if !sealing {
                    Button { Task { await sendDirect() } } label: { sendLabel }
                        .buttonStyle(SquareIconButtonStyle(active: canSend || page.sending))
                        .disabled(!canSend)
                        .accessibilityLabel("send")
                }
            }
            .padding(.horizontal, sealing ? 0 : Theme.Space.l)
            .padding(.top, sealing ? 4 : 0)
            if sealing {
                HStack(spacing: Theme.Space.s) {
                    Text("凭据在 Mac 上换成密文后再交给 agent").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { Task { await send(reply, sealed: true) } } label: {
                        if page.sending { BrailleSpinner(color: Theme.base) } else { Text("[ Send ]") }
                    }
                    .buttonStyle(SquareButtonStyle(prominent: true))
                    .fixedSize()
                    .disabled(!canSend)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
        }
        .background(sealing ? Theme.base : Color.clear)
        .overlay(Rectangle().strokeBorder(sealing ? Theme.ink : Color.clear, lineWidth: 1))
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
                            Text("×").mono(12).foregroundStyle(Theme.base).frame(width: 18, height: 18).background(Theme.ink)
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
        if page.sending { BrailleSpinner(color: Theme.base) } else { Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced)) }
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
    private var canDeleteRecord: Bool { page.ownsRecord && TerminalsTab.deletable.contains(page.harness) }

    private func close(deleteRecord: Bool = false) async {
        if await page.close(deleteRecord: deleteRecord) {
            model.terminals.remove(page.id)
            dismiss()
        }
    }
}

/// A key on the bar: a small square cap with a 3 pt base; pressed, it sinks 2 pt onto a 1 pt base (the demo page's
/// key caps).
private struct KeyCapStyle: ButtonStyle {
    /// The one key that stands out (⏎): ink ground, the base colour's letters, a wider cap.
    var solid = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .foregroundStyle(solid ? Theme.base : Theme.ink)
            .frame(minWidth: solid ? 46 : 34)
            .padding(.horizontal, 6)
            .padding(.top, 6)
            .padding(.bottom, pressed ? 6 : 8)
            .background(solid ? (pressed ? Theme.secondaryInk : Theme.ink) : (pressed ? Theme.line : Theme.raised))
            .overlay(Rectangle().strokeBorder(solid ? Theme.ink : Theme.line, lineWidth: 1))
            .overlay(alignment: .bottom) { (solid ? Theme.secondaryInk : Theme.inkDim).frame(height: pressed ? 1 : 3) }
            .offset(y: pressed ? 2 : 0)
            .padding(.bottom, pressed ? 2 : 0)
    }
}

/// A 1 pt checker in `color`, tiled from one small image (a Canvas over the whole screen would draw a cell at a time).
private struct CheckerTile: View {
    let color: UIColor

    var body: some View {
        Image(uiImage: Self.tile(color)).resizable(resizingMode: .tile).allowsHitTesting(false).accessibilityHidden(true)
    }

    static func tile(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
            context.fill(CGRect(x: 1, y: 1, width: 1, height: 1))
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
