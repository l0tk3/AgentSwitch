import Foundation

/// Getting a release file onto the disk (docs/agents-v0.md §5, §7): one of the vendors' hosts over HTTPS, redirects
/// only to such hosts, progress as it comes, stopped when the task that asked is cancelled.
public enum AgentTransfer {
    /// `(from, to, progress)`: the file at `from` written to `to`; `progress` gets the bytes so far and the total when
    /// the server says it.
    public typealias Download = @Sendable (URL, URL, @escaping @Sendable (Int64, Int64?) -> Void) async throws -> Void

    public static let download: Download = { from, to, progress in
        guard AgentReleases.allowed(from) else { throw AgentError("不在允许的发布地址之内：\(from.host ?? from.absoluteString)") }
        let delegate = Delegate(destination: to, progress: progress)
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: from, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("AgentSwitch", forHTTPHeaderField: "User-Agent")
        let task = session.downloadTask(with: request)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                delegate.finish = { continuation.resume(with: $0) }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    /// The download's delegate: where a redirect may go, how far it is, and the file moved into place before the
    /// session takes its temporary copy away.
    private final class Delegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        let destination: URL
        let progress: @Sendable (Int64, Int64?) -> Void
        /// Set once before the task starts, called once.
        var finish: ((Result<Void, Error>) -> Void)?
        private let lock = NSLock()
        private var done = false
        private var moved: Result<Void, Error>?

        init(destination: URL, progress: @escaping @Sendable (Int64, Int64?) -> Void) {
            self.destination = destination
            self.progress = progress
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            // GitHub hands a release file on to its storage host: followed only to a host on the list.
            completionHandler(AgentReleases.allowed(request.url) ? request : nil)
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            guard let http = downloadTask.response as? HTTPURLResponse, http.statusCode == 200, AgentReleases.allowed(http.url) else {
                let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
                moved = .failure(AgentError(code == 404 ? "发布地址上没有这个文件。" : "下载未完成（HTTP \(code)）。"))
                return
            }
            do {
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: location, to: destination)
                moved = .success(())
            } catch {
                moved = .failure(AgentError("无法保存下载的文件：\(error.localizedDescription)"))
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            guard first else { return }
            if let error {
                let cancelled = (error as? URLError)?.code == .cancelled
                finish?(.failure(cancelled ? CancellationError() : AgentError("下载失败：\(error.localizedDescription)")))
            } else {
                finish?(moved ?? .failure(AgentError("下载未完成。")))
            }
        }
    }
}
