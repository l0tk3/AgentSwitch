import AgentSwitchKit
import SwiftUI

/// `new` in the terminals tab (docs/terminal-v0.md §1): an agent (its pixel mark and name; one not installed on the Mac
/// is dithered and cannot be picked), its model (default = the agent's own), the folder (typed, or one used before),
/// and how it asks (`< > ask each` `<x> auto`; bypass is chosen on the Mac only). The page it opens takes the size.
struct NewTerminalSheet: View {
    let started: (TerminalInfo) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("terminal.agent") private var agent = "claude-code"
    @AppStorage("terminal.mode") private var mode = "manual"
    @AppStorage("terminal.folder") private var folder = ""
    @State private var modelId = ""
    @State private var starting = false
    @State private var error: String?

    static let agents: [(id: String, name: String)] = [("claude-code", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"), ("pi", "pi")]
    /// `< >` is one of several (§7.2.6); no bypass here.
    static let modes: [(id: String, name: String)] = [("manual", "ask each"), ("auto", "auto")]

    var body: some View {
        let store = model.terminals
        let installed = Set(store.list?.agents ?? [])
        let models = store.list?.models[agent] ?? []
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("agent")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            ForEach(Self.agents, id: \.id) { a in
                                agentTile(a.id, a.name, installed: installed.contains(a.id))
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("model")
                        Menu {
                            Button("default") { modelId = "" }
                            ForEach(models) { m in Button(m.name) { modelId = m.id } }
                        } label: {
                            HStack {
                                Text(models.first { $0.id == modelId }?.name ?? "default").mono(14)
                                Spacer()
                                Text("▾").mono(13).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                        }
                        .tint(Theme.ink)
                        .disabled(models.isEmpty)
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("folder")
                        HStack(spacing: 8) {
                            Text("❯").mono(14).foregroundStyle(Theme.signal)
                            TextField("~/project", text: $folder)
                                .mono(14)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Theme.line.frame(height: 1) }
                        ForEach(store.recentFolders.map(MacPath.tilde), id: \.self) { f in
                            Button { folder = f } label: {
                                Text(f).mono(12).foregroundStyle(folder == f ? Theme.ink : .secondary).lineLimit(1).truncationMode(.middle)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("permissions")
                        HStack(spacing: Theme.Space.l) {
                            ForEach(Self.modes, id: \.id) { m in
                                Button { mode = m.id } label: {
                                    Text("\(mode == m.id ? "<x>" : "< >") \(m.name)").mono(14)
                                        .foregroundStyle(mode == m.id ? Theme.ink : .secondary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Text("bypass 只能在 Mac 上选择。").font(.footnote).foregroundStyle(.tertiary)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    Button { Task { await start() } } label: { Text(starting ? "[ starting ]" : "[ start ]") }
                        .buttonStyle(SquareButtonStyle(prominent: true))
                        .disabled(starting || !installed.contains(agent) || folder.trimmingCharacters(in: .whitespaces).isEmpty || model.api == nil)
                }
                .padding(Theme.Space.l)
            }
            .background(Theme.base)
            .navigationTitle("new terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("cancel") { dismiss() } } }
            .onAppear {
                if folder.isEmpty, let first = store.recentFolders.first { folder = MacPath.tilde(first) }
                if !installed.contains(agent), let first = Self.agents.first(where: { installed.contains($0.id) }) { agent = first.id }
                if !Self.modes.contains(where: { $0.id == mode }) { mode = "manual" }
            }
            .onChange(of: agent) { modelId = "" }
        }
    }

    private func agentTile(_ id: String, _ name: String, installed: Bool) -> some View {
        let on = agent == id
        return Button { agent = id } label: {
            VStack(alignment: .leading, spacing: 10) {
                PixelSprite(rows: PixelArt.agents[id] ?? PixelArt.square, pixel: 4, color: on ? Theme.signal : Theme.ink)
                Text(name).mono(13)
                if !installed { Text("not installed").mono(10).foregroundStyle(.tertiary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay(Rectangle().strokeBorder(on ? Theme.ink : Theme.line, lineWidth: on ? 2 : 1))
            .opacity(installed ? 1 : 0.4)
        }
        .buttonStyle(.plain)
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
                                                                           model: modelId.isEmpty ? nil : modelId, mode: mode))
            dismiss()
            started(terminal)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
