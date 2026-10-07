import AgentSwitchMacCore
import AppKit
import ImageIO
import SwiftUI

// Pictures in a pane's simple view (docs/simple-view-v0.md §4, §5.1, §5.2): the ones you sent with a message, small under
// it, and the files of the reply being written, above its box.

/// Where what a record holds more of is asked for: a message's pictures, a step whole.
struct RecordSource {
    let harness: String
    let session: String
    let client: () -> DaemonClient

    func key(_ item: String, _ n: Int) -> String { "\(harness)/\(session)/\(item)/\(n)" }

    /// The `n`-th picture of `item`: one sent with a message, or — `step` given — one the step of that place in a run
    /// of work brought back.
    func key(_ item: String, step: Int?, _ n: Int) -> String { step.map { "\(harness)/\(session)/\(item)/s\($0)/\(n)" } ?? key(item, n) }

    @MainActor
    func picture(_ item: String, step: Int?, _ n: Int) async throws -> Data {
        let client = client(), harness = harness, session = session
        if let step { return try await client.sessionStepImage(harness: harness, id: session, work: item, n: step, k: n) }
        return try await client.sessionImage(harness: harness, id: session, item: item, n: n)
    }
}

/// The pictures read so far, small: a message's pictures never change (an item's id is its place in a file that only
/// grows), so each is asked for once.
@MainActor
final class RecordPictureStore {
    static let shared = RecordPictureStore()
    /// The longer side of a thumbnail, in pixels.
    static let side = 480
    private let small = NSCache<NSString, NSImage>()
    private var missing = Set<String>()

    init() { small.countLimit = 300 }

    func held(_ key: String) -> NSImage? { small.object(forKey: key as NSString) }
    func isMissing(_ key: String) -> Bool { missing.contains(key) }

    /// The picture small, read once; nil when the service has none (an agent read coarsely, a file since moved).
    func thumbnail(_ source: RecordSource, item: String, step: Int? = nil, n: Int) async -> NSImage? {
        let key = source.key(item, step: step, n)
        if let image = held(key) { return image }
        if missing.contains(key) { return nil }
        guard let data = try? await source.picture(item, step: step, n),
              let image = Self.image(data, side: Self.side) else {
            missing.insert(key)
            return nil
        }
        small.setObject(image, forKey: key as NSString)
        return image
    }

    /// The picture whole, for a closer look.
    func whole(_ source: RecordSource, item: String, step: Int? = nil, n: Int) async -> NSImage? {
        guard let data = try? await source.picture(item, step: step, n) else { return nil }
        return NSImage(data: data)
    }

    /// `data` (or the file at `url`) decoded no larger than `side`, upright.
    static func image(_ data: Data? = nil, url: URL? = nil, side: Int) -> NSImage? {
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: side]
        let source = url.flatMap { CGImageSourceCreateWithURL($0 as CFURL, nil) } ?? data.flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }
        guard let source, let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }

    #if DEBUG
    /// The design preview's: a picture without a service.
    func stage(_ key: String, _ image: NSImage) { small.setObject(image, forKey: key as NSString) }
    #endif
}

/// The pictures sent with a message — or, `step` given, the ones a step brought back — small, in a row under it; a
/// click shows one whole.
struct RecordPictures: View {
    @Environment(\.interfaceLook) private var look
    let source: RecordSource
    let item: String
    let count: Int
    var step: Int? = nil
    /// A step's pictures are what was opened to see: larger than a message's.
    var height: CGFloat = RecordPicture.height
    @State private var shown: Shown?

    struct Shown: Identifiable {
        let n: Int
        var id: Int { n }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            // A message with many pictures shows the first few (a record is for reading, not a gallery).
            ForEach(0..<min(count, 6), id: \.self) { n in
                RecordPicture(source: source, item: item, step: step, n: n, height: height) { shown = Shown(n: n) }
            }
            if count > 6 { Text("+\(count - 6)").mono(Look.size(11, look)).foregroundStyle(Look.ink2).frame(height: height) }
        }
        .sheet(item: $shown) { shown in RecordPictureSheet(source: source, item: item, step: step, n: shown.n, count: count) }
    }
}

private struct RecordPicture: View {
    let source: RecordSource
    let item: String
    var step: Int? = nil
    let n: Int
    var height: CGFloat = RecordPicture.height
    let open: () -> Void
    @State private var image: NSImage?
    @State private var failed = false
    @Environment(\.interfaceLook) private var look

    static let height: CGFloat = 84

    var body: some View {
        let radius: CGFloat = look.isClassic ? 7 : 0
        Group {
            if let image {
                Button(action: open) {
                    Image(nsImage: image).resizable().interpolation(.medium).aspectRatio(contentMode: .fill)
                        .frame(width: width(of: image), height: height)
                        .clipShape(RoundedRectangle(cornerRadius: radius))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Image \(n + 1)")
            } else {
                // Not read yet, or not there to read (its file was moved, an agent read coarsely): its place is kept.
                ZStack {
                    if failed { Text("Image").mono(Look.size(10.5, look)).foregroundStyle(Look.faint) } else { BrailleSpinner().foregroundStyle(Look.ink2) }
                }
                .frame(width: height, height: height)
            }
        }
        .framed(Look.line, radius: radius)
        .task(id: source.key(item, step: step, n)) {
            let store = RecordPictureStore.shared
            if let held = store.held(source.key(item, step: step, n)) { image = held; return }
            image = await store.thumbnail(source, item: item, step: step, n: n)
            failed = image == nil
        }
    }

    /// As wide as the picture is at this height, within reason: a tall screenshot is not a sliver, a wide one not a banner.
    private func width(of image: NSImage) -> CGFloat {
        guard image.size.height > 0 else { return height }
        return min(max(height * image.size.width / image.size.height, 48), height * 2)
    }
}

/// One picture whole.
private struct RecordPictureSheet: View {
    @Environment(\.interfaceLook) private var look
    let source: RecordSource
    let item: String
    var step: Int? = nil
    @State var n: Int
    let count: Int
    @Environment(\.dismiss) private var dismiss
    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(count > 1 ? "Image \(n + 1) of \(count)" : "Image").font(.system(size: 14, weight: .semibold)).foregroundStyle(Look.ink)
                if count > 1 {
                    Button { n = (n + count - 1) % count } label: { BracketLabel(word: "Previous", key: "←") }.buttonStyle(.plain).keyboardShortcut(.leftArrow, modifiers: [])
                    Button { n = (n + 1) % count } label: { BracketLabel(word: "Next", key: "→") }.buttonStyle(.plain).keyboardShortcut(.rightArrow, modifiers: [])
                }
                Spacer()
                if let image {
                    Button { NSPasteboard.general.clearContents(); NSPasteboard.general.writeObjects([image]) } label: { BracketLabel(word: "Copy", key: "⌘C") }
                        .buttonStyle(.plain).keyboardShortcut("c", modifiers: .command)
                }
                Button { dismiss() } label: { BracketLabel(word: "Done", key: "esc") }.buttonStyle(.plain).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            HairRule(color: Look.line)
            ZStack {
                if let image {
                    Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                } else if failed {
                    Text("这张图片读不到了。").font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.faint)
                } else {
                    BrailleSpinner().foregroundStyle(Look.ink2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(16)
        }
        .frame(width: 860, height: 640)
        .background(Look.ground)
        .task(id: n) {
            image = RecordPictureStore.shared.held(source.key(item, step: step, n))
            failed = false
            if let whole = await RecordPictureStore.shared.whole(source, item: item, step: step, n: n) { image = whole } else if image == nil { failed = true }
        }
    }
}

/// The reply's files above its box: a picture small, then each one's number as its placeholder says, its name, and ×
/// to take it out (its placeholder goes too).
struct RecordDraftStrip: View {
    let record: PaneRecord
    @Environment(\.interfaceLook) private var look

    var body: some View {
        FlowLayout(spacing: 8, lineSpacing: 6) {
            ForEach(record.draftFiles) { file in
                HStack(spacing: 7) {
                    if let thumbnail = file.thumbnail {
                        Image(nsImage: thumbnail).resizable().aspectRatio(contentMode: .fill)
                            .frame(width: 26, height: 26)
                            .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 4 : 0))
                            .framed(Look.line, radius: look.isClassic ? 4 : 0)
                    }
                    Text("#\(file.number)").mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink).padding(.leading, file.thumbnail == nil ? 5 : 0)
                    Text(file.name).mono(Look.size(11.5, look)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.middle).frame(maxWidth: 200, alignment: .leading)
                    Button { record.remove(file) } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 11.5) }
                        .buttonStyle(QuietButtonStyle())
                        .help("Remove")
                }
                .padding(.leading, 3).padding(.trailing, 8).padding(.vertical, 3)
                .framed(Look.line, radius: Look.controlRadius)
                .help(file.path ?? file.name)
            }
        }
    }
}
