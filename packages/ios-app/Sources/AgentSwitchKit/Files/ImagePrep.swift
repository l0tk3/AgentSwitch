import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Images are prepared on the phone before they are sent (app-v0 §5): the long side at most `maxPixel`, turned
/// upright, re-encoded without the original's metadata (so no location leaves the phone), JPEG — except a PNG, which
/// stays PNG so a screenshot's text stays sharp. Anything else passes as is.
public enum ImagePrep {
    public static let maxPixel = 2048
    public static let jpegQuality = 0.8

    /// The file to upload, or nil when it claims to be an image but cannot be read.
    public static func prepare(_ file: UploadFile) -> UploadFile? {
        guard isImage(file) else { return file }
        guard let source = CGImageSourceCreateWithData(file.data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), maxPixel),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let png = CGImageSourceGetType(source).map { UTType($0 as String) == .png } ?? false
        let type: UTType = png ? .png : .jpeg
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        let encode: [CFString: Any] = png ? [:] : [kCGImageDestinationLossyCompressionQuality: jpegQuality]
        CGImageDestinationAddImage(dest, image, encode as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return UploadFile(name: renamed(file.name, to: png ? "png" : "jpg"), type: png ? "image/png" : "image/jpeg", data: out as Data)
    }

    /// A still raster image this can shrink; a GIF (animation) and vector images pass as they are.
    public static func isImage(_ file: UploadFile) -> Bool {
        let ext = (file.name as NSString).pathExtension
        let type = UTType(mimeType: file.type) ?? UTType(filenameExtension: ext)
        guard let type, type.conforms(to: .image) else { return false }
        return !type.conforms(to: .gif) && !type.conforms(to: .svg)
    }

    private static func renamed(_ name: String, to ext: String) -> String {
        let stem = (name as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "image" : stem).\(ext)"
    }
}
