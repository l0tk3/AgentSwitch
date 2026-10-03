import AgentSwitchMacCore
import SwiftUI

/// History's search (control-v0 §4; the phone's TaskSearch): the Mac searches the whole history — requests, results,
/// errors, summaries. Typing waits 250 ms before asking; a daemon without `/search` (404) is searched through its newest
/// tasks instead, and says so.
@MainActor
@Observable
final class HistorySearch {
    private(set) var results: [DispatchSearchResult] = []
    private(set) var searching = false
    private(set) var problem: String?
    /// The results came from the newest tasks, not the whole history.
    private(set) var local = false
    private var ran = ""
    /// Counts the runs: only the newest one says when searching is over.
    private var generation = 0

    static let debounce: Duration = .milliseconds(250)

    func isActive(_ query: String) -> Bool { !Self.trimmed(query).isEmpty }

    /// Called on every change of the field (`.task(id:)` cancels the previous run: that is the debounce).
    func run(_ query: String, _ service: any DispatchService) async {
        generation += 1
        let run = generation
        // However this run ends — cancelled in the debounce too — searching stops with it, unless a newer one runs.
        defer { if generation == run { searching = false } }
        let q = Self.trimmed(query)
        guard !q.isEmpty else {
            (results, problem, ran) = ([], nil, "")
            return
        }
        guard q != ran else { return }
        searching = true
        try? await Task.sleep(for: Self.debounce)
        guard !Task.isCancelled else { return }
        do {
            show(try await service.search(query: q), for: q, local: false)
        } catch DaemonError.notSupported {
            show(DispatchSearchSnippet.local((try? await service.tasks()) ?? [], query: q), for: q, local: true)
        } catch is CancellationError {
            return
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }

    private func show(_ found: [DispatchSearchResult], for query: String, local: Bool) {
        (results, problem, ran, self.local) = (found, nil, query, local)
    }

    private static func trimmed(_ query: String) -> String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The hits, newest first as the Mac returns them: state, title and time, then the snippet with the matches marked.
struct HistorySearchResults: View {
    let search: HistorySearch
    let open: (String) -> Void

    var body: some View {
        Section {
            if let problem = search.problem {
                SettingsProblemLine(text: problem)
            } else if search.results.isEmpty {
                if search.searching {
                    HStack(spacing: 8) { BrailleSpinner(); Text("Searching").mono(12).foregroundStyle(.secondary) }
                } else {
                    Text("No Results").foregroundStyle(.secondary)
                }
            }
            ForEach(search.results) { result in
                Button { open(result.taskId) } label: { HistoryResultRow(result: result) }
                    .buttonStyle(.plain)
                    .help("Open Task")
            }
        } header: {
            SectionLabel("Results")
        } footer: {
            if search.local { Footer("此 Mac 的服务不支持搜索全部记录，仅搜索最近的任务。") }
        }
    }
}

private struct HistoryResultRow: View {
    let result: DispatchSearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                StatusMark(level: result.status.level)
                Text(result.status.label).mono(11.5).foregroundStyle(result.status.level.color)
                Text(DispatchMessageDisplay.readable(result.title)).fontWeight(.medium).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(TimeText.moment(result.updated)).mono(11.5).foregroundStyle(.secondary).fixedSize()
            }
            if !result.snippet.isEmpty {
                Text(Self.highlighted(result.snippet)).font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    /// The ⟦⟧ marks dropped; what they enclosed in the primary colour, bold, on a faint signal ground (the demo's `.hit`).
    static func highlighted(_ snippet: String) -> AttributedString {
        DispatchSearchSnippet.parts(snippet).reduce(into: AttributedString()) { out, part in
            var piece = AttributedString(part.text)
            if part.hit {
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.foregroundColor = .primary
                piece.backgroundColor = Color.signal.opacity(0.28)
            }
            out += piece
        }
    }
}
