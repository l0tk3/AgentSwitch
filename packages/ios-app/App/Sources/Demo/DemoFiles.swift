#if DEBUG
import AgentSwitchKit
import Foundation
import UIKit

/// A made-up Mac disk for the Files demo screens (`-uiDemo YES -uiDemoScreen files…`): the demo terminals' project,
/// a home folder with a picture, a PDF, a big download, AgentSwitch's own locked places and files that may hold a
/// password. Nothing here is the user's: names and contents are invented. `scope`: as a device given only that folder
/// would see it (docs/files-v0.md §7.5).
struct DemoFiles: MacFileSource {
    static let home = "/Users/me"
    static let project = "/Users/me/Projects/AgentSwitch"
    static let scopeFolder = project

    let scope: String?

    private struct Node: Sendable {
        var kind: MacFileEntry.Kind
        var size: Int64 = 0
        var mtime: Double
        var text: String? = nil
        var locked = false
        var dim = false
        var sensitive: String? = nil
    }

    private static let now = Date().timeIntervalSince1970 * 1000
    private static func ago(_ minutes: Double) -> Double { now - minutes * 60_000 }

    private static let readme = """
    # AgentSwitch

    手机遥控 Mac 上多个 AI agent 的任务编排层（示例内容）。

    ## 布局

    - `docs/` 设计与决策记录
    - `packages/daemon/` 服务
    - `packages/ios-app/` iPhone 应用

    ## 运行

        npm install
        npm test
    """
    private static let pkg = """
    {
      "name": "agentswitch-demo",
      "private": true,
      "scripts": {
        "test": "vitest run"
      }
    }
    """
    private static let app = """
    import { createServer } from "node:http";

    // The demo's server: answers every request with the time.
    export function serve(port: number) {
      return createServer((_req, res) => {
        res.end(new Date().toISOString());
      }).listen(port);
    }
    """
    private static let env = "PORT=5173\nAPI_BASE=http://127.0.0.1:8080\nSESSION_SECRET=change-me\n"
    private static let key = "-----BEGIN OPENSSH PRIVATE KEY-----\n（示例，不是真的密钥）\n-----END OPENSSH PRIVATE KEY-----\n"

    /// The disk as it is now: it changes as the demo screens make, rename, move and receive files (files-v0 §12).
    private final class Disk: @unchecked Sendable {
        private let lock = NSLock()
        private var nodes: [String: Node]
        init(_ nodes: [String: Node]) { self.nodes = nodes }
        subscript(path: String) -> Node? {
            get { lock.withLock { nodes[path] } }
            set { lock.withLock { nodes[path] = newValue } }
        }
        func filter(_ isIncluded: ((key: String, value: Node)) -> Bool) -> [String: Node] { lock.withLock { nodes.filter(isIncluded) } }
        func move(_ from: String, to: String) {
            lock.withLock {
                for (k, v) in nodes where k == from || k.hasPrefix(from + "/") { nodes[k] = nil; nodes[to + k.dropFirst(from.count)] = v }
            }
        }
        func remove(_ path: String) { lock.withLock { for k in nodes.keys where k == path || k.hasPrefix(path + "/") { nodes[k] = nil } } }
    }

    private static let tree = Disk(made)

    private static let made: [String: Node] = {
        var t: [String: Node] = [:]
        func dir(_ p: String, _ m: Double, dim: Bool = false, locked: Bool = false) { t[p] = Node(kind: .dir, mtime: m, locked: locked, dim: dim) }
        func file(_ p: String, _ m: Double, size: Int64? = nil, text: String? = nil, sensitive: String? = nil, locked: Bool = false) {
            t[p] = Node(kind: .file, size: size ?? Int64(text?.utf8.count ?? 0), mtime: m, text: text, locked: locked, sensitive: sensitive)
        }
        dir("/", ago(9000)); dir("/Users", ago(9000)); dir("/Applications", ago(9000)); dir("/Library", ago(9000)); dir("/System", ago(9000))
        dir("/Users/Shared", ago(9000)); dir(home, ago(3))
        dir("\(home)/.agentswitch", ago(3)); dir("\(home)/.agentswitch/nodes", ago(900), locked: true)
        file("\(home)/.agentswitch/local-token", ago(900), size: 64, locked: true)
        dir("\(home)/.agentswitch/terminals", ago(4))
        dir("\(home)/.secret-gate", ago(2000), locked: true)
        dir("\(home)/.ssh", ago(40000))
        file("\(home)/.ssh/config", ago(40000), text: "Host github.com\n  IdentityFile ~/.ssh/id_ed25519\n")
        file("\(home)/.ssh/id_ed25519", ago(40000), text: key, sensitive: "ssh")
        file("\(home)/.ssh/id_ed25519.pub", ago(40000), text: "ssh-ed25519 AAAA…（示例） me@mac\n")
        file("\(home)/.zshrc", ago(20000), text: "export PATH=\"$HOME/.local/bin:$PATH\"\n")
        dir("\(home)/Desktop", ago(30)); file("\(home)/Desktop/screenshot.png", ago(30), size: 412_000)
        dir("\(home)/Documents", ago(5000)); file("\(home)/Documents/plan.pdf", ago(5000), size: 1_240_000)
        dir("\(home)/Downloads", ago(9000)); file("\(home)/Downloads/dataset.zip", ago(9000), size: 182_000_000)
        dir("\(home)/Blog", ago(3000)); file("\(home)/Blog/index.md", ago(3000), text: "# 博客\n\n第一篇（示例）。\n")
        dir("\(home)/Projects", ago(30))
        dir(project, ago(2))
        file("\(project)/.env", ago(7000), text: env, sensitive: "env")
        dir("\(project)/.git", ago(2), dim: true)
        dir("\(project)/docs", ago(60)); file("\(project)/docs/files-v0.md", ago(60), text: "# 文件 v0（示例）\n\n主窗口右侧的文件栏。\n")
        file("\(project)/docs/logo.png", ago(4000), size: 24_600)
        // The page the demo terminal's screen names (`terminallink`, `terminalpath`).
        dir("\(project)/docs/design", ago(90)); dir("\(project)/docs/design/concepts", ago(90))
        file("\(project)/docs/design/concepts/split.html", ago(90), text: "<!doctype html>\n<title>Split</title>\n<p>分屏的演示页（示例）。</p>\n")
        dir("\(project)/node_modules", ago(9000), dim: true)
        dir("\(project)/src", ago(5)); file("\(project)/src/app.ts", ago(5), text: app); file("\(project)/src/store.ts", ago(12), size: 3980, text: app)
        // A minified file: one long line (`filespreviewlong`).
        dir("\(project)/dist", ago(5)); file("\(project)/dist/app.min.js", ago(5), text: String(repeating: "(()=>{\"use strict\";var e={812:(e,t,n)=>{n.d(t,{A:()=>r});const r=function(e){return e.split(\"/\").filter(Boolean)}}};", count: 40))
        file("\(project)/src/main.ts", ago(3000), text: "import { serve } from \"./app\";\n\nserve(8080);\n")
        file("\(project)/README.md", ago(300), text: readme); file("\(project)/package.json", ago(9000), text: pkg)
        return t
    }()

    private func inScope(_ p: String) -> Bool { scope.map { p == $0 || p.hasPrefix($0 + "/") } ?? true }
    private func leadsIn(_ p: String) -> Bool { scope.map { $0.hasPrefix(p == "/" ? "/" : p + "/") } ?? false }

    private func children(of p: String) -> [(String, Node)] {
        Self.tree.filter { MacPath.parent($0.key) == p && $0.key != "/" }.map { (MacPath.name($0.key), $0.value) }
    }

    private func entry(_ name: String, _ n: Node, in dir: String) -> MacFileEntry {
        MacFileEntry(name: name, kind: n.kind, size: n.locked ? 0 : n.size, mtime: n.locked ? 0 : n.mtime, dim: n.dim, locked: n.locked, fixed: !n.locked && fixed(MacPath.join(dir, name)))
    }

    private func refuse(_ code: String, _ status: Int = 403) -> APIError { .http(status: status, message: code) }

    /// `~` and `~/…` as the home folder, as the Mac takes them.
    private func expanded(_ p: String) -> String { p == "~" ? Self.home : p.hasPrefix("~/") ? Self.home + p.dropFirst() : p }

    func folder(_ path: String?, hidden: Bool, etag: String?) async throws -> (folder: MacFolder, etag: String?)? {
        let p = path.map(expanded) ?? scope ?? Self.home
        guard let node = Self.tree[p] else { throw refuse("not-found", 404) }
        guard node.kind == .dir else { throw refuse("not-folder", 400) }
        if node.locked { throw refuse("locked") }
        let scoped = !inScope(p)
        if scoped && !leadsIn(p) { throw refuse("scope") }
        var kids = children(of: p)
        if scoped { kids = kids.filter { inScope(MacPath.join(p, $0.0)) || leadsIn(MacPath.join(p, $0.0)) } }
        let shown = kids.filter { hidden || !$0.0.hasPrefix(".") }
        let sorted = shown.sorted { a, b in
            let fa = a.1.kind == .dir, fb = b.1.kind == .dir
            if fa != fb { return fa }
            return a.0.trimmingCharacters(in: CharacterSet(charactersIn: ".")).localizedStandardCompare(b.0.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == .orderedAscending
        }
        let version = "\"\(p)|\(hidden)\""
        if etag == version { return nil }
        let level = MacFolder(path: p, parent: MacPath.parent(p), home: Self.home, entries: sorted.map { entry($0.0, $0.1, in: p) },
                              hiddenCount: kids.count - shown.count, scoped: scoped)
        return (level, version)
    }

    func fileDetails(_ path: String) async throws -> MacFileDetails {
        let path = expanded(path)
        guard let n = Self.tree[path] else { throw refuse("not-found", 404) }
        if n.locked { throw refuse("locked") }
        if !inScope(path) && !leadsIn(path) { throw refuse("scope") }
        if n.kind == .dir { return MacFileDetails(name: MacPath.name(path), kind: .dir, size: 0, mtime: n.mtime, path: path, items: children(of: path).count) }
        let ext = (path as NSString).pathExtension.lowercased()
        let type: MacFileType = ["png", "jpg"].contains(ext) ? .image : ext == "pdf" ? .pdf : ext == "zip" ? .archive : n.text != nil ? .text : .binary
        let lines = n.text.map { $0.split(separator: "\n", omittingEmptySubsequences: false).count - ($0.hasSuffix("\n") ? 1 : 0) }
        return MacFileDetails(name: MacPath.name(path), kind: .file, size: n.size, mtime: n.mtime, path: path, type: type, lines: lines, sensitive: n.sensitive)
    }

    func filePreview(_ path: String) async throws -> MacFilePreview {
        guard let n = Self.tree[expanded(path)], let text = n.text else { throw refuse("not-text", 415) }
        return MacFilePreview(text: text, truncated: false, lines: nil, size: n.size)
    }

    func fileThumbnail(_ path: String) async throws -> Data {
        guard Self.tree[path] != nil else { throw refuse("not-found", 404) }
        // A made-up picture: a window with three lines, or the logo's bars.
        let image = UIGraphicsImageRenderer(size: CGSize(width: 480, height: 320)).image { c in
            UIColor(white: 0.16, alpha: 1).setFill(); c.fill(CGRect(x: 0, y: 0, width: 480, height: 320))
            UIColor(white: 0.04, alpha: 1).setFill(); c.fill(CGRect(x: 40, y: 40, width: 400, height: 240))
            for (i, color) in [UIColor.systemPink, UIColor(white: 0.9, alpha: 1), UIColor(white: 0.55, alpha: 1)].enumerated() {
                color.setFill(); c.fill(CGRect(x: 80, y: 100 + CGFloat(i) * 40, width: CGFloat(260 - i * 60), height: 18))
            }
        }
        return image.jpegData(compressionQuality: 0.8) ?? Data()
    }

    // MARK: changes (docs/files-v0.md §12)

    private func fail(_ refusal: FileRefusal, status: Int = 409) -> FileChangeError { FileChangeError(refusal: refusal, status: status) }
    /// Not to be renamed or moved: AgentSwitch's places, home and what holds them, what is right under `/`.
    private func fixed(_ p: String) -> Bool {
        p == "/" || MacPath.parent(p) == "/" || Self.tree[p]?.locked == true || [Self.home, "/Users", "\(Self.home)/.agentswitch"].contains(p)
    }

    private func make(_ path: String, kind: MacFileEntry.Kind) throws -> MacMade {
        if Self.tree[path] != nil { throw fail(.exists) }
        var top: String?
        var at = path
        var chain: [String] = []
        while Self.tree[at] == nil, let up = MacPath.parent(at) { chain.insert(at, at: 0); at = up }
        guard Self.tree[at]?.kind == .dir, Self.tree[at]?.locked == false, at != "/" else { throw fail(.locked, status: 403) }
        for (i, p) in chain.enumerated() {
            Self.tree[p] = i == chain.count - 1 && kind == .file ? Node(kind: .file, size: 0, mtime: Self.now, text: "") : Node(kind: .dir, mtime: Self.now)
            top = top ?? p
        }
        return MacMade(path: path, top: top ?? path)
    }

    func newFolder(_ path: String) async throws -> MacMade { try make(path, kind: .dir) }
    func newFile(_ path: String) async throws -> MacMade { try make(path, kind: .file) }

    func rename(_ path: String, to name: String, force: Bool) async throws -> String {
        guard Self.tree[path] != nil else { throw fail(.notFound, status: 404) }
        if fixed(path) { throw fail(.locked, status: 403) }
        let to = MacPath.join(MacPath.parent(path) ?? "/", name)
        if Self.tree[to] != nil && to.lowercased() != path.lowercased() { throw fail(.exists) }
        Self.tree.move(path, to: to)
        return to
    }

    func trash(_ paths: [String], force: Bool, permanent: Bool) async throws -> [MacMoved] {
        for p in paths { if fixed(p) { throw fail(.locked, status: 403) } }
        for p in paths { Self.tree.remove(p) }
        return paths.map { MacMoved(path: $0, trashed: "\(Self.home)/.Trash/\(MacPath.name($0))") }
    }

    func upload(_ file: URL, to path: String, conflict: UploadConflict, progress: @escaping @Sendable (Double) -> Void) async throws -> MacUploaded {
        let size = Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        // A made-up link: the bytes go in twenty steps.
        for step in 1...20 { try await Task.sleep(for: .milliseconds(150)); progress(Double(step) / 20) }
        var target = path
        if Self.tree[path] != nil {
            switch conflict {
            case .fail: throw fail(.exists)
            case .replace: Self.tree.remove(path)
            case .keep:
                let dir = MacPath.parent(path) ?? "/"
                target = MacPath.join(dir, FileNames.keepBoth(MacPath.name(path), taken: Set(children(of: dir).map(\.0))))
            }
        }
        Self.tree[target] = Node(kind: .file, size: size, mtime: Date().timeIntervalSince1970 * 1000)
        return MacUploaded(path: target, name: MacPath.name(target), size: size)
    }

    func downloadFile(_ path: String, to file: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        guard let n = Self.tree[path] else { throw refuse("not-found", 404) }
        for step in 1...5 { try await Task.sleep(for: .milliseconds(120)); progress(Double(step) / 5) }
        let data: Data
        if let text = n.text { data = Data(text.utf8) } else if path.hasSuffix(".png") { data = try await fileThumbnail(path) } else {
            data = Self.pdf()
        }
        try data.write(to: file, options: .atomic)
    }

    /// One made-up page for the PDF.
    private static func pdf() -> Data {
        UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 420, height: 595)).pdfData { c in
            c.beginPage()
            ("计划（示例）" as NSString).draw(at: CGPoint(x: 40, y: 50), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 22)])
            ("这是演示用的 PDF，不是真的文件。" as NSString).draw(at: CGPoint(x: 40, y: 100), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
        }
    }
}
#endif
