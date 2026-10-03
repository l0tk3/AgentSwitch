import CoreServices
import Foundation

// Attachments and a task's files (app-v0 §5, daemon api/files.ts), ported from the iPhone Kit (Files/UploadFile.swift)
// and the phone's PendingAttachment / TaskFileOpener rules.

/// A file on its way to the Mac (`POST /uploads`): name, MIME type and bytes. Dragged into the window, `Files…`, or
/// `Paste Image` (docs/dispatch-v0.md §2).
public struct DispatchUploadFile: Sendable, Hashable {
    public let name: String
    public let type: String
    public let data: Data

    public init(name: String, type: String, data: Data) {
        self.name = name
        self.type = type
        self.data = data
    }

    /// The limits before anything is sent: the Mac's (20 files, 50 MB each, files/names.ts) and the phone's 100 MB in
    /// all for one message.
    public static let maxCount = 20
    public static let maxFileBytes = 50 * 1024 * 1024
    public static let maxTotalBytes = 100 * 1024 * 1024

    /// Why `file` cannot join `current`, or nil when it can.
    public static func problem(adding file: DispatchUploadFile, to current: [DispatchUploadFile]) -> String? {
        if current.count >= maxCount { return "每次最多 \(maxCount) 个附件" }
        if file.data.count > maxFileBytes { return "\(file.name) 超过 50 MB" }
        let total = current.reduce(0) { $0 + $1.data.count } + file.data.count
        return total > maxTotalBytes ? "附件总大小不可超过 100 MB" : nil
    }
}

/// `POST /uploads` → `{files: [...]}`: a staged file's id goes into the message's `attachments`.
public struct DispatchStagedUpload: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let size: Int64
    public let type: String

    public init(id: String, name: String, size: Int64, type: String) {
        self.id = id
        self.name = name
        self.size = size
        self.type = type
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(id: try c.require(String.self, "id"), name: c.first(String.self, "name") ?? "", size: c.first(Int64.self, "size") ?? 0,
                  type: c.first(String.self, "type") ?? "")
    }
}

struct DispatchStagedUploads: Decodable { let files: [DispatchStagedUpload] }

/// Where a file of a task is, as the page draws its mark: on the Mac only, being downloaded, or downloaded here.
public enum DispatchFileState: Sendable, Hashable { case remote, downloading, local }

/// One file of a task (`GET /tasks/:id/files`): the user's `in/` attachments and the executor's `out/` deliverables,
/// or, once a temporary work dir is gone, the deliverables kept in the artifacts store (no prefix).
public struct DispatchTaskFile: Sendable, Hashable, Identifiable {
    public let path: String
    public let size: Int64
    public let isDeliverable: Bool
    /// When the Mac last saw it written (ms since 1970, `mtime`); nil from a Mac that does not say.
    public let modified: Double?

    public init(path: String, size: Int64, isDeliverable: Bool, modified: Double? = nil) {
        self.path = path
        self.size = size
        self.isDeliverable = isDeliverable
        self.modified = modified
    }

    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
    /// `4 KB`, as the card shows it.
    public var sizeText: String { ByteCountFormatter.string(fromByteCount: size, countStyle: .file) }
    /// Which version of the file this is: a copy downloaded under another version is no longer it.
    public var version: String { "\(size):\(modified.map { String($0) } ?? "")" }

    /// Documents a web view would render (and could fetch remote resources for) are shown as source instead of in the
    /// system preview; the daemon serves them sandboxed to browsers, which a local preview cannot reproduce.
    public var opensInPreview: Bool {
        !["html", "htm", "xhtml", "svg", "svgz", "xml", "webarchive"].contains((name as NSString).pathExtension.lowercased())
    }

    /// What a click does with the downloaded copy at `url`. The executor wrote the file, and a prompt can steer what it
    /// writes, so it is judged as a link in a terminal is (LinkPolicy): a document opens in its app; an app, a script,
    /// an installer or anything not known to be a document is only shown in Finder; a web page, SVG or XML is shown as
    /// its source.
    public static func opening(_ file: DispatchTaskFile, at url: URL) -> DispatchFileOpening {
        guard file.opensInPreview else { return .source(url) }
        switch LinkPolicy.action(for: url) {
        case .open(let target): return .open(target)
        case .reveal(let target): return .reveal(target)
        // A downloaded copy is a file URL: a web page cannot come of it; a copy that is not there opens nothing.
        case .browse, .ignore: return .ignore
        }
    }

    /// Where a download is kept, below the app's own folder: task id then the listed path, without "." / ".." or empty
    /// segments, so a server-supplied path never leaves the task's folder.
    public static func cacheSegments(taskId: String, path: String) -> [String] {
        let clean = { (s: String) in s.split(separator: "/").map(String.init).filter { $0 != "." && $0 != ".." } }
        let file = clean(path)
        return [clean(taskId).joined(separator: "-")] + (file.isEmpty ? ["file"] : file)
    }

    /// `root/<task>/<path>`, built from `cacheSegments`.
    public static func cacheURL(root: URL, taskId: String, path: String) -> URL {
        cacheSegments(taskId: taskId, path: path).reduce(root) { $0.appendingPathComponent($1, isDirectory: false) }
    }

    /// Deliverables first (what the task was for), then by path: the task page's order.
    public static func pageOrder(_ files: [DispatchTaskFile]) -> [DispatchTaskFile] {
        files.sorted { ($0.isDeliverable ? 0 : 1, $0.path) < ($1.isDeliverable ? 0 : 1, $1.path) }
    }

    /// The deliverables alone, by path: what a card lists.
    public static func cardFiles(_ files: [DispatchTaskFile]) -> [DispatchTaskFile] {
        files.filter(\.isDeliverable).sorted { $0.path < $1.path }
    }
}

/// What a click on a downloaded task file does (DispatchTaskFile.opening).
public enum DispatchFileOpening: Equatable, Sendable {
    /// Shown as text in the window (never rendered).
    case source(URL)
    /// Opened in its app.
    case open(URL)
    /// Selected in Finder, not opened.
    case reveal(URL)
    case ignore
}

/// Downloads carry the system's quarantine mark, as a browser's do: Gatekeeper checks anything in them that would run
/// before it runs, whatever opened it.
public enum DispatchQuarantine {
    public static let agentName = "AgentSwitch"

    public static func mark(_ url: URL) throws {
        var values = URLResourceValues()
        values.quarantineProperties = [
            kLSQuarantineAgentNameKey as String: agentName,
            kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String,
        ]
        var target = url
        try target.setResourceValues(values)
    }
}

/// `GET /tasks/:id/files` → `{root, files: [{path, size, mtime}]}`.
struct DispatchTaskFileList: Decodable {
    struct Entry: Decodable { let path: String; let size: Int64?; let mtime: Double? }
    let root: String?
    let files: [Entry]

    var taskFiles: [DispatchTaskFile] {
        files.map {
            DispatchTaskFile(path: $0.path, size: $0.size ?? 0, isDeliverable: root == "artifacts" || $0.path.hasPrefix("out/"),
                             modified: $0.mtime)
        }
    }
}

/// multipart/form-data with every file under the field name "files". A file name loses CR/LF (no header injection)
/// and has its quotes percent-escaped; an empty type is sent as application/octet-stream.
public enum DispatchMultipart {
    public static func body(_ files: [DispatchUploadFile], boundary: String) -> Data {
        var out = Data()
        for file in files {
            let name = file.name.replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
                .replacingOccurrences(of: "\"", with: "%22")
            out.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"\(name)\"\r\n".utf8))
            out.append(Data("Content-Type: \(file.type.isEmpty ? "application/octet-stream" : file.type)\r\n\r\n".utf8))
            out.append(file.data)
            out.append(Data("\r\n".utf8))
        }
        out.append(Data("--\(boundary)--\r\n".utf8))
        return out
    }
}
