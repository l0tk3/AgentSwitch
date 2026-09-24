import AVFoundation
import SwiftUI

/// Which system voice reads (app-v0 §5 朗读). iOS ships compact voices that sound stiff; the enhanced and premium
/// ones sound far more natural but have to be downloaded once in Settings › Accessibility › Spoken Content › Voices.
/// The user's pick is kept; without one the best installed Mandarin voice is used.
enum SpeechVoices {
    static let language = "zh-CN"
    static let sampleText = "你好，这是 AgentSwitch 的朗读试听。任务完成后，我会用这个声音把结果念给你听。"
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
                                Image(systemName: chosen == voice.identifier ? "checkmark.circle.fill" : "circle")
                                Text(voice.name)
                                Text(SpeechVoices.qualityLabel(voice)).font(.caption)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(voice.quality == .default ? Color.gray.opacity(0.15) : Color.green.opacity(0.18), in: Capsule())
                            }
                        }
                        .buttonStyle(.plain)
                        Spacer()
                        Button { model.speaker.sample(voice) } label: { Image(systemName: "play.circle") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("试听 \(voice.name)")
                    }
                }
            } footer: {
                Text("点一个声音选中并试听。")
            }
            Section {
                if SpeechVoices.onlyCompact {
                    Label("现在只有基础声音，听起来比较生硬。", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                Text("更自然的声音要先下载：打开 设置 › 辅助功能 › 朗读内容 › 声音 › 中文（中国大陆），选一个标着「增强」或「高音质」的声音下载，回到这里就能选。")
                    .font(.footnote)
            } header: {
                Text("更好的声音")
            }
        }
        .navigationTitle("朗读声音")
        .onAppear { voices = SpeechVoices.installed() }   // a voice downloaded meanwhile shows up
        .onDisappear { model.speaker.stop() }
    }
}
