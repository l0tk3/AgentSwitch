import AgentSwitchKit
import SwiftUI

/// A session whose folder is gone — moved, renamed or deleted — goes on in a folder picked here (docs/terminal-v0.md §5,
/// 2026-10-03, user: 如果会话没了选择新目录继续): the folder line as in New (a prompt with a block caret), then the
/// folders the Mac offers (the same name elsewhere, the first put in the line; the nearest folder above the old one,
/// only offered: confirmed by mistake it would move the session into a folder too wide) and those used before. Paths go
/// back whole; `~` is only how they are shown. A picked folder that is missing too is said, and kept in the line to mend.
struct MovedFolderSheet: View {
    let gone: MovedFolder
    let resume: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var folder = ""
    @FocusState private var typingFolder: Bool

    var body: some View {
        var seen: Set<String> = [gone.cwd]
        let choices = (gone.alike + (gone.near.map { [$0] } ?? []) + model.terminals.recentFolders).filter { seen.insert($0).inserted }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.xl) {
                    Text("「\(gone.session.displayTitle)」原来在 \(MacPath.tilde(gone.cwd))，该文件夹可能已被移动、改名或删除。\(gone.missing.map { "所选的 \(MacPath.tilde($0)) 也不存在。" } ?? "")请选择一个文件夹，会话将在那里继续。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        SectionLabel("Folder")
                        HStack(spacing: 8) {
                            Text("❯").mono(14).foregroundStyle(Theme.signal)
                            TextField("~/project", text: $folder)
                                .mono(14)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .focused($typingFolder)
                                .overlay(alignment: .leading) {
                                    if !typingFolder {
                                        HStack(spacing: 1) {
                                            Text(folder).mono(14).hidden()
                                            BlockCaret(width: 8, height: 17)
                                        }
                                        .allowsHitTesting(false)
                                    }
                                }
                                .clipped()
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Theme.line.frame(height: 1) }
                        ForEach(choices, id: \.self) { f in
                            Button { folder = f } label: {
                                Text(MacPath.tilde(f)).mono(12).foregroundStyle(folder == f ? Theme.ink : .secondary).lineLimit(1).truncationMode(.middle)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    Button("[ Resume ]") {
                        dismiss()
                        resume(folder.trimmingCharacters(in: .whitespaces))
                    }
                    .buttonStyle(SquareButtonStyle(prominent: true))
                    .disabled(folder.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(Theme.Space.l)
            }
            .background(Theme.base)
            .navigationTitle("Folder Gone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { if folder.isEmpty { folder = gone.missing ?? gone.alike.first ?? "" } }
        }
    }
}

/// A session to continue whose folder is gone, and what the Mac offers in its place.
struct MovedFolder: Identifiable {
    let session: SessionSummary
    /// The folder it ran in.
    let cwd: String
    /// Folders of the same name the Mac knows; the nearest folder above `cwd` still there.
    let alike: [String]
    let near: String?
    let fork: Bool
    let mode: String?
    /// A folder picked before that is missing too.
    var missing: String? = nil
    var id: String { session.id }

    /// The same, after `folder` was picked and is missing too.
    func picked(_ folder: String) -> MovedFolder {
        MovedFolder(session: session, cwd: cwd, alike: alike, near: near, fork: fork, mode: mode, missing: folder)
    }
}
