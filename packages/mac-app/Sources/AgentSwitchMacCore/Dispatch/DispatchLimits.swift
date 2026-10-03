import Foundation

/// The daemon's length limits on what is typed (its zod `.max()`), counted as it counts them: JavaScript's `length`,
/// UTF-16 units — a Chinese character is one, most emoji two — after the same trimming. Checked before sending, so a
/// refusal is said in the page's words instead of the daemon's.
public enum DispatchLimits {
    /// A message from the input (api/assistant.ts MAX_MESSAGE_CHARS).
    public static let message = 8000
    /// Each answer to a question (core/questions.ts MAX_ANSWER_LENGTH).
    public static let answer = 4000
    /// An MCP server's note for the dispatch model (extensions/types.ts MAX_NOTE_CHARS).
    public static let note = 500
    /// A topic's own title (api/threads.ts MAX_TITLE_CHARS).
    public static let topicTitle = 200

    /// The length the daemon measures.
    public static func length(_ text: String) -> Int { text.utf16.count }

    /// `8123 / 8000`, for a counter beside what is typed.
    public static func counter(_ text: String, limit: Int) -> String { "\(length(text)) / \(limit)" }

    /// A message trimmed as it is sent is over the limit: the daemon would refuse it.
    public static func messageTooLong(_ typed: String) -> Bool {
        length(typed.trimmingCharacters(in: .whitespacesAndNewlines)) > message
    }

    /// Why a topic's new title cannot be saved (trimmed as it is sent), or nil.
    public static func topicTitleProblem(_ title: String) -> String? {
        length(title.trimmingCharacters(in: .whitespacesAndNewlines)) > topicTitle ? "标题最多 \(topicTitle) 个字符。" : nil
    }
}
