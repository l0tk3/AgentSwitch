import AgentSwitchMacCore
import Foundation

/// A file chosen for the next message (dragged in, `Files…`, `Paste Image`), waiting above the input.
struct PendingFile: Identifiable, Hashable {
    let id = UUID()
    let file: DispatchUploadFile
}

/// A message on its way (assistant-v0 §1.1; the phone's OutgoingMessage): shown as a faded box until the Mac answers. It
/// keeps its client id, files and pin, so a resend is the same message to the Mac, answered once, never a second task.
/// A value: every change returns a new one.
struct OutgoingMessage: Identifiable, Equatable {
    let message: DispatchNewMessage
    let files: [PendingFile]
    /// Upload ids once the files are on the Mac; a resend does not upload them again.
    let staged: [String]?
    /// Why the last attempt got no answer; nil while sending.
    let failure: String?

    var id: String { message.clientId }
    var text: String { message.text }

    init(message: DispatchNewMessage, files: [PendingFile], staged: [String]? = nil, failure: String? = nil) {
        self.message = message
        self.files = files
        self.staged = staged
        self.failure = failure
    }

    func staging(_ ids: [String]) -> OutgoingMessage {
        OutgoingMessage(message: message.staging(ids), files: files, staged: ids, failure: failure)
    }

    func failing(_ reason: String?) -> OutgoingMessage {
        OutgoingMessage(message: message, files: files, staged: staged, failure: reason)
    }

    /// What goes on the wire: the staged ids, or none when there were no files.
    var sendable: DispatchNewMessage { message.staging(staged ?? []) }
}

/// A token to put into the input at its cursor (`New Ciphertext`), once.
struct InsertRequest: Equatable {
    let id = UUID()
    let text: String
}

/// What a delete removes — only what is seen (threads-v0 手动删除; ui-v0 §4): one entry of the record (a message with
/// its answers and the tasks they created, or a line on its own), one task, or a topic with its tasks. Each is
/// confirmed first; the Mac refuses (409) while something in it runs.
enum DeleteRequest: Identifiable, Equatable {
    case entry(DispatchConversationEntry)
    case task(DispatchTask)
    case topic(id: String, title: String?)

    var id: String {
        switch self {
        case .entry(let entry): return "entry:\(entry.seq)"
        case .task(let task): return "task:\(task.id)"
        case .topic(let id, _): return "topic:\(id)"
        }
    }

    var question: String {
        switch self {
        case .entry(let entry): return entry.exchange ? "删除这段对话？" : "删除这条提示？"
        case .task: return "删除此任务？"
        case .topic(_, let title): return "删除话题「\(title ?? "未命名话题")」？"
        }
    }

    var action: String {
        switch self {
        case .entry(let entry): return entry.createdTaskIds.isEmpty ? "Delete" : "Delete with Tasks"
        case .task: return "Delete Task"
        case .topic: return "Delete Topic"
        }
    }

    var detail: String {
        switch self {
        case .entry(let entry):
            if !entry.exchange { return "此提示将被删除，且无法恢复。" }
            return entry.createdTaskIds.isEmpty ? "你的话和回答将被删除，且无法恢复。"
                : "你的话、回答，以及由此创建的任务（结果和文件）将一并删除，且无法恢复。"
        case .task: return "任务的结果和文件，以及记录中关于它的内容将一并删除，且无法恢复。"
        case .topic: return "话题中所有任务的结果和文件，以及记录中关于它们的内容将一并删除，且无法恢复。"
        }
    }

    /// 409: something in it still runs; what to do instead of the raw reply.
    static func message(for error: Error) -> String {
        if case DaemonError.http(status: 409, let message) = error {
            return "有任务正在进行或等你处理，暂无法删除。请取消任务，或等待任务结束后重试。" + (message.isEmpty ? "" : "（\(message)）")
        }
        return DispatchErrors.text(error)
    }
}

/// Errors as the page says them (formal Chinese, ui-v0 §4.1).
enum DispatchErrors {
    static func text(_ error: Error) -> String {
        if let daemon = error as? DaemonError {
            switch daemon {
            case .unreachable: return "无法连接服务。服务可能未运行，请稍后重试。"
            case .http(let status, let message) where (400..<500).contains(status): return message.isEmpty ? "请求被拒绝（\(status)）。" : message
            default: return daemon.errorDescription ?? "请求失败。"
            }
        }
        return error.localizedDescription
    }

    /// The service is not there: the bar already says `■ Service Down`, a poll says nothing more.
    static func isUnreachable(_ error: Error) -> Bool {
        if case DaemonError.unreachable = error { return true }
        return error is URLError
    }
}
