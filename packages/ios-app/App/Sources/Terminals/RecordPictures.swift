import AgentSwitchKit
import ImageIO
import QuickLook
import SwiftUI
import UIKit

// The pictures you sent with a message, in a session's record (docs/simple-view-v0.md §4, §5.1): small under the message,
// one opened whole with the system's viewer.

/// Which session a record's pictures are asked of.
struct RecordPictureSource: Equatable {
    let harness: String
    let session: String

    func key(_ item: String, _ n: Int) -> String { "\(harness)/\(session)/\(item)/\(n)" }
    /// The `n`-th picture of `item`: one sent with a message, or — `step` given — one the step of that place in a run
    /// of work brought back.
    func key(_ item: String, step: Int?, _ n: Int) -> String { step.map { "\(harness)/\(session)/\(item)/s\($0)/\(n)" } ?? key(item, n) }
}

/// The pictures read so far, small: a message's pictures never change (an item's id is its place in a file that only
/// grows), so each is asked of the Mac once.
@MainActor
final class RecordPictureStore {
    static let shared = RecordPictureStore()
    private let small = NSCache<NSString, UIImage>()
    private var missing = Set<String>()

    init() { small.countLimit = 200 }

    func held(_ key: String) -> UIImage? { small.object(forKey: key as NSString) }

    /// The picture small, read once; nil when the Mac has none (an older Mac, an agent read coarsely, a file moved).
    func thumbnail(_ api: AgentSwitchAPI?, _ source: RecordPictureSource, item: String, step: Int? = nil, n: Int) async -> UIImage? {
        let key = source.key(item, step: step, n)
        if let image = held(key) { return image }
        if missing.contains(key) { return nil }
        switch await read(api, source, item: item, step: step, n: n) {
        case .picture(let data):
            guard let image = Self.image(data, side: 480) else { missing.insert(key); return nil }
            small.setObject(image, forKey: key as NSString)
            return image
        case .none:
            missing.insert(key)
            return nil
        case .unreachable:
            // Not reaching the Mac is not the picture missing: asked again when the row shows next.
            return nil
        }
    }

    /// The picture whole, in a file for the system's viewer (named by what it is).
    func file(_ api: AgentSwitchAPI?, _ source: RecordPictureSource, item: String, step: Int? = nil, n: Int) async -> URL? {
        guard case .picture(let data) = await read(api, source, item: item, step: step, n: n) else { return nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("record-pictures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("Image \(n + 1).\(RecordDisplay.pictureExtension(data))")
        do { try data.write(to: url, options: .atomic) } catch { return nil }
        return url
    }

    private enum Read {
        case picture(Data)
        /// The Mac answered: it has no such picture.
        case none
        case unreachable
    }

    private func read(_ api: AgentSwitchAPI?, _ source: RecordPictureSource, item: String, step: Int?, n: Int) async -> Read {
        guard let api else {
            #if DEBUG
            return DemoData.picture(n).map(Read.picture) ?? .none
            #else
            return .none
            #endif
        }
        do {
            if let step { return .picture(try await api.sessionStepImage(harness: source.harness, id: source.session, work: item, n: step, k: n)) }
            return .picture(try await api.sessionImage(harness: source.harness, id: source.session, item: item, n: n))
        } catch APIError.http {
            return .none
        } catch {
            return .unreachable
        }
    }

    /// `data` decoded no larger than `side`, upright.
    static func image(_ data: Data, side: Int) -> UIImage? {
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: side]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// The pictures sent with a message — or, `step` given, the ones a step brought back — small, in a row under it; a
/// tap opens one whole.
struct RecordPictures: View {
    let source: RecordPictureSource
    let item: String
    let count: Int
    var step: Int? = nil
    /// A step's pictures are what was opened to see: larger than a message's.
    var height: CGFloat = RecordPicture.height
    @Environment(AppModel.self) private var model
    @State private var preview: URL?
    @State private var opening: Int?

    /// A message with many pictures shows the first few (a record is for reading, not a gallery).
    private static let shown = 4

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            ForEach(0..<min(count, Self.shown), id: \.self) { n in
                RecordPicture(source: source, item: item, step: step, n: n, height: height, opening: opening == n) { open(n) }
            }
            if count > Self.shown { Text("+\(count - Self.shown)").mono(11).foregroundStyle(.secondary).frame(height: height) }
        }
        .quickLookPreview($preview)
    }

    private func open(_ n: Int) {
        guard opening == nil else { return }
        opening = n
        Task {
            preview = await RecordPictureStore.shared.file(model.api, source, item: item, step: step, n: n)
            opening = nil
        }
    }
}

struct RecordPicture: View {
    let source: RecordPictureSource
    let item: String
    var step: Int? = nil
    let n: Int
    var height: CGFloat = RecordPicture.height
    let opening: Bool
    let open: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var image: UIImage?
    @State private var failed = false

    static let height: CGFloat = 96

    var body: some View {
        let radius: CGFloat = look.isClassic ? 9 : 0
        Group {
            if let image {
                Button(action: open) {
                    Image(uiImage: image).resizable().interpolation(.medium).aspectRatio(contentMode: .fill)
                        .frame(width: width(of: image), height: height)
                        .clipShape(RoundedRectangle(cornerRadius: radius))
                        .overlay { if opening { ZStack { Color.black.opacity(0.35); BrailleSpinner(color: .white) }.clipShape(RoundedRectangle(cornerRadius: radius)) } }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Image \(n + 1)")
            } else {
                // Not read yet, or not there to read (an older Mac, its file moved): its place is kept.
                ZStack {
                    if failed { LookWord("Image").mono(11).foregroundStyle(.tertiary) } else { BrailleSpinner(color: .secondary) }
                }
                .frame(width: height, height: height)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.line, lineWidth: 1))
        .task(id: source.key(item, step: step, n)) {
            image = await RecordPictureStore.shared.thumbnail(model.api, source, item: item, step: step, n: n)
            failed = image == nil
        }
    }

    /// As wide as the picture is at this height, within reason: a tall screenshot is not a sliver, a wide one not a banner.
    private func width(of image: UIImage) -> CGFloat {
        guard image.size.height > 0 else { return height }
        return min(max(height * image.size.width / image.size.height, 54), height * 1.75)
    }
}
