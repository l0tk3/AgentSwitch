import AgentSwitchMacCore
import SwiftUI

/// A folder chosen on another node (2026-11-13, user: 做一个远程的文件夹选择器): the system's panel shows this Mac's
/// folders only, so here the node's own are walked a level at a time — a click goes into a folder, `Choose` takes the
/// one being looked at. What the node does not let this Mac read (its Files switch off, a scope) is said as it says
/// it, and the folder can still be typed.
struct NodeFolderPicker: View {
    let client: DaemonClient
    /// What the field held: where to start, when it is a path.
    let typed: String
    let choose: (String) -> Void
    let cancel: () -> Void

    @State private var level: FileLevel?
    @State private var loading = true
    @State private var problem: String?
    @State private var hidden = false
    @State private var hovered: String?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button { if let parent = level?.parent { go(parent) } } label: { LookGlyph(glyph: "↑", symbol: "chevron.up", size: 12).frame(width: 22, height: 22).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(level?.parent == nil ? Look.faint : Look.ink2).disabled(level?.parent == nil).help("Enclosing Folder")
                Button { if let home = level?.home, !home.isEmpty { go(home) } } label: { LookGlyph(glyph: "~", symbol: "house", size: 12).frame(width: 22, height: 22).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(Look.ink2).disabled(level == nil).help("Home")
                Text(level.map { NodeFolders.shown($0.path, home: $0.home) } ?? "…")
                    .font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 6)
                if loading { BrailleSpinner().foregroundStyle(Look.ink2) }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            HairRule(color: Look.line)
            list.frame(height: 280)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                Toggle("Hidden Folders", isOn: $hidden).toggleStyle(.checkbox).font(.system(size: 12)).foregroundStyle(Look.ink2)
                    .onChange(of: hidden) { _, _ in if let path = level?.path { go(path) } }
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Choose") { if let path = level?.path { choose(path) } }.keyboardShortcut(.defaultAction).disabled(level == nil || level?.scoped == true)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .frame(width: 440)
        .task { await start() }
    }

    @ViewBuilder private var list: some View {
        if let problem {
            VStack(spacing: 6) {
                Text(problem).font(.system(size: 12.5)).foregroundStyle(Look.ink2).multilineTextAlignment(.center)
                Text("文件夹仍可以直接输入。").font(.system(size: 11.5)).foregroundStyle(Look.faint)
            }
            .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let level {
            let folders = NodeFolders.folders(of: level)
            if folders.isEmpty {
                Text("这里没有文件夹。").font(.system(size: 12.5)).foregroundStyle(Look.faint).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(folders, id: \.name) { entry in
                            Button { go(NodeFolders.path(of: entry.name, in: level.path)) } label: {
                                HStack(spacing: 8) {
                                    LookGlyph(glyph: "▸", symbol: "folder", size: 12).foregroundStyle(Look.ink2).frame(width: 16)
                                    Text(entry.name).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(entry.dim || entry.hidden ? Look.ink2 : Look.ink).lineLimit(1).truncationMode(.middle)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).frame(height: 24)
                                .background(hovered == entry.name ? ListLook.selected : Color.clear)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .onHover { hovered = $0 ? entry.name : (hovered == entry.name ? nil : hovered) }
                        }
                        if level.more > 0 { Text("+\(level.more)").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.faint).padding(.horizontal, 12).frame(height: 22) }
                    }
                    .padding(.vertical, 4)
                }
            }
        } else {
            Color.clear
        }
    }

    /// Where the field points, when the node has it; else where the node starts this Mac (its home, its scope).
    private func start() async {
        if let path = NodeFolders.start(typed: typed, home: nil), await read(path) { return }
        guard await read(nil) else { return }
        if let home = level?.home, let path = NodeFolders.start(typed: typed, home: home), path != level?.path, !typed.hasPrefix("/") { _ = await read(path, quiet: true) }
    }

    private func go(_ path: String) { Task { await read(path) } }

    /// One level read; false when the node would not give it (said, unless `quiet`: what is shown stays).
    @discardableResult
    private func read(_ path: String?, quiet: Bool = false) async -> Bool {
        loading = true
        defer { loading = false }
        do {
            guard let got = try await client.fileLevel(path: path, hidden: hidden) else { return false }
            level = got.value
            problem = nil
            hovered = nil
            return true
        } catch {
            if !quiet, level == nil || path == nil { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
            return false
        }
    }
}
