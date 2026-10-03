import AVFoundation
import AgentSwitchMacCore
import Observation

/// `Read Aloud` (app-v0 §5, the phone's Speaker): an answer or a task's spoken summary read by the system's offline voice,
/// one at a time; the same button stops it. Everything read is cleaned first (DispatchSpeech: no ciphertext, link or
/// Markdown is read).
@MainActor
@Observable
final class DispatchSpeaker: NSObject, AVSpeechSynthesizerDelegate {
    /// What is being read (`m<seq>` for a message, a task's id), for the buttons' state.
    private(set) var speakingKey: String?
    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    /// The utterance now playing; a callback for an earlier one (stopped to start this) changes nothing.
    @ObservationIgnored private var current: ObjectIdentifier?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    static func key(_ message: DispatchMessage) -> String { "m\(message.seq)" }

    /// What to read for a task: its spoken script, else the one-line summary, else its state and the start of the result.
    static func script(for task: DispatchTask) -> String {
        if let written = [task.speech, task.spoken].compactMap({ $0 }).map(DispatchSpeech.speakable).first(where: { !$0.isEmpty }) {
            return written
        }
        let result = String(DispatchMarkdown.flattened(task.result ?? task.error ?? "").characters)
        let body = DispatchSpeech.speakable(String(result.prefix(200)))
        return body.isEmpty ? task.spokenStatus : "\(task.spokenStatus)。\(body)"
    }

    func isSpeaking(_ key: String) -> Bool { speakingKey == key }

    /// Reads `text` under `key`, or stops it when that is what is being read.
    func toggle(_ key: String, text: String) {
        if speakingKey == key { stop(); return }
        let line = DispatchSpeech.speakable(text)
        guard !line.isEmpty else { return }
        stop()
        let utterance = AVSpeechUtterance(string: line)
        utterance.voice = AVSpeechSynthesisVoice(language: Self.language(of: line))
        speakingKey = key
        current = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
    }

    func toggle(_ task: DispatchTask) { toggle(task.id, text: Self.script(for: task)) }

    func stop() {
        current = nil
        speakingKey = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }

    /// Chinese unless the text has no Chinese in it.
    static func language(of text: String) -> String {
        text.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? "zh-CN" : "en-US"
    }

    private func finished(_ utterance: ObjectIdentifier) {
        guard utterance == current else { return }
        current = nil
        speakingKey = nil
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finished(id) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finished(id) }
    }
}
