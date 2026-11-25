import AgentSwitchKit
import SwiftUI

/// What you said, on the right, in a raised square box (the signal colour is not for text backgrounds), as you typed it
/// with its code drawn as code (TypedText). Ciphertexts show as a lock mark.
/// In the classic look a round bubble in the accent's colour (docs/ui-v0.md §8).
struct UserBubble: View {
    let text: String
    var attachments: Int = 0
    var faded = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: Theme.Space.xs) {
                // Ink on a quiet ground in both looks: the classic look's bubble is the raised grey, round (it was the
                // accent's colour with white text until 2026-10-07, docs/ui-v0.md §8).
                TypedText(text: MessageDisplay.readable(text))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, look.isClassic ? 9 : 10)
                    .grounded(Theme.raised, radius: Theme.Radius.bubble)
                    .framed(look.isClassic ? Color.clear : Theme.line, radius: Theme.Radius.bubble)
                    .textSelection(.enabled)
                    .opacity(faded ? 0.55 : 1)
                if attachments > 0 {
                    Text("\(attachments) attached").mono(11).foregroundStyle(.secondary)
                }
            }
        }
    }
}
