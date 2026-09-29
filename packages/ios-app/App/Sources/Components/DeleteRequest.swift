import AgentSwitchKit
import SwiftUI

/// What a delete removes — only what the user sees (threads-v0 手动删除; ui-v0 §4: a thread is a "topic"): one entry
/// of the home screen (a message with its answers and the tasks they created, or one line on its own), one task, one
/// topic with all its tasks (from the topic page), or all history. Every delete is confirmed first; the Mac refuses
/// (409) while something in it still runs.
enum DeleteRequest: Identifiable {
    case entry(ConversationEntry)
    case task(AgentTask)
    case topic(id: String, title: String?)
    case history

    var id: String {
        switch self {
        case .entry(let entry): return "entry:\(entry.seq)"
        case .task(let task): return "task:\(task.id)"
        case .topic(let id, _): return "topic:\(id)"
        case .history: return "history"
        }
    }

    var question: String {
        switch self {
        case .entry(let entry): return entry.exchange ? "删除这段对话？" : "删除这条提示？"
        case .task: return "删除此任务？"
        case .topic(_, let title): return "删除话题「\(title ?? "未命名话题")」？"
        case .history: return "清空全部记录？"
        }
    }

    var action: String {
        switch self {
        case .entry(let entry): return entry.createdTaskIds.isEmpty ? "删除" : "删除对话和任务"
        case .task: return "删除任务"
        case .topic: return "删除话题和其中所有任务"
        case .history: return "清空记录"
        }
    }

    var detail: String {
        switch self {
        case .entry(let entry):
            if !entry.exchange { return "此提示将被删除，且无法恢复。" }
            return entry.createdTaskIds.isEmpty ? "你的话和助理的回答将被删除，且无法恢复。"
                : "你的话、助理的回答，以及由此创建的任务（结果和文件）将一并删除，且无法恢复。"
        case .task: return "任务的结果和文件，以及对话中关于它的内容将一并删除，且无法恢复。"
        case .topic: return "话题中所有任务的结果和文件，以及对话中关于它们的内容将一并删除，且无法恢复。"
        case .history: return "首页的对话和所有任务（结果、文件）将全部删除，且无法恢复。环境说明、密文、配对和终端不受影响。"
        }
    }

    /// 409 means something in it still runs; say what to do instead of the raw reply.
    static func message(for error: Error) -> String {
        if case APIError.http(status: 409, let message) = error {
            return "有任务正在进行或等你处理，暂无法删除。请取消任务，或等待任务结束后重试。" + (message.isEmpty ? "" : "（\(message)）")
        }
        return error.localizedDescription
    }
}

extension View {
    /// The one confirmation every delete button goes through; `done` gets what was deleted, after it was.
    func deleteConfirmation(_ request: Binding<DeleteRequest?>, error: Binding<String?>, done: @escaping (DeleteRequest) -> Void = { _ in }) -> some View {
        modifier(DeleteConfirmation(request: request, error: error, done: done))
    }
}

private struct DeleteConfirmation: ViewModifier {
    @Binding var request: DeleteRequest?
    @Binding var error: String?
    let done: (DeleteRequest) -> Void
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.confirmationDialog(request?.question ?? "", isPresented: presented, titleVisibility: .visible, presenting: request) { pending in
            Button(pending.action, role: .destructive) {
                Task {
                    if let problem = await model.delete(pending) { error = problem } else { error = nil; done(pending) }
                }
            }
        } message: { pending in
            Text(pending.detail)
        }
    }

    private var presented: Binding<Bool> {
        Binding(get: { request != nil }, set: { if !$0 { request = nil } })
    }
}
