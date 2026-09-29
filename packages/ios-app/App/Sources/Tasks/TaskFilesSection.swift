import AgentSwitchKit
import SwiftUI

/// Opening a task's files, on the task page and the home screen's cards alike (app-v0 §5): a tap downloads into the app's
/// caches and opens the system preview (share, save); HTML, SVG and XML are shown as source, since a local preview could
/// fetch their remote resources. Knows which files are on the phone already (this launch: the cache is emptied at start).
@MainActor
@Observable
final class TaskFileOpener {
    enum State { case remote, downloading, local }

    var preview: URL?
    var source: SourceFile?
    var error: String?
    private(set) var downloading: String?
    private var local: Set<String> = []

    private static func key(_ taskId: String, _ file: TaskFile) -> String { "\(taskId)/\(file.path)" }

    func state(_ file: TaskFile, taskId: String) -> State {
        let key = Self.key(taskId, file)
        return downloading == key ? .downloading : local.contains(key) ? .local : .remote
    }

    func open(_ file: TaskFile, taskId: String, model: AppModel) async {
        guard let api = model.api, downloading == nil else { return }
        let key = Self.key(taskId, file)
        downloading = key
        defer { downloading = nil }
        do {
            let url = try FileCache.url(taskId: taskId, path: file.path)
            let data: Data
            if local.contains(key), let cached = try? Data(contentsOf: url) {
                data = cached
            } else {
                data = try await api.download(taskId: taskId, path: file.path)
                try data.write(to: url, options: [.atomic, .completeFileProtection])
                local.insert(key)
            }
            error = nil
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
}

extension View {
    /// Where the opener shows a file: the system preview, or the source sheet.
    func taskFilePreview(_ opener: TaskFileOpener) -> some View {
        @Bindable var opener = opener
        return quickLookPreview($opener.preview).sheet(item: $opener.source) { SourceFileView(file: $0) }
    }
}

/// 文件 on a task page: what the executor handed back (`out/`, or the kept artifacts) and what you sent (`in/`). The
/// list is loaded by the task page.
struct TaskFilesSection: View {
    let taskId: String
    let files: [TaskFile]
    let opener: TaskFileOpener
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var opener = opener
        if !files.isEmpty {
            Block("files") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                        if index > 0 { Theme.line.frame(height: 1).padding(.leading, 34) }
                        Button { Task { await opener.open(file, taskId: taskId, model: model) } } label: { row(file) }
                            .buttonStyle(.plain)
                            .disabled(opener.downloading != nil)
                    }
                }
                .padding(.horizontal, 14)
                .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                if opener.error != nil { ErrorText(message: $opener.error) }
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
            FileStateMark(state: opener.state(file, taskId: taskId))
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
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

/// Where a file is: `↓` still on the Mac, the spinner while it comes, a square once it is on the phone.
struct FileStateMark: View {
    let state: TaskFileOpener.State

    var body: some View {
        switch state {
        case .remote: Text("↓").mono(13).foregroundStyle(.secondary).accessibilityLabel("download")
        case .downloading: BrailleSpinner(color: .secondary)
        case .local: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done).accessibilityLabel("downloaded")
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
