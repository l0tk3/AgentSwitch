import AVFoundation
import AgentSwitchKit
import SwiftUI
import UIKit

/// Sound and haptic feedback (assistant-v0 §3): the input box must feel received, handed on, finished — without
/// looking. Short synthesized tones, no audio files; they follow the silent switch unless the user chose otherwise
/// (or voice mode is on, which is for listening).
@MainActor
@Observable
final class FeedbackSettings {
    private let defaults = UserDefaults.standard

    var sound: Bool { didSet { defaults.set(sound, forKey: "feedbackSound") } }
    var haptics: Bool { didSet { defaults.set(haptics, forKey: "feedbackHaptics") } }
    var audibleInSilent: Bool { didSet { defaults.set(audibleInSilent, forKey: "feedbackAudibleInSilent") } }
    /// Reads aloud: the task's result when it ends, a question when one needs you, a short line when a task is taken.
    var voiceMode: Bool { didSet { defaults.set(voiceMode, forKey: "feedbackVoiceMode") } }

    init() {
        sound = defaults.object(forKey: "feedbackSound") as? Bool ?? true
        haptics = defaults.object(forKey: "feedbackHaptics") as? Bool ?? true
        audibleInSilent = defaults.bool(forKey: "feedbackAudibleInSilent")
        voiceMode = defaults.bool(forKey: "feedbackVoiceMode")
    }
}

@MainActor
final class Feedback {
    let settings = FeedbackSettings()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
    private var wired = false

    /// (frequency in Hz — 0 is a pause, milliseconds) per cue.
    static let tones: [Cue: [(Double, Double)]] = [
        .sent: [(880, 55)],
        .accepted: [(660, 70), (990, 95)],
        .needsYou: [(880, 110), (0, 60), (880, 110), (0, 60), (1175, 170)],
        .done: [(523, 90), (659, 90), (784, 170)],
        .failed: [(440, 150), (330, 230)],
    ]

    /// `speaking`: a voice is reading; the audio session is left as the speaker set it.
    func play(_ cue: Cue, speaking: Bool = false) {
        if settings.haptics { haptic(cue) }
        guard settings.sound, let tones = Self.tones[cue] else { return }
        if !speaking {
            let loud = settings.audibleInSilent || settings.voiceMode
            try? AVAudioSession.sharedInstance().setCategory(loud ? .playback : .ambient, options: [.mixWithOthers])
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        if !wired {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            wired = true
        }
        if !engine.isRunning { try? engine.start() }
        guard engine.isRunning, let buffer = buffer(tones) else { return }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !player.isPlaying { player.play() }
    }

    private func haptic(_ cue: Cue) {
        switch cue {
        case .sent: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .accepted, .done: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .needsYou: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .failed: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// Sine tones with a 6 ms fade at each edge (no clicks), quiet enough to sit under other audio.
    private func buffer(_ tones: [(Double, Double)]) -> AVAudioPCMBuffer? {
        let rate = format.sampleRate
        let frames = tones.reduce(0) { $0 + Int(rate * $1.1 / 1000) }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let samples = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        let fade = rate * 0.006
        var offset = 0
        for (frequency, ms) in tones {
            let count = Int(rate * ms / 1000)
            for i in 0..<count {
                let edge = min(Double(i), Double(count - i)) / fade
                let envelope = min(1, edge)
                samples[offset + i] = frequency == 0 ? 0 : Float(0.22 * envelope * sin(2 * .pi * frequency * Double(i) / rate))
            }
            offset += count
        }
        return buffer
    }
}
