import AgentSwitchKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What the attach menus bring in (the task composer's "+", a terminal's "+"): photos, files from the Files app, images
/// on the clipboard — as files to upload.
enum PickedFiles {
    /// Photos as their original bytes (HEIC or JPEG); ImagePrep shrinks and re-encodes them.
    static func photos(_ items: [PhotosPickerItem]) async -> [UploadFile] {
        var files: [UploadFile] = []
        for (i, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
            files.append(UploadFile(name: "photo-\(i + 1).\(type.preferredFilenameExtension ?? "jpg")", type: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        return files
    }

    /// Files picked in the Files app: read inside their security scope; a file over the limit is not read at all.
    nonisolated static func read(_ urls: [URL]) -> (files: [UploadFile], skipped: [String]) {
        var files: [UploadFile] = []
        var skipped: [String] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= PendingAttachment.maxFileBytes, let data = try? Data(contentsOf: url) else {
                skipped.append(url.lastPathComponent)
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(UploadFile(name: url.lastPathComponent, type: type, data: data))
        }
        return (files, skipped)
    }

    /// Images on the clipboard, as JPEG (a pasted photo as PNG would be many times larger; ImagePrep then shrinks it and
    /// turns it upright).
    @MainActor
    static func pastedImages() -> [UploadFile] { files(from: UIPasteboard.general.images ?? []) }

    /// Pictures pasted, as the files they are sent as.
    static func files(from images: [UIImage]) -> [UploadFile] {
        images.enumerated().compactMap { i, image in
            image.jpegData(compressionQuality: 0.9).map { UploadFile(name: images.count == 1 ? "pasted.jpg" : "pasted-\(i + 1).jpg", type: "image/jpeg", data: $0) }
        }
    }
}
