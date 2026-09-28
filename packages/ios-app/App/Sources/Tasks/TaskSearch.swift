import AgentSwitchKit
import SwiftUI

/// Search in 任务记录 (control-v0 §4): the Mac searches the whole history (task text, results, errors, summaries,
/// session titles, what the executors wrote). A Mac without `/search` (404), and the demo screens, search the tasks
/// the phone already has instead.
@MainActor
@Observable
final class TaskSearch {
    private(set) var results: [SearchResult] = []
    private(set) var searching = false
    private(set) var error: String?
    /// The results came from the phone's own list, not the Mac.
    private(set) var local = false
    private var ran = ""

    static let debounce: Duration = .milliseconds(300)

    func isActive(_ query: String) -> Bool { !Self.trimmed(query).isEmpty }

    /// Called on every change of the field (`.task(id:)` cancels the previous run, which is the debounce).
    func run(_ query: String, _ model: AppModel) async {
        let q = Self.trimmed(query)
        guard !q.isEmpty else {
            (results, error, searching, ran) = ([], nil, false, "")
            return
        }
        guard q != ran else { return }
        searching = true
        try? await Task.sleep(for: Self.debounce)
        guard !Task.isCancelled else { return }
        defer { searching = false }
        guard let api = model.api else { return show(SearchSnippet.local(model.tasks, query: q), for: q, local: true) }
        do {
            show(try await api.search(query: q), for: q, local: false)
        } catch APIError.http(status: 404, message: _) {
            show(SearchSnippet.local(model.tasks, query: q), for: q, local: true)
        } catch is CancellationError {
            return
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    private func show(_ found: [SearchResult], for query: String, local: Bool) {
        (results, error, ran, self.local) = (found, nil, query, local)
    }

    private static func trimmed(_ query: String) -> String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The hits, newest first as the Mac returns them: title, the snippet with the matches in bold, state and time.
struct TaskSearchResults: View {
    let search: TaskSearch

    var body: some View {
        if let error = search.error {
            Text(error).font(.footnote).foregroundStyle(Theme.failed)
        } else if search.results.isEmpty {
            if search.searching {
                HStack { Spacer(); BrailleSpinner(color: .secondary); Spacer() }
            } else {
                ContentUnavailableView.search
            }
        } else {
            Section {
                ForEach(search.results) { result in
                    NavigationLink(value: result.taskId) { SearchResultRow(result: result) }
                }
            } footer: {
                if search.local { Text("此 Mac 不支持搜索全部记录，仅搜索 iPhone 上已加载的任务。") }
            }
        }
    }
}

private struct SearchResultRow: View {
    let result: SearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                StatusMark(status: result.status)
                Text(result.status.label).foregroundStyle(Theme.color(result.status)).fontWeight(.medium)
                Spacer()
                Text(result.updated.relative).foregroundStyle(.secondary)
            }
            .mono(11)
            Text(MessageDisplay.readable(result.title)).font(.subheadline.weight(.semibold)).lineLimit(1)
            if !result.snippet.isEmpty {
                Text(Self.highlighted(result.snippet)).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    /// The ⟦⟧ marks dropped, what they enclosed in bold and in the primary colour.
    static func highlighted(_ snippet: String) -> AttributedString {
        SearchSnippet.parts(snippet).reduce(into: AttributedString()) { out, part in
            var piece = AttributedString(part.text)
            if part.hit {
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.foregroundColor = .primary
            }
            out += piece
        }
    }
}
