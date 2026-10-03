import CoreGraphics
import Foundation
import ImageIO

/// A tab's JPEG frame decoded (docs/browser-v0.md §1 画面流): ImageIO decodes it at once
/// (`kCGImageSourceShouldCacheImmediately`), so showing it later costs the main thread nothing. CGImage is immutable.
public struct BrowserDecodedFrame: @unchecked Sendable {
    public let frame: BrowserFrame
    public let image: CGImage

    /// Nil for bytes that are no picture.
    public static func decode(_ frame: BrowserFrame) -> BrowserDecodedFrame? {
        guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return nil }
        return BrowserDecodedFrame(frame: frame, image: image)
    }
}

/// Decodes a tab's frames off the main thread, one at a time, keeping only the newest waiting: a frame that comes while
/// one is being decoded replaces the one waiting, so the picture never falls behind the Mac. `reset()` drops what is
/// under way (another visit, another tab).
@MainActor
public final class BrowserFrameDecoder {
    /// A frame ready to show, on the main actor.
    public var onFrame: (BrowserDecodedFrame) -> Void = { _ in }
    private var waiting: BrowserFrame?
    private var decoding = false
    private var generation = 0

    public init() {}

    public func take(_ frame: BrowserFrame) {
        waiting = frame
        guard !decoding else { return }
        decoding = true
        let generation = generation
        Task { [weak self] in
            while let self, self.generation == generation, let next = self.waiting {
                self.waiting = nil
                let decoded = await Task.detached(priority: .userInitiated) { BrowserDecodedFrame.decode(next) }.value
                if self.generation == generation, let decoded { self.onFrame(decoded) }
            }
            // After `reset()` the flag is the next run's.
            guard let self, self.generation == generation else { return }
            self.decoding = false
        }
    }

    public func reset() {
        generation += 1
        waiting = nil
        decoding = false
    }
}
