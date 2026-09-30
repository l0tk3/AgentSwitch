import Foundation

/// The phone's cue tones (ios-app Feedback.swift), for the Mac: sine tones with a 6 ms fade at each edge, quiet enough
/// to sit under other audio, as a 16-bit mono WAV that NSSound plays.
public enum Tones {
    /// (frequency in Hz — 0 is a pause, milliseconds): something needs you.
    public static let needsYou: [(Double, Double)] = [(880, 110), (0, 60), (880, 110), (0, 60), (1175, 170)]
    /// A result: rising.
    public static let done: [(Double, Double)] = [(523, 90), (659, 90), (784, 170)]
    /// A failure: falling.
    public static let failed: [(Double, Double)] = [(440, 150), (330, 230)]

    public static func wav(_ tones: [(Double, Double)], rate: Double = 44_100) -> Data {
        var samples: [Int16] = []
        let fade = rate * 0.006
        for (frequency, ms) in tones {
            let count = Int(rate * ms / 1000)
            for i in 0..<count {
                let envelope = min(1, min(Double(i), Double(count - i)) / fade)
                let value = frequency == 0 ? 0 : 0.22 * envelope * sin(2 * .pi * frequency * Double(i) / rate)
                samples.append(Int16(value * Double(Int16.max)))
            }
        }
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put(36 + bytes)
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(rate)); put(UInt32(rate) * 2); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(bytes)
        for sample in samples { put(sample) }
        return data
    }
}
