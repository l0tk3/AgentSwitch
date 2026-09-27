import AgentSwitchKit
import SwiftUI

/// Onboarding until a Mac is paired, then the home screen; the Face ID cover sits on top of both when enabled.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppLock.self) private var lock

    var body: some View {
        // Only web links open from model output (Markdown.inline also drops other schemes): an agentswitch:// link
        // in a result must not start pairing with a Mac someone else chose.
        content.environment(\.openURL, OpenURLAction { url in Markdown.isWebLink(url) ? .systemAction : .discarded })
    }

    @ViewBuilder
    private var content: some View {
        // Locked: the app's views are not in the hierarchy at all, so no sheet, dialog or pushed page they presented
        // can stay on top of the lock (a ZStack cover sits below sheets).
        if lock.locked {
            LockView()
        } else {
            Group {
                if model.isPaired {
                    HomeView()
                } else {
                    OnboardingView()
                }
            }
            .sheet(item: Binding(get: { model.incomingPairingLink.map(PendingLink.init) },
                                 set: { model.incomingPairingLink = $0?.text })) { pending in
                PairConfirmView(link: pending.text)
            }
        }
    }
}

private struct PendingLink: Identifiable {
    let text: String
    var id: String { text }
}

/// Full-screen cover while the app is locked.
struct LockView: View {
    @Environment(AppLock.self) private var lock

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.fill").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("AgentSwitch 已锁定").font(.title3.bold())
            Button("用 \(lock.biometryName) 解锁") { Task { await lock.unlock() } }
                .buttonStyle(.borderedProminent).tint(Theme.fill)
            if let error = lock.lastError {
                Text(error).font(.footnote).foregroundStyle(Theme.failed).multilineTextAlignment(.center)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .task { await lock.unlock() }
    }
}

#Preview("Home") {
    RootView().environment(AppModel.preview()).environment(AppLock())
}
