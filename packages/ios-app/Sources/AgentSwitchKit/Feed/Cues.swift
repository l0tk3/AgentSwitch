import Foundation

/// The moment the phone gives a sound, a tap and (in voice mode) a spoken line (assistant-v0 §3): a terminal newly
/// waits for you.
public enum Cue: String, Sendable, Equatable, CaseIterable {
    case needsYou
}
