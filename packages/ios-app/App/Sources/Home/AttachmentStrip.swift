import AgentSwitchKit
import SwiftUI

/// The files waiting to go with the next task, above the input box: thumbnails or file names, each removable, and the
/// one reminder that attachments are not sealed (router-v0 §9).
struct AttachmentStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.preparingAttachments > 0 {
            HStack(spacing: 6) { ProgressView(); Text("处理附件中").font(.caption).foregroundStyle(.secondary) }
        }
        if !model.attachments.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.attachments) { item in tile(item) }
                    }
                }
                Label("附件不经过自动加密，其中的密码将原样提供给模型。", systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(Theme.waiting)
            }
        }
    }

    private func tile(_ item: PendingAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let thumbnail = item.thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    VStack(spacing: 2) {
                        Image(systemName: "doc").font(.title3)
                        Text(item.file.name).font(.caption2).lineLimit(2).multilineTextAlignment(.center)
                    }
                    .padding(4)
                }
            }
            .frame(width: 60, height: 60)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            Button { model.removeAttachment(item.id) } label: {
                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
            }
            .offset(x: 6, y: -6)
            .accessibilityLabel("移除 \(item.file.name)")
        }
        .padding(.top, 6)
    }
}
