import AVFoundation
import AgentSwitchKit
import SwiftUI

/// 朗读 (app-v0 §5): a line read by the system's offline voice. One at a time. The `.playback` audio category lets it be heard with the ring/silent switch on silent.
@MainActor
@Observable
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    /// What is being read (a line's key).
    private(set) var speakingTaskId: String?
    private let synthesizer = AVSpeechSynthesizer()
    /// The utterance now playing; a callback for an earlier one (stopped to start this) changes nothing.
    private var current: ObjectIdentifier?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Voice mode (assistant-v0 §3): a short line — a question that needs you, "收到" — under `key`; it replaces what
    /// is being read. Cleaned like everything read aloud.
    func say(_ text: String, key: String) {
        let line = Speech.speakable(text)
        guard !line.isEmpty else { return }
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: line)
        utterance.voice = SpeechVoices.chosen()
        speakingTaskId = key
        current = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
    }

    var isSpeaking: Bool { speakingTaskId != nil }

    /// 试听 in Settings: a short sample in `voice`.
    func sample(_ voice: AVSpeechSynthesisVoice) {
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: SpeechVoices.sampleText)
        utterance.voice = voice
        current = ObjectIdentifier(utterance)
        synthesizer.speak(utterance)
    }

    func stop() {
        current = nil
        speakingTaskId = nil
        // The session is released in the cancel callback, once the audio has really stopped.
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) } else { release() }
    }

    private func finished(_ utterance: ObjectIdentifier) {
        if utterance == current {
            current = nil
            speakingTaskId = nil
        }
        if current == nil { release() }
    }

    /// Other apps' audio comes back to full volume (it was ducked while reading).
    private func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
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
