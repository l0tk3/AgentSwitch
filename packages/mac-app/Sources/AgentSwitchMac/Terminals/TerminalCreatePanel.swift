import AgentSwitchMacCore
import AppKit
import SwiftUI

// The new-terminal panel (docs/terminal-v0.md §1; demo `terminal.html`): the agent, its model, the folder, how it asks
// before acting; `[ Start ↩ ]`. It fills the pane in focus — among several panes without the wordmark, set closer.
// And the page's question box (closing a running terminal, deleting a session, a session open elsewhere, a session
// whose folder is gone): a sentence, maybe a box to tick or a folder to pick, and the action as a word.

struct TerminalCreatePanel: View {
    let model: TerminalsModel
    /// In a pane among several: no wordmark, closer set.
    let compact: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !compact { Wordmark().padding(.bottom, 20) }
                PanelLabel("New Terminal").padding(.bottom, 8)
                agents
                PanelLabel("Model").padding(.top, 16).padding(.bottom, 8)
                modelMenu
                // How hard it thinks, under the agent's own word and with the levels the model picked takes; nothing
                // where there is nothing to choose (a model with no levels, OpenCode before a model is picked).
                if !model.effortLevels.isEmpty { effort.padding(.top, 16) }
                PanelLabel("Folder").padding(.top, 16).padding(.bottom, 8)
                folder
                PanelLabel("Permissions").padding(.top, 16).padding(.bottom, 8)
                modes
                foot.padding(.top, 24)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(compact ? EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16) : EdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24))
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center) { length, _ in max(length, 0) }
        }
        .scrollBounceBehavior(.basedOnSize)
        // Over a pane of the simple view's look, the panel takes it too.
        .background(model.focusedLight ? Look.ground : Color(nsColor: model.ground))
    }

    // MARK: the agent

    /// The four agents side by side; in a narrow pane two rows of two.
    private var agents: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { ForEach(TerminalListText.agents, id: \.id) { tile($0.id, $0.name).frame(minWidth: 104) } }
            VStack(spacing: 10) {
                ForEach([0, 2], id: \.self) { first in
                    HStack(spacing: 10) {
                        ForEach(TerminalListText.agents[first..<min(first + 2, TerminalListText.agents.count)], id: \.id) { tile($0.id, $0.name) }
                    }
                }
            }
        }
    }

    /// An agent's tile, whether or not the agent is installed.
    private static let tileHeight: CGFloat = 68

    private func tile(_ id: String, _ name: String) -> some View {
        let installed = model.agents.contains(id)
        let on = model.pickedAgent == id
        return Button { model.pickedAgent = id } label: {
            // Every tile is one size: `Not Installed` goes under the name within it (a line more made that tile taller
            // than the rest; user: notinstalled框太大了 排版崩了 应该和其他的一样大).
            VStack(alignment: .leading, spacing: installed ? 10 : 6) {
                PixelSprite(rows: PixelArt.agents[id] ?? PixelArt.agents["pi"]!, pixel: 3, color: Look.ink, strength: on ? 1 : 0.75, shadow: !look.isClassic)
                    .frame(height: 16, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).font(look.isClassic ? .system(size: 13, weight: on ? .semibold : .regular) : .system(size: 12.5, design: .monospaced)).lineLimit(1)
                    if !installed {
                        Text("Not Installed").font(.system(size: 10.5, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
            }
            .foregroundStyle(installed ? Look.ink : Look.faint)
            .padding(EdgeInsets(top: 10, leading: 10, bottom: 8, trailing: 10))
            .frame(maxWidth: .infinity, minHeight: Self.tileHeight, maxHeight: Self.tileHeight, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 9 : 0).fill(on && look.isClassic ? Color.signal.opacity(0.14) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 9 : 0)
                .strokeBorder(on ? (look.isClassic ? Color.signal : Look.ink) : Look.line, lineWidth: on ? (look.isClassic ? 1.5 : 2) : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!installed)
        .glitch(on: on)
    }

    // MARK: its model

    /// `Default · Opus 5.5`, the agent's current models, then the ones a newer model superseded under `Older`.
    private var modelMenu: some View {
        // Codex: the models that run as its new sessions start (its Daybreak switch, docs/simple-view-v0.md §5.8).
        let all = TerminalDaybreak.offered(model.models[model.pickedAgent] ?? [], on: model.daybreakDefaults[model.pickedAgent])
        let picked = model.pickedModels[model.pickedAgent].flatMap { id in all.first { $0.id == id } }
        let fallback = model.modelDefaults[model.pickedAgent].map { "Default · \($0)" } ?? "Default"
        return Menu {
            Button(fallback) { model.pickedModels = model.pickedModels.filter { $0.key != model.pickedAgent } }
            ForEach(all.filter { !$0.older }) { option in
                Button(TerminalListText.modelTitle(option, among: all)) { pick(option) }
            }
            let older = all.filter(\.older)
            if !older.isEmpty {
                Menu("Older") {
                    ForEach(older) { option in Button(TerminalListText.modelTitle(option, among: all)) { pick(option) } }
                }
            }
        } label: {
            HStack {
                Text(picked.map { TerminalListText.modelTitle($0, among: all) } ?? fallback)
                    .font(look.isClassic ? .system(size: 13) : .system(size: 12.5, design: .monospaced))
                    .foregroundStyle(all.isEmpty ? Look.faint : Look.ink).lineLimit(1)
                Spacer()
                Text("▾").font(.system(size: 12, design: .monospaced)).foregroundStyle(Look.faint)
            }
            .padding(.horizontal, 10)
            .frame(height: look.isClassic ? 30 : 28)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).fill(look.isClassic ? Look.ink.opacity(0.07) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).strokeBorder(look.isClassic ? Color.clear : Look.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .disabled(all.isEmpty)
    }

    /// The level on its line, the model's stops lowest first; none chosen is the model's own default (`Default ·
    /// Medium`, the knob resting there hollow), and `Default` puts a choice back.
    private var effort: some View {
        let own = TerminalEffort.defaultLevel(models: model.models, defaults: model.effortDefaults, harness: model.pickedAgent, model: model.pickedModel)
        return EffortPicker(word: TerminalEffort.word(model.pickedAgent), levels: model.effortLevels, level: model.pickedEffort, fallback: own,
                            choose: { level in model.pickedEfforts = model.pickedEfforts.merging([model.pickedAgent: level]) { _, new in new } },
                            reset: { model.pickedEfforts = model.pickedEfforts.filter { $0.key != model.pickedAgent } },
                            heading: AnyView(PanelLabel(TerminalEffort.word(model.pickedAgent))))
            .frame(maxWidth: 340, alignment: .leading)
    }

    private func pick(_ option: TerminalModelOption) {
        model.pickedModels = model.pickedModels.merging([model.pickedAgent: option.id]) { _, new in new }
    }

    // MARK: the folder

    /// `❯ ~/path  ▾  [ Choose… ]`: typed, picked among the folders the list knows, or chosen in the system's panel.
    private var folder: some View {
        @Bindable var model = model
        return HStack(spacing: 10) {
            Text("❯").font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Color.signal)
            PlainField(text: $model.folderText, placeholder: "~/Folder",
                       font: .monospacedSystemFont(ofSize: 12.5, weight: .regular), focusRequests: model.folderFocus,
                       onSubmit: model.start, onCancel: model.cancelCreate)
            if !model.knownFolders.isEmpty {
                Menu {
                    ForEach(model.knownFolders, id: \.self) { path in Button(path) { model.folderText = path } }
                } label: {
                    Text("▾").font(.system(size: 12, design: .monospaced)).foregroundStyle(Look.ink2).frame(width: 20, height: 20).contentShape(Rectangle())
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .help("Folders in the List")
            }
            Button { choose() } label: { BracketLabel(word: "Choose…") }
                .buttonStyle(BracketButtonStyle(size: 12.5))
        }
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Look.line).frame(height: 1) }
    }

    private func choose() {
        let start = (model.folderText as NSString).expandingTildeInPath
        guard let url = FolderPanel.choose(message: "选择终端的工作文件夹。", startingAt: start.isEmpty ? nil : start) else { return }
        model.folderText = TerminalTree.tilde(url.path)
    }

    // MARK: how it asks

    /// One of three: `< >` / `<x>` in the pixel look (not boxes: those are for picking several).
    private var modes: some View {
        HStack(spacing: 22) {
            ForEach(TerminalListText.modes, id: \.id) { mode in
                let on = model.pickedMode == mode.id
                Button { model.pickedMode = mode.id } label: {
                    HStack(spacing: 6) {
                        LookChoice(on: on, size: 12.5).foregroundStyle(on ? Color.signal : Look.ink2)
                        Text(mode.name).font(look.isClassic ? .system(size: 13) : .system(size: 12.5, design: .monospaced))
                    }
                    .foregroundStyle(on ? Look.ink : Look.ink2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var foot: some View {
        HStack(spacing: 12) {
            Text(model.createError).font(.system(size: 12)).foregroundStyle(Color.failed).lineLimit(3).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glitch(on: model.createError, when: { !$0.isEmpty })
            if model.canLeaveCreate {
                Button { model.cancelCreate() } label: { BracketLabel(word: "Cancel", key: "esc") }
                    .buttonStyle(BracketButtonStyle(size: 12.5))
            }
            Button { model.start() } label: { BracketLabel(word: model.starting ? "Starting" : "Start", key: "↩") }
                .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
                .disabled(model.starting)
        }
    }
}

/// `// Model`: a part of the panel.
private struct PanelLabel: View {
    let text: String
    @Environment(\.interfaceLook) private var look
    init(_ text: String) { self.text = text }

    var body: some View {
        if look.isClassic {
            Text(text).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Look.ink2)
        } else {
            Text("// \(text)").font(.system(size: 11, design: .monospaced)).tracking(1.76).foregroundStyle(Look.faint)
        }
    }
}

/// `AGENTSWITCH` in the app's own 5 × 7 letters over an offset of the signal colour; the classic look has the app's
/// mark and its name.
private struct Wordmark: View {
    @Environment(\.interfaceLook) private var look

    private static let font: [Character: [String]] = [
        "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
        "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
        "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
        "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
        "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
        "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
        "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
        "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
        "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
        "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    ]
    private static let rows: [String] = (0..<7).map { y in "AGENTSWITCH".map { font[$0]?[y] ?? "....." }.joined(separator: ".") }

    var body: some View {
        if look.isClassic {
            HStack(spacing: 10) {
                ClassicMarkView(state: .idle, height: 36)
                Text("AgentSwitch").font(.system(size: 22, weight: .semibold)).foregroundStyle(Look.ink)
            }
            .frame(height: 48, alignment: .bottomLeading)
        } else {
            Group {
                if let held = Self.held {
                    letters(resolved: held)
                } else if reduceMotion || Self.shown || !onScreen {
                    letters(resolved: nil)
                } else {
                    // The first time a screen shows it, it resolves out of noise in a second, then stands still.
                    TimelineView(.periodic(from: appeared, by: 0.045)) { timeline in
                        let t = timeline.date.timeIntervalSince(appeared)
                        letters(resolved: t >= Self.reveal ? nil : t)
                            .onChange(of: t >= Self.reveal) { _, done in if done { Self.shown = true } }
                    }
                }
            }
            .frame(width: CGFloat(Self.rows[0].count) * Self.cell + 3, height: 7 * Self.cell + 3)
            .frame(height: 48, alignment: .bottomLeading)
            .accessibilityLabel("AgentSwitch")
            .onDisappear { Self.shown = true }
        }
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen
    @State private var appeared = Date()
    /// When each cell settles, from 0.12 to 0.82 s, its own for every cell (made once a showing).
    @State private var settles: [[Double]] = Wordmark.rows.map { $0.map { _ in Double.random(in: 0.12..<0.82) } }
    /// Shown once already since the app started: it stands still from then on.
    private static var shown = false
    private static let cell: CGFloat = 6
    private static let reveal = 1.0
    /// `-wordmarkFreeze 0.4` (debug builds): the reveal held still at that many seconds, for a picture of it.
    private static var held: Double? {
        #if DEBUG
        UserDefaults.standard.string(forKey: "wordmarkFreeze").flatMap(Double.init)
        #else
        nil
        #endif
    }

    /// The letters; `resolved`: seconds into the reveal — a cell not yet settled is a speck of noise that changes every
    /// frame (denser where a letter will be), a settled one its block.
    private func letters(resolved t: Double?) -> some View {
        let cell = Self.cell
        return Canvas { context, _ in
            guard let t else {
                func fill(_ color: Color, dx: CGFloat, dy: CGFloat) {
                    var path = Path()
                    for (y, row) in Self.rows.enumerated() {
                        for (x, mark) in row.enumerated() where mark == "#" {
                            path.addRect(CGRect(x: CGFloat(x) * cell + dx, y: CGFloat(y) * cell + dy, width: cell, height: cell))
                        }
                    }
                    context.fill(path, with: .color(color))
                }
                fill(.signal, dx: 3, dy: 3)
                fill(Look.ink, dx: 0, dy: 0)
                return
            }
            var solid = Path(), noise = Path(), faint = Path()
            for (y, row) in Self.rows.enumerated() {
                for (x, mark) in row.enumerated() {
                    let on = mark == "#"
                    let rect = CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)
                    if t >= settles[y][x] {
                        if on { solid.addRect(rect) }
                        continue
                    }
                    // A glyph of the ramp ` .:-=+*#%@` as a speck: the whole ramp where a letter will be, its start elsewhere.
                    let weight = CGFloat(Int.random(in: 0..<(on ? 10 : 4))) / 9
                    guard weight > 0 else { continue }
                    let side = max(1, (cell * weight).rounded())
                    let speck = CGRect(x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side)
                    if on { noise.addRect(speck) } else { faint.addRect(speck) }
                }
            }
            context.fill(faint, with: .color(Look.line))
            context.fill(noise, with: .color(Look.ink))
            context.fill(solid, with: .color(Look.ink))
        }
    }
}

// MARK: - the page's question

/// The question box over the page (the page dimmed under it): ↩ answers yes, esc no.
struct TerminalSheetView: View {
    let sheet: TerminalSheet
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var model = model
        ZStack {
            Button { model.answerSheet(ok: false) } label: { Color.black.opacity(0.55) }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel")
            VStack(alignment: .leading, spacing: 0) {
                Text(sheet.title).font(.system(size: 14, weight: .bold)).foregroundStyle(Look.ink).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 6)
                Text(sheet.body).font(.system(size: 12.5)).foregroundStyle(Look.ink2).lineSpacing(4).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 12)
                if let offers = sheet.offers {
                    HStack(spacing: 10) {
                        Text("❯").font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Color.signal)
                        PlainField(text: $model.sheetFolder, placeholder: "~/Folder", takesFocusAtFirst: true,
                                   onSubmit: { if !model.sheetFolder.isEmpty { model.answerSheet(ok: true) } }, onCancel: { model.answerSheet(ok: false) })
                        Button {
                            if let url = FolderPanel.choose(message: "选择会话继续所在的文件夹。", startingAt: nil) { model.sheetFolder = url.path }
                        } label: { BracketLabel(word: "Choose…") }
                        .buttonStyle(BracketButtonStyle(size: 12.5))
                    }
                    .padding(.vertical, 4)
                    .overlay(alignment: .bottom) { Rectangle().fill(Look.line).frame(height: 1) }
                    .padding(.bottom, 4)
                    // The folders offered, a line each (shown with ~, put in the field whole).
                    ForEach(offers, id: \.self) { path in
                        Button { model.sheetFolder = path } label: {
                            Text(TerminalTree.tilde(path)).font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(model.sheetFolder == path ? Look.ink : Look.ink2).lineLimit(1).truncationMode(.head)
                                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(path)
                    }
                    Color.clear.frame(height: 8)
                }
                if let check = sheet.check {
                    Button { model.sheetChecked.toggle() } label: {
                        HStack(spacing: 8) {
                            LookChoice(on: model.sheetChecked, multi: true, size: 12.5).foregroundStyle(model.sheetChecked ? Color.signal : Look.ink2)
                            Text(check).font(.system(size: 12.5)).foregroundStyle(Look.ink2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 12)
                }
                HStack(spacing: 12) {
                    Spacer()
                    Button { model.answerSheet(ok: false) } label: { BracketLabel(word: "Cancel", key: "esc") }
                        .buttonStyle(BracketButtonStyle(size: 12.5))
                    Button { model.answerSheet(ok: true) } label: { BracketLabel(word: sheet.confirm, key: "↩") }
                        .buttonStyle(BracketButtonStyle(role: sheet.destructive ? .destructive : .primary, size: 12.5))
                        .disabled(sheet.offers != nil && model.sheetFolder.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(EdgeInsets(top: 16, leading: 18, bottom: 14, trailing: 18))
            .frame(width: 420)
            .background(look.isClassic ? Look.panel : Color.black)
            .framed(look.isClassic ? Look.line : Look.ink, radius: 12)
            .background(Group { if !look.isClassic { Checker().offset(x: 6, y: 6) } })
            .shadow(color: .black.opacity(look.isClassic ? 0.4 : 0), radius: 16, y: 6)
            .glitch(on: sheet.id, onAppear: { true })
        }
    }
}
