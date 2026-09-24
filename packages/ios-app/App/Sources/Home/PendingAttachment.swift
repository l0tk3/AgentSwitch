import AgentSwitchKit
import SwiftUI
import UIKit

/// A file chosen for the next task, prepared and waiting in the input bar.
struct PendingAttachment: Identifiable {
    static let maxCount = 20
    static let maxFileBytes = 50 * 1024 * 1024
    static let maxTotalBytes = 100 * 1024 * 1024

    let id = UUID()
    let file: UploadFile
    /// A small preview for images; nil for other files.
    let thumbnail: UIImage?

    init(file: UploadFile) {
        self.file = file
        thumbnail = file.type.hasPrefix("image/") ? UIImage(data: file.data)?.preparingThumbnail(of: CGSize(width: 120, height: 120)) : nil
    }

    /// Why `file` cannot join `current`, or nil when it can.
    static func problem(adding file: UploadFile, to current: [PendingAttachment]) -> String? {
        if current.count >= maxCount { return "一次最多 \(maxCount) 个附件" }
        if file.data.count > maxFileBytes { return "\(file.name) 超过 50 MB" }
        let total = current.reduce(0) { $0 + $1.file.data.count } + file.data.count
        return total > maxTotalBytes ? "附件合计不能超过 100 MB" : nil
    }
}
