import Foundation

/// Between a tab's connection and its page (docs/browser-v0.md §1 画面流): every change in order, but only the newest
/// frame — a frame still waiting to be read when a newer one comes is dropped, so a page that draws slowly shows the
/// Mac's latest picture instead of working through old ones and nothing piles up — and at most `limit` events waiting
/// in all (the oldest go). One reader.
final class BrowserEventBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var waiting: [BrowserEvent] = []
    private var reader: CheckedContinuation<BrowserEvent?, Error>?
    /// How it ended (nil while open); an error is thrown once, after what was still waiting.
    private var end: Result<Void, Error>?
    private var onCancel: (@Sendable () -> Void)?
    private var cancelled = false

    static let defaultLimit = 64

    init(limit: Int = BrowserEventBuffer.defaultLimit) { self.limit = max(limit, 2) }

    /// What the connection brought.
    func push(_ event: BrowserEvent) {
        lock.lock()
        guard end == nil else { return lock.unlock() }
        if let reader {
            self.reader = nil
            lock.unlock()
            return reader.resume(returning: event)
        }
        if case .frame = event { waiting.removeAll { if case .frame = $0 { true } else { false } } }
        waiting.append(event)
        if waiting.count > limit { waiting.removeFirst(waiting.count - limit) }
        lock.unlock()
    }

    /// No more events: the reader gets what is waiting, then the end (or `error`).
    func finish(throwing error: Error? = nil) {
        lock.lock()
        guard end == nil else { return lock.unlock() }
        end = error.map { .failure($0) } ?? .success(())
        let reader = self.reader
        self.reader = nil
        if reader != nil { end = .success(()) }
        lock.unlock()
        // A reader waits only when nothing is waiting.
        if let error { reader?.resume(throwing: error) } else { reader?.resume(returning: nil) }
    }

    /// The next event; nil at the end or once the reader is cancelled (`onCancel` runs then).
    func next() async throws -> BrowserEvent? {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<BrowserEvent?, Error>) in
                lock.lock()
                if !waiting.isEmpty {
                    let event = waiting.removeFirst()
                    lock.unlock()
                    c.resume(returning: event)
                } else if let end {
                    self.end = .success(())
                    lock.unlock()
                    c.resume(with: end.map { _ in nil })
                } else {
                    reader = c
                    lock.unlock()
                }
            }
        } onCancel: {
            cancel()
        }
    }

    /// Runs once the reader goes away (cancelled); at once if it already has.
    func whenCancelled(_ action: @escaping @Sendable () -> Void) {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return action()
        }
        onCancel = action
        lock.unlock()
    }

    /// The reader went away: nothing more is kept; the producer is told.
    func cancel() {
        lock.lock()
        cancelled = true
        let reader = self.reader
        self.reader = nil
        let action = onCancel
        onCancel = nil
        if end == nil { end = .success(()) }
        waiting.removeAll()
        lock.unlock()
        reader?.resume(returning: nil)
        action?()
    }

    #if DEBUG
    /// Tests: how many events wait.
    var count: Int { lock.withLock { waiting.count } }
    #endif
}

/// Cancels the connection's worker when the stream that reads it is gone (iteration ended without a cancel).
final class BrowserStreamLifetime: Sendable {
    private let worker: Task<Void, Never>

    init(_ worker: Task<Void, Never>) { self.worker = worker }

    deinit { worker.cancel() }
}
