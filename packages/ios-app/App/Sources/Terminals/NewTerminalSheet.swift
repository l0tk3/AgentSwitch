import AgentSwitchKit
import SwiftUI

/// `New` in the Terminals tab (docs/terminal-v0.md §1): the wordmark resolving out of glyph noise as it opens, then an
/// agent (its pixel mark and name; one not installed on the Mac is dithered and cannot be picked; the one picked
/// glitches once), its model (default = the agent's own), the folder (a prompt with a block caret: typed, or one used
/// before), and how it asks (`< > Ask Each` `<x> Auto` `< > Bypass`, bypass confirmed first in a pixel box). The page
/// it opens takes the size.
struct NewTerminalSheet: View {
    let started: (TerminalInfo) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("terminal.agent") private var agent = "claude-code"
    @AppStorage("terminal.mode") private var mode = "manual"
    @AppStorage("terminal.folder") private var folder = ""
    @State private var modelId = ""
    /// How hard it thinks: one of the levels the chosen model takes, or "" for the agent's own default.
    @State private var effortId = ""
    @State private var starting = false
    @State private var error: String?
    @State private var confirmBypass = false
    @FocusState private var typingFolder: Bool
    @Environment(\.interfaceLook) private var look

    static let agents: [(id: String, name: String)] = [("claude-code", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"), ("pi", "pi")]
    /// `< >` is one of several (§7.2.6).
    static let modes: [(id: String, name: String)] = [("manual", "Ask Each"), ("auto", "Auto"), ("bypass", "Bypass")]

    var body: some View {
        let store = model.terminals
        let installed = Set(store.list?.agents ?? [])
        // Codex: the models that run as its new sessions start (its Daybreak switch, docs/simple-view-v0.md §5.8).
        let models = TerminalDaybreak.offered(store.list?.models[agent] ?? [], on: store.list?.daybreak[agent])
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    Wordmark(reveal: true)
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Agent")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            ForEach(Self.agents, id: \.id) { a in
                                agentTile(a.id, a.name, installed: installed.contains(a.id))
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Model")
                        // The agent's own list: its current models, then those a newer one superseded under `Older`.
                        Menu {
                            Button(defaultLabel) { modelId = "" }
                            ForEach(models.filter { !$0.older }) { m in Button(m.name) { modelId = m.id } }
                            let older = models.filter(\.older)
                            if !older.isEmpty {
                                Menu("Older", systemImage: "clock") { ForEach(older) { m in Button(m.name) { modelId = m.id } } }
                            }
                        } label: {
                            HStack {
                                Text(models.first { $0.id == modelId }?.name ?? defaultLabel).mono(14)
                                Spacer()
                                LookGlyph(glyph: "▾", symbol: "chevron.down").foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .grounded(look.isClassic ? Theme.panel : Color.clear, radius: 10)
                            .framed(look.isClassic ? Color.clear : Theme.line, radius: 10)
                        }
                        .tint(Theme.ink)
                        .disabled(models.isEmpty)
                    }
                    // How hard it thinks, under the agent's own word for it and with the levels the chosen model takes
                    // (terminal-v0 §1 思考强度). Not shown where there is nothing to choose: a model with no levels, or
                    // OpenCode before a model is chosen (a variant is a model's).
                    if !levels.isEmpty {
                        // On a line, the model's stops lowest first; none chosen is the model's own default (the
                        // knob resting there hollow), and `Default` puts a choice back.
                        EffortPicker(levels: levels, level: effortId.isEmpty ? nil : effortId,
                                     fallback: EffortDisplay.defaultLevel(model.terminals.list, harness: agent, model: modelId),
                                     choose: { effortId = $0 }, reset: { effortId = "" }) { SectionLabel(EffortDisplay.word(agent)) }
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Folder")
                        HStack(spacing: 8) {
                            if look.isClassic {
                                Image(systemName: "folder").font(.system(size: 14)).foregroundStyle(Theme.inkDim)
                            } else {
                                Text("❯").mono(14).foregroundStyle(Theme.signal)
                            }
                            // A folder is a path: code in both looks.
                            TextField("~/project", text: $folder)
                                .code(14)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .focused($typingFolder)
                                // The prompt's block caret after the text while it is not being typed in (the system's
                                // caret then takes over).
                                .overlay(alignment: .leading) {
                                    if !typingFolder && !look.isClassic {
                                        HStack(spacing: 1) {
                                            Text(folder.isEmpty ? "" : folder).code(14).hidden()
                                            BlockCaret(width: 8, height: 17)
                                        }
                                        .allowsHitTesting(false)
                                    }
                                }
                                .clipped()
                        }
                        .padding(.vertical, look.isClassic ? 10 : 8)
                        .padding(.horizontal, look.isClassic ? 12 : 0)
                        // A prompt line with a rule under it; a round field in the classic look.
                        .grounded(look.isClassic ? Theme.panel : Color.clear, radius: 10)
                        .overlay(alignment: .bottom) { if !look.isClassic { Theme.line.frame(height: 1) } }
                        ForEach(store.recentFolders.map(MacPath.tilde), id: \.self) { f in
                            Button { folder = f } label: {
                                Text(f).code(12).foregroundStyle(folder == f ? Theme.ink : .secondary).lineLimit(1).truncationMode(.middle)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Permissions")
                        // One of three: `< >` / `<x>`; a segmented control's look in the classic one.
                        HStack(spacing: look.isClassic ? 0 : Theme.Space.l) {
                            ForEach(Self.modes, id: \.id) { m in
                                Button { if m.id == "bypass" && mode != "bypass" { confirmBypass = true } else { mode = m.id } } label: {
                                    if look.isClassic {
                                        Text(m.name).font(.system(size: 14, weight: mode == m.id ? .semibold : .regular))
                                            .foregroundStyle(mode == m.id ? Theme.ink : .secondary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 7)
                                            .background(mode == m.id ? Theme.panel : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    } else {
                                        Text("\(mode == m.id ? "<x>" : "< >") \(m.name)").mono(14)
                                            .foregroundStyle(mode == m.id ? Theme.ink : .secondary)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(look.isClassic ? 2 : 0)
                        .grounded(look.isClassic ? Theme.raised : Color.clear, radius: 10)
                        if mode == "bypass" {
                            Text("agent 的任何操作都不再询问你；禁区和凭据网关仍然生效。").font(.footnote).foregroundStyle(Theme.waiting)
                        }
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    Button { Task { await start() } } label: {
                        if starting && look.isClassic {
                            HStack(spacing: 6) { Text("Starting"); BrailleSpinner(color: Theme.onFill) }
                        } else if starting {
                            HStack(spacing: 6) { Text("[ Starting"); BrailleSpinner(color: Theme.base); Text("]") }
                        } else {
                            ButtonWord("Start")
                        }
                    }
                        .buttonStyle(SquareButtonStyle(prominent: true))
                        .disabled(starting || !installed.contains(agent) || folder.trimmingCharacters(in: .whitespaces).isEmpty || model.api == nil)
                }
                .padding(Theme.Space.l)
            }
            .background(Theme.base)
            .navigationTitle("New Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear {
                if folder.isEmpty, let first = store.recentFolders.first { folder = MacPath.tilde(first) }
                if !installed.contains(agent), let first = Self.agents.first(where: { installed.contains($0.id) }) { agent = first.id }
                if !Self.modes.contains(where: { $0.id == mode }) { mode = "manual" }
                #if DEBUG
                if UserDefaults.standard.string(forKey: "uiDemoScreen") == "newterminalbypass" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { confirmBypass = true }
                }
                #endif
            }
            .onChange(of: agent) { modelId = ""; effortId = "" }
            // Another model may not take the level chosen: then its own default.
            .onChange(of: modelId) { effortId = EffortDisplay.kept(effortId, in: levels) }
            .pixelBox(isPresented: $confirmBypass) {
                PixelBox(head: "Bypass", tone: .amber, message: "跳过全部权限确认？\(Self.bypassNote)",
                         actions: [.init(label: "Use Bypass", role: .primary) { mode = "bypass" }])
            }
        }
    }

    /// `Default`, and what it is today when the Mac knows (`Default · Opus 5.5`).
    private var defaultLabel: String {
        model.terminals.list?.defaults[agent].map { "Default · \($0)" } ?? "Default"
    }

    /// The levels the chosen model takes (none chosen: the agent's default model's).
    private var levels: [String] { EffortDisplay.levels(model.terminals.list, harness: agent, model: modelId) }


    /// What bypass leaves in force, said before it is chosen (here and when a bypass session is continued).
    static let bypassNote = "agent 的任何操作都不再询问你，包括删除文件和执行命令。仍然生效的：凭据网关（密钥不可读）。"

    private func agentTile(_ id: String, _ name: String, installed: Bool) -> some View {
        let on = agent == id
        return Button {
            guard agent != id else { return }
            UISelectionFeedbackGenerator().selectionChanged()
            agent = id
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                // The agent's shaded mark (§9): whole for the one chosen, fainter for the others; the tile's frame says which.
                PixelSprite(rows: PixelArt.agents[id] ?? PixelArt.square, pixel: 4, color: on ? Theme.signal : installed ? Theme.ink : Theme.inkDim,
                            strength: on ? 1 : installed ? 0.75 : 0.4, cell: 7.0 / 3)
                Text(name).mono(13).foregroundStyle(installed ? Theme.ink : Theme.inkDim)
                if !installed { Text("Not Installed").mono(10).foregroundStyle(.tertiary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .glitch(on: on)
        }
        .buttonStyle(AgentTileStyle(on: on))
        // Not on this Mac: half of it dithered away (the desktop's), not faded.
        .dithered(!installed)
        .disabled(!installed)
        .accessibilityLabel(name)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func start() async {
        guard let api = model.api else { return }
        starting = true
        defer { starting = false }
        do {
            let terminal = try await api.createTerminal(NewTerminalRequest(harness: agent, cwd: folder.trimmingCharacters(in: .whitespaces),
                                                                           model: modelId.isEmpty ? nil : modelId,
                                                                           effort: effortId.isEmpty ? nil : effortId, mode: mode))
            dismiss()
            started(terminal)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// An agent's tile: a 2 pt ink frame once picked; while a finger is on it, raised at once (the tap answers before the
/// scroll view decides it was not a drag).
private struct AgentTileStyle: ButtonStyle {
    let on: Bool
    @Environment(\.interfaceLook) private var look

    func makeBody(configuration: Configuration) -> some View {
        if look.isClassic {
            // A round tile on its own ground; the one chosen ringed in the accent.
            configuration.label
                .background(configuration.isPressed ? Theme.raised : Theme.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.signal : Color.clear, lineWidth: 2))
                .contentShape(Rectangle())
        } else {
            configuration.label
                .background(configuration.isPressed ? Theme.raised : Color.clear)
                .overlay(Rectangle().strokeBorder(on || configuration.isPressed ? Theme.ink : Theme.line, lineWidth: on ? 2 : 1))
                .contentShape(Rectangle())
        }
    }
}
