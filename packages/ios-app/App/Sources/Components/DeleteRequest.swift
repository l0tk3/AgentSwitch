import AgentSwitchKit
import SwiftUI

/// What a delete button removes: one task (its log, files and resume state) or a whole thread with all its tasks.
/// Every delete is confirmed first; the Mac refuses (409) while something in it still runs.
enum DeleteRequest: Identifiable {
    case task(AgentTask)
    case thread(id: String, title: String?)

    var id: String {
        switch self {
        case .task(let task): return "task:\(task.id)"
        case .thread(let id, _): return "thread:\(id)"
        }
    }

    var question: String {
        switch self {
        case .task: return "删除此任务？"
        case .thread(_, let title): return "删除会话「\(title ?? "未命名会话")」？"
        }
    }

    var action: String {
        switch self {
        case .task: return "删除任务"
        case .thread: return "删除会话和其中所有任务"
        }
    }

    var detail: String {
        switch self {
        case .task: return "任务的记录和文件将一并删除，且无法恢复。"
        case .thread: return "会话中所有任务的记录和文件将一并删除，且无法恢复。"
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
