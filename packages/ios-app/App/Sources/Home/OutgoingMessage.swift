import AgentSwitchKit
import Foundation

/// A message on its way to the assistant (assistant-v0 §1.1): shown as a bubble until the Mac's answer arrives. It keeps
/// its client id, files and pin, so a resend is the same message to the Mac, answered once, never a second task.
struct OutgoingMessage: Identifiable {
    let clientId: String
    let text: String
    let attachments: [PendingAttachment]
    let pin: TargetRef?
    /// Upload ids once the files are on the Mac; a resend does not upload them again.
    var staged: [String]?
    /// Why the last attempt did not get an answer; nil while sending.
    var failure: String?

    var id: String { clientId }

    init(text: String, attachments: [PendingAttachment], pin: TargetRef?, clientId: String = Conversation.newClientId()) {
        self.clientId = clientId
        self.text = text
        self.attachments = attachments
        self.pin = pin
    }

    func staging(_ ids: [String]) -> OutgoingMessage {
        var copy = self
        copy.staged = ids
        return copy
    }

    func failing(_ reason: String?) -> OutgoingMessage {
        var copy = self
        copy.failure = reason
        return copy
    }
}
