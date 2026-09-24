#if os(macOS)
import Foundation

/// Runs a local helper process (openssl, the Python gate) for the macOS-only integration tests.
struct ProcessResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

enum Proc {
    @discardableResult
    static func run(_ executable: String, _ args: [String], env: [String: String] = [:], stdin: Data? = nil) throws -> ProcessResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        p.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        let out = Pipe(), err = Pipe(), input = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = input
        try p.run()
        if let stdin { input.fileHandleForWriting.write(stdin) }
        try input.fileHandleForWriting.close()
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return ProcessResult(status: p.terminationStatus, stdout: String(decoding: outData, as: UTF8.self),
                             stderr: String(decoding: errData, as: UTF8.self))
    }

    static func temporaryDirectory(_ prefix: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// packages/ios-app, from this file's location.
    static var packageRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
}
#endif
