import AgentSwitchKit
import Foundation
import Observation

/// A session's record on the phone (docs/simple-view-v0.md §2, §4): the latest page, the earlier ones the user asked
/// for, the agent's own task list, how full its context is and the mode it last named. Read again when the Mac says
/// the record changed, and on a timer as a fallback (OpenCode, an older Mac).
@MainActor
@Observable
final class SessionRecordModel {
    private(set) var items: [RecordItem] = []
    private(set) var plan: [PlanEntry] = []
    private(set) var usage: RecordUsage?
    private(set) var mode: String?
    private(set) var session: SessionSummary?
    /// There is more before what is shown.
    private(set) var more = false
    /// Read at least once (an empty record is then really empty).
    private(set) var loaded = false
    private(set) var loadingEarlier = false
    var error: String?
    @ObservationIgnored private var cursor: Int64 = 0
    @ObservationIgnored private var harness = ""
    @ObservationIgnored private var sessionId: String?
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var again = false

    /// Which session this is the record of. A terminal just started has none until its agent says; one that changes
    /// (a `/clear`, a fork) starts the record over.
    func follow(harness: String, session: String?) {
        guard harness != self.harness || session != sessionId else { return }
        self.harness = harness
        sessionId = session
        items = []
        plan = []
        usage = nil
        mode = nil
        self.session = nil
        more = false
        cursor = 0
        loaded = session == nil
        error = nil
    }

    var hasSession: Bool { sessionId != nil }

    /// The latest page. Asked for again while one is on its way, it is read once more after that one.
    func refresh(_ api: AgentSwitchAPI?) async {
        guard let id = sessionId else { return }
        if reading { again = true; return }
        reading = true
        defer { reading = false }
        repeat {
            again = false
            guard let api else {
                #if DEBUG
                take(DemoData.sessionRecord(harness: harness, id: id))
                #endif
                return
            }
            do {
                let page = try await api.sessionRecord(harness: harness, id: id)
                guard id == sessionId else { return }
                take(page)
                error = nil
            } catch APIError.http(status: 404, message: _) {
                // Not listed yet (a session seconds old), or gone.
                loaded = true
            } catch is CancellationError {
                return
            } catch {
                if !loaded { self.error = error.localizedDescription }
            }
        } while again
    }

    /// The page before the earliest shown.
    func earlier(_ api: AgentSwitchAPI?) async {
        guard let api, let id = sessionId, more, !loadingEarlier else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let page = try await api.sessionRecord(harness: harness, id: id, limit: 80, before: cursor)
            guard id == sessionId else { return }
            let known = Set(items.map(\.id))
            items = page.items.filter { !known.contains($0.id) } + items
            cursor = page.cursor
            more = page.more
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The latest page over what is held: earlier pages stay, the page's own stretch is replaced (its last run of work
    /// may have grown, a queued message may have been read).
    private func take(_ page: SessionRecord) {
        session = page.session
        plan = page.plan
        usage = page.usage
        mode = page.mode
        defer { loaded = true }
        guard let first = page.items.first?.offset, let earliest = items.first?.offset, earliest < first,
              let last = items.last(where: { $0.offset != nil })?.offset, last >= first else {
            // Nothing earlier held (or a gap, or a record without places in a file): the page is the record.
            items = page.items
            cursor = page.cursor
            more = page.more
            return
        }
        items = items.filter { ($0.offset ?? .max) < first } + page.items
    }
}
