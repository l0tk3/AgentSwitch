import Foundation

/// Swapping in a new AgentSwitch.app (assistant-v0 §5). A build is staged next to the running bundle
/// (`<dir>/next/AgentSwitch.app`, where `APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh` puts it). The user
/// confirms in the menu, or on the phone (the daemon then leaves `update-request.json` in its home). The running app
/// stops its children, swaps the bundles, starts the new one and waits, hidden, for its daemon to answer `/healthz`;
/// if it does not in time, the old app stops it, keeps it as `failed-AgentSwitch.app` for a look, puts itself back and
/// starts again. Either way it writes `update-result.json` for the daemon to tell the conversation.
public enum AppUpdate {
    public static let stagedDir = "next"
    public static let bundleName = "AgentSwitch.app"
    public static let previousName = "prev-AgentSwitch.app"
    public static let failedName = "failed-AgentSwitch.app"
    public static let requestFile = "update-request.json"
    public static let resultFile = "update-result.json"
    /// Seconds the new bundle has to answer: first start of a new runtime, model discovery included.
    public static let healthWait = 150

    public static func staged(nextTo app: URL) -> URL {
        app.deletingLastPathComponent().appendingPathComponent(stagedDir).appendingPathComponent(bundleName)
    }

    /// `built=` of a bundle's runtime/VERSIONS (an ISO time from build-app.sh), or nil.
    public static func built(_ app: URL) -> String? {
        let versions = app.appendingPathComponent("Contents/Resources/runtime/VERSIONS")
        guard let text = try? String(contentsOf: versions, encoding: .utf8) else { return nil }
        return text.split(separator: "\n").first { $0.hasPrefix("built=") }.map { String($0.dropFirst("built=".count)) }
    }

    /// The build time of a staged bundle built after the running one, or nil when there is none to offer.
    public static func newerStaged(than app: URL) -> String? {
        guard let next = built(staged(nextTo: app)) else { return nil }
        guard let current = built(app) else { return next }
        return next > current ? next : nil
    }

    /// Seconds to wait for the folder check: longer means macOS is showing a permission prompt nobody answered.
    public static let accessWait: TimeInterval = 15

    /// Whether this app may do what the switch does, nil when it may: write in the folder its bundle is in (on the
    /// Desktop, in Documents or Downloads macOS asks first: "Files and Folders"), and move app bundles (macOS asks
    /// first: "App Management"). Until someone answers on the Mac, macOS just holds the file operation: found on
    /// 2026-09-25, when the switch hung in `rm -rf prev-AgentSwitch.app` with the services already stopped. So each
    /// bundle involved is renamed and renamed back here, off the main thread, while everything still runs; a missing
    /// permission leaves the app as it is and says why.
    public static func folderAccessProblem(app: URL, wait: TimeInterval = accessWait) async -> String? {
        let dir = app.deletingLastPathComponent()
        let bundles = [dir.appendingPathComponent(previousName), staged(nextTo: app), app]
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        let answer = await offMain(wait: wait) {
            let probe = dir.appendingPathComponent(".agentswitch-update-probe")
            try Data().write(to: probe)
            try FileManager.default.removeItem(at: probe)
            for bundle in bundles {
                let aside = bundle.deletingLastPathComponent().appendingPathComponent(".probe-" + bundle.lastPathComponent)
                try FileManager.default.moveItem(at: bundle, to: aside)
                try FileManager.default.moveItem(at: aside, to: bundle)
            }
        }
        switch answer {
        case .done: return nil
        case .failed(let error):
            return "AgentSwitch 无法修改 \(dir.path) 中的 App：\(error.localizedDescription)。请在「系统设置 › 隐私与安全性」的「App 管理」和「文件和文件夹」中允许 AgentSwitch。"
        case .timedOut:
            return "macOS 正在等待授权，AgentSwitch 暂时无法修改 App。请在 Mac 上允许（「系统设置 › 隐私与安全性 › App 管理」；App 位于桌面、文稿或下载文件夹时，还需允许「文件和文件夹」），然后重新安装。"
        }
    }

    public enum Answer: Sendable { case done, failed(Error), timedOut }

    /// `work` on a thread of its own, waited for at most `wait` s. A file operation macOS holds for a permission
    /// cannot be cancelled: past the wait it is left to finish whenever someone answers.
    public static func offMain(wait: TimeInterval, _ work: @escaping @Sendable () throws -> Void) async -> Answer {
        let answer = OnceAnswer()
        return await withCheckedContinuation { continuation in
            answer.set(continuation)
            Thread.detachNewThread {
                do { try work(); answer.resume(.done) } catch { answer.resume(.failed(error)) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + wait) { answer.resume(.timedOut) }
        }
    }

    /// Moves the staged bundle in; the running one becomes prev-AgentSwitch.app (an older one there goes). Done by the
    /// running app itself: macOS lets it touch its folder, while a helper script left behind after the app quit was
    /// held by the privacy checks (2026-09-25). A failure half-way puts the running bundle back where it was.
    /// `proceed` is asked before each move: a step macOS held past the deadline must not go on to move bundles once the
    /// app has given up and started the old copy again.
    public static func swapIn(app: URL, proceed: @Sendable () -> Bool = { true }) throws {
        let fm = FileManager.default
        let dir = app.deletingLastPathComponent()
        let previous = dir.appendingPathComponent(previousName)
        let staged = staged(nextTo: app)
        if fm.fileExists(atPath: previous.path) { try fm.removeItem(at: previous) }
        guard proceed() else { throw CocoaError(.userCancelled) }
        try fm.moveItem(at: app, to: previous)
        do {
            try fm.moveItem(at: staged, to: app)
        } catch {
            try? fm.moveItem(at: previous, to: app)
            throw error
        }
        try? fm.removeItem(at: staged.deletingLastPathComponent())
        refreshIcon(app)
    }

    /// The Dock and Finder keep the old bundle's icon for the same path (2026-09-29: the new icon did not show after an
    /// update): the bundle is marked changed and registered again, so the icon is read afresh.
    static func refreshIcon(_ app: URL) {
        let now = Date()
        for url in [app, app.appendingPathComponent("Contents"), app.appendingPathComponent("Contents/Info.plist")] {
            try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
        }
        _ = LSRegisterURL(app as CFURL, true)
    }

    /// The previous bundle back in place; the one that did not start is kept as failed-AgentSwitch.app for a look.
    public static func swapBack(app: URL, proceed: @Sendable () -> Bool = { true }) throws {
        let fm = FileManager.default
        let dir = app.deletingLastPathComponent()
        let failed = dir.appendingPathComponent(failedName)
        if fm.fileExists(atPath: failed.path) { try fm.removeItem(at: failed) }
        guard proceed() else { throw CocoaError(.userCancelled) }
        try fm.moveItem(at: app, to: failed)
        try fm.moveItem(at: dir.appendingPathComponent(previousName), to: app)
    }

    /// `update-result.json` for the daemon, which tells the conversation how the switch went.
    public static func result(ok: Bool, reverted: Bool, from: String?, to: String?, reason: String, at: Date = Date()) -> Data {
        let object: [String: Any] = ["ok": ok, "reverted": reverted, "from": from ?? "", "to": to ?? "", "at": Int(at.timeIntervalSince1970 * 1000), "reason": reason]
        return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }
}

/// Resumes a continuation once, from whichever thread answers first.
private final class OnceAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<AppUpdate.Answer, Never>?

    func set(_ c: CheckedContinuation<AppUpdate.Answer, Never>) {
        lock.lock(); continuation = c; lock.unlock()
    }

    func resume(_ value: AppUpdate.Answer) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: value)
    }
}

/// Set once when the app stops waiting for a step; the step reads it before going on.
public final class GiveUp: @unchecked Sendable {
    private let lock = NSLock()
    private var given = false

    public init() {}

    public func now() { lock.lock(); given = true; lock.unlock() }
    public var proceed: Bool { lock.lock(); defer { lock.unlock() }; return !given }
}
