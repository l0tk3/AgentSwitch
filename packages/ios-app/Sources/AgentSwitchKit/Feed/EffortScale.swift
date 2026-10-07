import Foundation

/// How hard an agent thinks as a place on a line (the effort slider, docs/terminal-v0.md §1 思考强度): the levels a
/// model takes are its stops, lowest first, the first at the line's start and the last at its end.
public enum EffortScale {
    /// Where `level` is among `levels`; nil when it is none of them (none chosen, or a level the model does not take).
    public static func index(of level: String?, in levels: [String]) -> Int? {
        level.flatMap { levels.firstIndex(of: $0) }
    }

    /// The stop nearest to `x` on a line `width` long with `count` stops.
    public static func stop(at x: Double, width: Double, count: Int) -> Int {
        guard count > 1, width > 0 else { return 0 }
        return min(max(Int((x / width * Double(count - 1)).rounded()), 0), count - 1)
    }

    /// Where stop `index` is on that line.
    public static func place(of index: Int, width: Double, count: Int) -> Double {
        count > 1 ? width * Double(min(max(index, 0), count - 1)) / Double(count - 1) : 0
    }

    /// How lively the line is at stop `index`: still at the lowest, all of it at the highest.
    public static func heat(_ index: Int, count: Int) -> Double {
        count > 1 ? Double(min(max(index, 0), count - 1)) / Double(count - 1) : 0
    }

    /// The stop a step to the left or right of `index` lands on (nil: none chosen — the first step chooses `start`).
    public static func step(from index: Int?, by delta: Int, start: Int?, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let index else { return min(max(start ?? 0, 0), count - 1) }
        return min(max(index + delta, 0), count - 1)
    }
}
