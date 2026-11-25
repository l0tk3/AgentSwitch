import CoreServices
import Foundation

// Files on their way to the service and files brought down from it (daemon api/files.ts), ported from the iPhone Kit
// (Files/UploadFile.swift).

/// A file on its way to the Mac (`POST /uploads`): name, MIME type and bytes. Dragged into a terminal or a room's
/// box, chosen, or pasted as a picture.
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

/// `POST /uploads` → `{files: [...]}`: a staged file, by its id.
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

/// Where a file is, as a page draws its mark: on the Mac only, being downloaded, or downloaded here.
public enum DispatchFileState: Sendable, Hashable { case remote, downloading, local }

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
