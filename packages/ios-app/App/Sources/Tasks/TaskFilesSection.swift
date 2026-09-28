import AgentSwitchKit
import SwiftUI

/// 文件 on a task page (app-v0 §5): what the executor handed back (`out/`, or the kept artifacts) and what you sent
/// (`in/`). A tap downloads into the app's caches and opens the system preview (share, save); HTML, SVG and XML are
/// shown as source, since a local preview could fetch their remote resources. The list is loaded by the task page.
struct TaskFilesSection: View {
    let taskId: String
    let files: [TaskFile]
    @Binding var preview: URL?
    @Binding var source: SourceFile?
    @Environment(AppModel.self) private var model
    @State private var downloading: String?
    @State private var error: String?

    var body: some View {
        if !files.isEmpty {
            Block("files") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                        if index > 0 { Theme.line.frame(height: 1).padding(.leading, 34) }
                        Button { Task { await open(file) } } label: { row(file) }
                            .buttonStyle(.plain)
                            .disabled(downloading != nil)
                    }
                }
                .padding(.horizontal, 14)
                .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                if error != nil { ErrorText(message: $error) }
            }
        }
    }

    private func row(_ file: TaskFile) -> some View {
        HStack(spacing: 10) {
            Image(systemName: Self.icon(for: file.name)).frame(width: 24).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.subheadline).lineLimit(2)
                Text("\(file.isDeliverable ? "返回的文件" : "发送的附件") · \(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if downloading == file.path { BrailleSpinner(color: .secondary) } else { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func open(_ file: TaskFile) async {
        guard let api = model.api else { return }
        downloading = file.path
        defer { downloading = nil }
        do {
            let data = try await api.download(taskId: taskId, path: file.path)
            let url = try FileCache.url(taskId: taskId, path: file.path)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            if file.opensInPreview {
                preview = url
            } else {
                source = SourceFile(url: url, text: String(decoding: data.prefix(SourceFile.maxBytes), as: UTF8.self))
            }
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    static func icon(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "heic", "gif", "webp": return "photo"
        case "pdf": return "doc.richtext"
        case "csv", "xlsx", "xls", "numbers": return "tablecells"
        case "zip", "tar", "gz": return "doc.zipper"
        case "md", "txt", "json", "log": return "doc.text"
        default: return "doc"
        }
    }
}

/// Downloads live in Caches/agentswitch-files/<task>/<path>, emptied when the app starts.
enum FileCache {
    static func root() throws -> URL {
        try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("agentswitch-files", isDirectory: true)
    }

    static func url(taskId: String, path: String) throws -> URL {
        var url = try root()
        let segments = TaskFile.cacheSegments(taskId: taskId, path: path)
        for segment in segments.dropLast() { url.appendPathComponent(segment, isDirectory: true) }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.appendingPathComponent(segments.last ?? "file")
    }

    static func clear() {
        guard let root = try? root() else { return }
        try? FileManager.default.removeItem(at: root)
    }
}

/// A web-type deliverable shown as text (never rendered), with the file to share.
struct SourceFile: Identifiable {
    static let maxBytes = 512 * 1024
    let url: URL
    let text: String
    var id: URL { url }
}

struct SourceFileView: View {
    let file: SourceFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(file.text).font(.caption.monospaced()).textSelection(.enabled).padding()
            }
            .navigationTitle(file.url.lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { ShareLink(item: file.url) }
            }
        }
    }
}
