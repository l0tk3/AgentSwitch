import AgentSwitchMacCore
import Foundation
import Observation

/// The step the conversation's text is set at (`TextSize`), this Mac's own. Read wherever a size is worked out — a
/// view that reads it while it draws is drawn again when it changes — and set from 设置 › General.
@Observable
final class TextScale: @unchecked Sendable {
    static let shared = TextScale()

    private(set) var step: Int

    init(defaults: UserDefaults = .standard) {
        step = TextSize.clamp(defaults.integer(forKey: TextSize.key))
    }

    func set(_ step: Int, defaults: UserDefaults = .standard) {
        let step = TextSize.clamp(step)
        guard step != self.step else { return }
        self.step = step
        defaults.set(step, forKey: TextSize.key)
    }
}
