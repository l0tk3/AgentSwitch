import AVFoundation
import SwiftUI

/// Which system voice reads (app-v0 §5 朗读). iOS ships compact voices that sound stiff; the enhanced and premium
/// ones sound far more natural but have to be downloaded once in Settings › Accessibility › Spoken Content › Voices.
/// The user's pick is kept; without one the best installed Mandarin voice is used.
enum SpeechVoices {
    static let language = "zh-CN"
    static let sampleText = "这是 AgentSwitch 的朗读声音。任务结束时，将使用此声音朗读结果。"
    private static let chosenKey = "speechVoiceIdentifier"

    /// Installed Mandarin voices, best first; novelty voices left out.
    static func installed() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == language && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
    }

    static var chosenIdentifier: String? {
        get { UserDefaults.standard.string(forKey: chosenKey) }
        set { UserDefaults.standard.set(newValue, forKey: chosenKey) }
    }

    /// The user's pick while it is still installed, else the best installed one, else the system default.
    static func chosen() -> AVSpeechSynthesisVoice? {
        if let id = chosenIdentifier, let voice = AVSpeechSynthesisVoice(identifier: id) { return voice }
        return installed().first ?? AVSpeechSynthesisVoice(language: language)
    }

    static func qualityLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: return "高音质"
        case .enhanced: return "增强"
        default: return "基础"
        }
    }

    /// True when only the stiff compact voices are installed.
    static var onlyCompact: Bool { !installed().contains { $0.quality != .default } }
}

/// 设置 › 朗读声音: the installed Mandarin voices with their quality, a sample of each, and where to get better ones.
struct SpeechVoiceView: View {
    @Environment(AppModel.self) private var model
    @State private var chosen = SpeechVoices.chosen()?.identifier
    @State private var voices = SpeechVoices.installed()

    var body: some View {
        List {
            Section {
                ForEach(voices, id: \.identifier) { voice in
                    HStack {
                        Button {
                            chosen = voice.identifier
                            SpeechVoices.chosenIdentifier = voice.identifier
                            model.speaker.sample(voice)
                        } label: {
                            HStack {
                                Text(chosen == voice.identifier ? "<x>" : "< >").mono(14)
                                Text(voice.name)
                                Text(SpeechVoices.qualityLabel(voice)).mono(11)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .foregroundStyle(.secondary)
                                    .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
                            }
                        }
                        .buttonStyle(.plain)
                        Spacer()
                        Button { model.speaker.sample(voice) } label: { Text("Play").mono(12) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("试听 \(voice.name)")
                    }
                }
            } footer: {
                Text("轻点声音以选择并试听。")
            }
            Section {
                if SpeechVoices.onlyCompact {
                    Text("当前仅安装了基础声音，朗读效果较为生硬。").foregroundStyle(Theme.waiting)
                }
                Text("前往 设置 › 辅助功能 › 朗读内容 › 声音 › 中文（中国大陆），下载标有「增强」或「高音质」的声音。")
                    .font(.footnote)
            } header: {
                SectionLabel("More Voices")
            }
        }
        .navigationTitle("Voice")
        .onAppear { voices = SpeechVoices.installed() }   // a voice downloaded meanwhile shows up
        .onDisappear { model.speaker.stop() }
    }
}
