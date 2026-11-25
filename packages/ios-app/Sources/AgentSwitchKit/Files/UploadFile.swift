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
