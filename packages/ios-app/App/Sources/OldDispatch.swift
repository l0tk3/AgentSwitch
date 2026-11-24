import SwiftUI

/// The old dispatch (the Dispatch tab: the compose box the router routes to an executor, the assistant, task pages,
/// threads, task approvals and answers, the router's model) is disabled, not deleted (2026-11-24, the repo owner): the
/// new dispatch, built on Chat Rooms, takes its place. The Mac refuses the old one's writes with 410 `old_dispatch_off`.
///
/// Everything that leads into it is gated on `off`: the Dispatch tab shows the new dispatch instead of the
/// conversation — the room the Mac flags as the dispatch desk (调度台), `DispatchDeskTab` — links into a task land
/// there too, its settings rows are greyed out with `note` under them, the task list is no
/// longer polled (so no task cues, and the Live Activity follows the terminals only). Set `off` to false to bring it
/// all back as it was.
enum OldDispatch {
    static let off = true
    /// Said wherever an entry into the old dispatch is shown disabled.
    static let note = "旧调度已停用，新调度测试中。"
}

/// What the Dispatch tab showed while the old dispatch was off and before the new one (now `DispatchDeskTab`); kept
/// unused. The app's mark in its off state (dithered, §7.2.8), a short title
/// and the sentence.
struct DispatchOffView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                PixelMarkView(state: .off, pixel: 3)
                    .accessibilityHidden(true)
                Text("Dispatch Off").mono(15, weight: .semibold)
                Text(OldDispatch.note).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.base)
            .navigationTitle("Dispatch")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
