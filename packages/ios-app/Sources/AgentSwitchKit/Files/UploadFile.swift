import Foundation

/// A file on its way to the Mac (`POST /uploads`, app-v0 §5): name, MIME type and bytes.
public struct UploadFile: Sendable, Equatable {
    public let name: String
    public let type: String
    public let data: Data

    public init(name: String, type: String, data: Data) {
        self.name = name
        self.type = type
        self.data = data
    }
}

/// `POST /uploads` → `{files: [...]}`: a staged file's id goes into the task's `attachments`.
public struct StagedUpload: Decodable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let size: Int64
    public let type: String
}

struct StagedUploads: Decodable { let files: [StagedUpload] }

/// One file of a task (`GET /tasks/:id/files`): the user's `in/` attachments and the executor's `out/` deliverables,
/// or, once a temporary work dir is gone, the deliverables kept in the artifacts store (no prefix).
public struct TaskFile: Sendable, Hashable, Identifiable {
    public let path: String
    public let size: Int64
    public let isDeliverable: Bool

    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }

    /// Documents a web view would render (and could fetch remote resources for) are shown as source instead of in
    /// the system preview; the daemon serves them sandboxed to browsers, which a local preview cannot reproduce.
    public var opensInPreview: Bool {
        !["html", "htm", "xhtml", "svg", "svgz", "xml", "webarchive"].contains((name as NSString).pathExtension.lowercased())
    }

    /// Where a download is cached, below the app's own folder: task id then the listed path, without "." / ".." or
    /// empty segments, so a server-supplied path never leaves the task's folder.
    public static func cacheSegments(taskId: String, path: String) -> [String] {
        let clean = { (s: String) in s.split(separator: "/").map(String.init).filter { $0 != "." && $0 != ".." } }
        let file = clean(path)
        return [clean(taskId).joined(separator: "-")] + (file.isEmpty ? ["file"] : file)
    }
}

struct TaskFileList: Decodable {
    struct Entry: Decodable { let path: String; let size: Int64 }
    let root: String?
    let files: [Entry]

    var taskFiles: [TaskFile] {
        files.map { TaskFile(path: $0.path, size: $0.size, isDeliverable: root == "artifacts" || $0.path.hasPrefix("out/")) }
    }
}

/// multipart/form-data with every file under the field name "files". A file name loses CR/LF (no header injection)
/// and has its quotes percent-escaped; an empty type is sent as application/octet-stream.
public enum Multipart {
    public static func body(_ files: [UploadFile], boundary: String) -> Data {
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
