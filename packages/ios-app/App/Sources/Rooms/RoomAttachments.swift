import AgentSwitchKit
import QuickLook
import SwiftUI
import UIKit

// The files of a room as a chat shows them (docs/chatroom-v0.md §3 附件, §9): a picture a message came with is drawn
// under it, any other file is a card — its kind's icon, its name, its size — and a tap opens one whole with the
// system's Quick Look. A file of the room's shared folder is read through the room's own route; one elsewhere on the
// Mac through the Files routes, as far as this phone may read there. And the pictures picked here for the next
// message, waiting above the box.

/// One file of a room: where it is on the Mac, and — when it is in the room's shared folder — where under it.
struct RoomFileRef: Hashable {
    let room: String
    let path: String
    /// Under the shared folder; nil for a file elsewhere on the Mac.
    let under: String?

    init(room: String, path: String, folder: String) {
        self.room = room
        self.path = path
        under = RoomFiles.relative(path, in: folder)
    }

    var key: String { "\(room)|\(path)" }
    var name: String { RoomMessage.fileName(path) }
    var isPicture: Bool { RoomMessage.isPicture(path) }
}

/// What has been read of the rooms' files: the pictures small (a file a message came with is not asked for again as
/// the timeline scrolls), how big the others are, and one whole in a file for the system's viewer.
@MainActor
final class RoomFileStore {
    static let shared = RoomFileStore()
    private let pictures = NSCache<NSString, UIImage>()
    /// The Mac answered and gave no picture (refused, too large, gone): drawn as a card, not asked again.
    private var missing = Set<String>()
    private var sizes: [String: Int64] = [:]
    private var unsized = Set<String>()
    /// When each room's shared folder was last listed for its sizes.
    private var listed: [String: Date] = [:]

    /// The longest side a picture is kept at, in pixels.
    private static let side = 900

    init() { pictures.countLimit = 120 }

    func held(_ ref: RoomFileRef) -> UIImage? { pictures.object(forKey: ref.key as NSString) }
    func isMissing(_ ref: RoomFileRef) -> Bool { missing.contains(ref.key) }
    func size(of ref: RoomFileRef) -> Int64? { sizes[ref.key] }

    private enum Read {
        case bytes(Data)
        /// The Mac answered: not this file, not to this phone.
        case refused
        case unreachable
    }

    /// The picture small; nil when there is none to draw. `failed`: the Mac said so — not reaching it is not that,
    /// and the picture is asked for again when its row shows next.
    func picture(_ ref: RoomFileRef, api: AgentSwitchAPI?, files: (any MacFileSource)?) async -> (image: UIImage?, failed: Bool) {
        if let image = held(ref) { return (image, false) }
        if missing.contains(ref.key) { return (nil, true) }
        switch await small(ref, api: api, files: files) {
        case .bytes(let data):
            if ref.under != nil { sizes[ref.key] = Int64(data.count) }
            guard let image = RecordPictureStore.image(data, side: Self.side) else { missing.insert(ref.key); return (nil, true) }
            pictures.setObject(image, forKey: ref.key as NSString)
            return (image, false)
        case .refused:
            missing.insert(ref.key)
            return (nil, true)
        case .unreachable:
            return (nil, false)
        }
    }

    /// A picture's bytes for drawing it small: the file itself from the shared folder, the Files routes' small copy
    /// from elsewhere.
    private func small(_ ref: RoomFileRef, api: AgentSwitchAPI?, files: (any MacFileSource)?) async -> Read {
        #if DEBUG
        if api == nil, DemoRooms.isDemo, let data = DemoRooms.bytes(ref.path) { return .bytes(data) }
        #endif
        do {
            if let under = ref.under {
                guard let api else { return .unreachable }
                return .bytes(try await api.roomFile(ref.room, path: under))
            }
            guard let files else { return .unreachable }
            return .bytes(try await files.fileThumbnail(ref.path))
        } catch APIError.http {
            return .refused
        } catch {
            return .unreachable
        }
    }

    /// How big a file is, when that can be told: from the shared folder's list, or from the Files routes.
    func size(_ ref: RoomFileRef, api: AgentSwitchAPI?, files: (any MacFileSource)?) async -> Int64? {
        if let known = sizes[ref.key] { return known }
        if unsized.contains(ref.key) { return nil }
        if ref.under != nil {
            // One list tells of every file of the folder; asked again only for a file that came after it.
            if let at = listed[ref.room], Date().timeIntervalSince(at) < 10 { return nil }
            listed[ref.room] = Date()
            var list: RoomFiles?
            #if DEBUG
            if api == nil, DemoRooms.isDemo { list = DemoRooms.files }
            #endif
            if list == nil, let api { list = try? await api.roomFiles(ref.room) }
            for file in list?.files ?? [] {
                sizes["\(ref.room)|\(RoomFiles.whole(file.path, in: list?.folder ?? ""))"] = file.size
                if let under = ref.under, file.path == under { sizes[ref.key] = file.size }
            }
            return sizes[ref.key]
        }
        guard let files else { return nil }
        do {
            let size = try await files.fileDetails(ref.path).size
            sizes[ref.key] = size
            return size
        } catch APIError.http {
            unsized.insert(ref.key)
            return nil
        } catch {
            return nil
        }
    }

    /// The file whole, in the app's caches (emptied at each start), for the system's viewer.
    func file(_ ref: RoomFileRef, api: AgentSwitchAPI?, files: (any MacFileSource)?) async throws -> URL {
        let url = try FilePreviewPage.cacheURL(ref.key)
        #if DEBUG
        if api == nil, DemoRooms.isDemo, let data = DemoRooms.bytes(ref.path) {
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            return url
        }
        #endif
        if let under = ref.under {
            guard let api else { throw APIError.transport("未连接 Mac。") }
            if let size = sizes[ref.key], size > RoomFiles.maxFileBytes { throw APIError.http(status: 413, message: FileRefusal.tooLarge.rawValue) }
            let data = try await api.roomFile(ref.room, path: under)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            return url
        }
        guard let files else { throw APIError.transport("未连接 Mac。") }
        try await files.downloadFile(ref.path, to: url) { _ in }
        return url
    }

    /// Why a file could not be opened, in a sentence.
    static func sentence(_ error: Error, mac: String) -> String {
        if case APIError.http(let status, _) = error, status == 413 { return "文件超过 25 MB，手机上不预览。" }
        if let refusal = FileRefusal.of(error), refusal != .unsupported { return refusal.sentence(mac: mac) }
        return error.localizedDescription
    }

    /// What Quick Look was given is deleted once it closes: the copy was for looking at only.
    static func forget(_ url: URL) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

/// The files a message came with, under its words: pictures drawn, the rest as cards. A tap opens one of the shared
/// folder — and a picture that could be read from elsewhere — whole; any other file elsewhere on the Mac is shown in
/// its folder on the Files page, as before.
struct RoomMessageFiles: View {
    let room: String
    /// The room's shared folder on the Mac.
    let folder: String
    let paths: [String]
    /// A file by where it is on the Mac: the folder it is in, on the Files page.
    let showInFiles: (String) -> Void
    @Environment(AppModel.self) private var app
    @State private var preview: URL?
    @State private var opening: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(paths, id: \.self) { path in
                let ref = RoomFileRef(room: room, path: path, folder: folder)
                RoomFileTile(ref: ref, opening: opening == path, open: { drawn in open(ref, drawn: drawn) })
                    .contextMenu {
                        Button("Show in Files", systemImage: "folder") { showInFiles(path) }
                        Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                    }
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.failed).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.top, 4)
        .padding(.bottom, 2)
        .quickLookPreview($preview)
        .onChange(of: preview) { old, new in if new == nil, let old { RoomFileStore.forget(old) } }
    }

    /// `drawn`: it is on the page as a picture, so this phone can read it.
    private func open(_ ref: RoomFileRef, drawn: Bool) {
        guard opening == nil else { return }
        guard ref.under != nil || drawn else { showInFiles(ref.path); return }
        opening = ref.path
        problem = nil
        Task {
            defer { opening = nil }
            do {
                preview = try await RoomFileStore.shared.file(ref, api: app.api, files: app.fileSource)
            } catch {
                // Elsewhere on the Mac, the Files page says what there is to say of it.
                if ref.under == nil { showInFiles(ref.path) } else { problem = RoomFileStore.sentence(error, mac: app.profile?.name ?? "Mac") }
            }
        }
    }
}

/// One file of a message: the picture it is, or its card.
private struct RoomFileTile: View {
    let ref: RoomFileRef
    /// Being fetched whole for the viewer.
    let opening: Bool
    /// Tapped; true when it is drawn as a picture.
    let open: (Bool) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @State private var image: UIImage?
    @State private var failed = false
    @State private var size: Int64?

    /// The room a picture is given: no wider than a message's words on a small phone, no taller than half a screen.
    private static let most = CGSize(width: 240, height: 280)

    var body: some View {
        let store = RoomFileStore.shared
        let picture = image ?? store.held(ref)
        Group {
            if ref.isPicture, let picture {
                Button { open(true) } label: { drawn(picture) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Image \(ref.name)")
            } else if ref.isPicture, !failed, !store.isMissing(ref) {
                waiting
            } else {
                Button { open(false) } label: { card }
                    .buttonStyle(.plain)
                    .accessibilityLabel(ref.path)
            }
        }
        .task(id: ref.key) {
            if ref.isPicture {
                let got = await store.picture(ref, api: app.api, files: app.fileSource)
                image = got.image
                failed = got.failed
                guard got.failed else { return }
            }
            size = await store.size(ref, api: app.api, files: app.fileSource)
        }
    }

    private func drawn(_ picture: UIImage) -> some View {
        let radius: CGFloat = look.isClassic ? 12 : 0
        let fit = Self.fit(picture.size)
        return Image(uiImage: picture).resizable().interpolation(.medium).aspectRatio(contentMode: .fill)
            .frame(width: fit.width, height: fit.height)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { if opening { ZStack { Color.black.opacity(0.35); BrailleSpinner(color: .white) }.clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous)) } }
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            .contentShape(Rectangle())
    }

    /// The picture's own shape within the room it is given; a small one is not blown up, a sliver is still a thing
    /// to tap.
    static func fit(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 160, height: 120) }
        // What was read is kept at twice the points it is drawn at.
        let scale = min(most.width / size.width, most.height / size.height, 0.5)
        return CGSize(width: max(44, (size.width * scale).rounded()), height: max(44, (size.height * scale).rounded()))
    }

    /// Not read yet: its place is kept.
    private var waiting: some View {
        let radius: CGFloat = look.isClassic ? 12 : 0
        return ZStack { BrailleSpinner(color: .secondary) }
            .frame(width: 160, height: 120)
            .background(Theme.raised.opacity(look.isClassic ? 1 : 0), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: look.isClassic ? 0 : 1))
            .accessibilityLabel("Loading \(ref.name)")
    }

    private var card: some View {
        let radius: CGFloat = look.isClassic ? 12 : 0
        return HStack(spacing: 10) {
            ZStack {
                if opening {
                    BrailleSpinner(color: .secondary)
                } else if look.isClassic {
                    Image(systemName: FileIcon.symbol(for: ref.name)).font(.system(size: 20, weight: .light)).foregroundStyle(Theme.signal)
                } else {
                    PixelSprite(rows: RoomArt.file, pixel: 3, color: Theme.ink)
                }
            }
            .frame(width: 38, height: 38)
            .background(look.isClassic ? Theme.signal.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(ref.name).font(.system(size: 14, weight: .medium, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink)
                    .lineLimit(1).truncationMode(.middle)
                Text(Self.facts(ref.name, size: size ?? RoomFileStore.shared.size(of: ref))).mono(11.5).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: 260, alignment: .leading)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: look.isClassic ? 0 : 1))
        .contentShape(Rectangle())
    }

    /// What kind by its name, and how big when that is known: `MD · 4.7 KB`.
    static func facts(_ name: String, size: Int64?) -> String {
        let ext = (name as NSString).pathExtension.uppercased()
        return [ext.isEmpty ? "File" : ext, size.map(FileSize.short)].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A picture picked on this phone for the next message: as it will be sent, and where it is on the Mac once it has
/// been put into the room's shared folder (a send that failed after that does not put it there twice).
struct RoomAttachment: Identifiable {
    let id = UUID()
    let name: String
    let data: Data
    let thumbnail: UIImage?
    var path: String?

    /// Pictures as they are sent: shrunk and upright, JPEG or PNG (`ImagePrep`), named by when they were picked.
    /// `unread`: how many could not be read as pictures, or are too big for the room to take.
    nonisolated static func prepared(_ files: [UploadFile], at date: Date = Date()) -> (ready: [RoomAttachment], unread: Int) {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = format.string(from: date)
        var ready: [RoomAttachment] = [], unread = 0
        for file in files {
            guard let made = ImagePrep.prepare(file), !made.data.isEmpty, Int64(made.data.count) <= RoomFiles.maxFileBytes else { unread += 1; continue }
            let ext = (made.name as NSString).pathExtension.lowercased()
            let name = "photo-\(stamp)\(ready.isEmpty ? "" : "-\(ready.count + 1)").\(ext.isEmpty ? "jpg" : ext)"
            ready.append(RoomAttachment(name: name, data: made.data, thumbnail: UIImage(data: made.data)?.preparingThumbnail(of: CGSize(width: 168, height: 168))))
        }
        return (ready, unread)
    }
}

/// The pictures waiting to go with the next message, above the box: small, each with its `×`; while they are being
/// put on the Mac, how far that is.
struct RoomAttachmentStrip: View {
    let model: RoomPageModel
    @Environment(\.interfaceLook) private var look

    private static let side: CGFloat = 56

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !model.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.attachments) { item in tile(item) }
                    }
                    .padding(.top, 6).padding(.trailing, 6)
                }
            }
            if model.preparing {
                HStack(spacing: 6) { BrailleSpinner(color: .secondary); Text("Preparing").mono(11.5).foregroundStyle(.secondary) }
            } else if let n = model.uploading {
                HStack(spacing: 6) { BrailleSpinner(color: .secondary); Text("Uploading \(n)/\(model.attachments.count)").mono(11.5).foregroundStyle(.secondary) }
            }
        }
    }

    private func tile(_ item: RoomAttachment) -> some View {
        let radius: CGFloat = look.isClassic ? 9 : 0
        return ZStack {
            if let thumbnail = item.thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Image(systemName: "photo").font(.system(size: 18)).foregroundStyle(.secondary)
            }
        }
        .frame(width: Self.side, height: Self.side)
        .background(Theme.raised)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay {
            // Still to go while the others are being put on the Mac.
            if model.sending, item.path == nil { ZStack { Color.black.opacity(0.35); BrailleSpinner(color: .white) }.clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous)) }
        }
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            if !model.sending {
                Button { model.removeAttachment(item.id) } label: {
                    LookGlyph(glyph: "×", symbol: "xmark", size: 11).fontWeight(.bold).foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: look.isClassic ? 10 : 0))
                        .frame(width: 32, height: 32, alignment: .topTrailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
                .accessibilityLabel("Remove \(item.name)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(item.name)
    }
}
