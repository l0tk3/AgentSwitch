import AgentSwitchMacCore
import SwiftUI

/// The old dispatch (the Dispatch page, its tasks, threads and assistant, its settings, the answers to its tasks) is
/// switched off, not deleted (2026-11-24, owner's decision): a new dispatch built on Chat Rooms replaces it. The service
/// refuses its requests with 410 `old_dispatch_off`. Every way into it in the Mac app reads `OldDispatch.off`: set it
/// to `false` and all of it is back as it was.
enum OldDispatch {
    /// The one switch.
    static let off = true

    /// The short title of what stands where a page of it would be.
    static let title = "Dispatch Off"
    /// The help on what is greyed out, and the sentence under the title.
    static let note = "旧调度已停用，新调度测试中。"

    /// The main window may go to `page` (the Dispatch page is not gone to while it is off).
    static func reachable(_ page: MainPage) -> Bool { !(off && page == .dispatch) }

    /// The page the main window opens on: the one kept, unless that is Dispatch while it is off (Terminals then).
    static func landing(_ page: MainPage) -> MainPage { reachable(page) ? page : .terminals }

    /// The next (or previous) page the window may go to, from `page` (⌃⇥, ⌃⇧⇥): Dispatch skipped while it is off.
    static func step(from page: MainPage, forward: Bool) -> MainPage {
        var next = forward ? page.next : page.previous
        while !reachable(next) && next != page { next = forward ? next.next : next.previous }
        return next
    }
}

/// Where a whole page of the old dispatch would show: `Dispatch Off` and the sentence, in the middle.
struct OldDispatchPlaceholder: View {
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 8) {
            Text(OldDispatch.title)
                .font(look.isClassic ? .system(size: 15, weight: .semibold) : .system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(Look.ink2)
                .mask { if look.isClassic { Rectangle() } else { Checker(color: .black) } }
            Text(OldDispatch.note)
                .font(.system(size: 13))
                .foregroundStyle(Look.ink2)
        }
        .multilineTextAlignment(.center)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension View {
    /// Greyed out as the old dispatch is while it is off (`off`): dithered to half in the pixel look (ui-v0 §7.2.8), faint
    /// in the classic one; not clickable; the sentence as its help.
    @ViewBuilder func oldDispatchOff(_ off: Bool = OldDispatch.off) -> some View {
        if off { modifier(OldDispatchOff()) } else { self }
    }
}

private struct OldDispatchOff: ViewModifier {
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        content
            .disabled(true)
            .mask { if look.isClassic { Rectangle().opacity(0.4) } else { Checker(color: .black) } }
            .help(OldDispatch.note)
    }
}
