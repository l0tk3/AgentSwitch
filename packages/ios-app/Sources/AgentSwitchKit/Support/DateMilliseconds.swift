import Foundation

/// The Mac's times are milliseconds since 1970.
extension Date {
    init(milliseconds: Int64) { self.init(timeIntervalSince1970: TimeInterval(milliseconds) / 1000) }
}
