import Foundation
import UniformTypeIdentifiers

/// What a ⌘-click on a link in a terminal does (docs/terminal-v0.md §1 链接). The link comes from an agent's output, so
/// nothing that could run is opened: a document opens in its app, as in iTerm; an app, a script, anything executable or
/// of a kind not known to be a document is only shown in Finder.
public enum LinkAction: Equatable, Sendable {
    /// A web page, in the browser.
    case browse(URL)
    /// A folder in Finder, a document in its app.
    case open(URL)
    /// Selected in Finder, not opened.
    case reveal(URL)
    case ignore
}

public enum LinkPolicy {
    /// A link as the screen found it, as a URL (2026-10-01, user: 这种路径我用 cmd+鼠标点击没反应): web and file URLs as
    /// they are; a path — `/…`, `~/…`, or relative to `workdir` (`./…`, `../…`, `src/a.ts`, `README.md:12`) — as a file,
    /// with a `:line` or `:line:column` suffix (as agents cite code) dropped (the opener has no way to go to a line).
    /// Nil when a relative path has nothing to go from.
    public static func url(fromLink link: String, workdir: String?, home: String = NSHomeDirectory()) -> URL? {
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !isFileLine(text), let url = URL(string: text), let scheme = url.scheme, scheme.count > 1 { return url }
        var path = text
        if let suffix = path.range(of: #":\d+(:\d+)?$"#, options: .regularExpression) { path.removeSubrange(suffix) }
        if path == "~" || path.hasPrefix("~/") {
            path = home + path.dropFirst()
        } else if !path.hasPrefix("/") {
            guard let workdir, workdir.hasPrefix("/") else { return nil }
            path = (workdir as NSString).appendingPathComponent(path)
        }
        return URL(fileURLWithPath: (path as NSString).standardizingPath)
    }

    /// The file a path link means, checked on disk as iTerm's semantic history does: the link itself when it exists,
    /// else the longest part of it from its start that does — a link the screen took too far (the next line's words
    /// glued on) still opens the file the click was on. Never shorter than the folder its name is in; nil if nothing
    /// there exists.
    public static func existingFile(_ url: URL, fileManager: FileManager = .default) -> URL? {
        guard url.isFileURL else { return url }
        let path = url.path
        if fileManager.fileExists(atPath: path) { return url }
        // The deepest existing folder along the path bounds how far back the name may be cut.
        var folder = ""
        var at = path.startIndex
        while let slash = path[at...].firstIndex(of: "/") {
            let candidate = String(path[...slash])
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: candidate, isDirectory: &isDir), isDir.boolValue else { break }
            folder = candidate
            at = path.index(after: slash)
        }
        guard !folder.isEmpty else { return nil }
        var end = path.endIndex
        while end > path.index(path.startIndex, offsetBy: folder.count + 1) {
            end = path.index(before: end)
            let candidate = String(path[..<end])
            if fileManager.fileExists(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    /// What a ⌘-click on `link` opens: a URL as it is (a web page; a `file:` link's file as `existingFile` finds it); a
    /// plain path, together with `wrapped` — the clicked word joined with the lines it may run on over (WrappedPath, a
    /// path the agent's screen broke and indented) —, the longest of them that exists on disk, else the longest existing
    /// part (`existingFile`) of the link itself or of a join with the lines below it. A join with a line above is never
    /// cut back: what is left of it is the line above's path (`src/a.ts` over `src/b.ts`, `b.ts` deleted: nothing, not
    /// `a.ts`). Nil when nothing there exists.
    public static func target(link: String, wrapped: [WrappedPath.Join] = [], workdir: String?, home: String = NSHomeDirectory(),
                              fileManager: FileManager = .default) -> URL? {
        let first = url(fromLink: link, workdir: workdir, home: home)
        if let first, !isPlainPath(link) { return existingFile(first, fileManager: fileManager) }
        var seen = Set<String>()
        let files = ([(first, false)] + wrapped.map { (url(fromLink: $0.text, workdir: workdir, home: home), $0.reachesUp) })
            .compactMap { url, reachesUp in url.map { (url: $0, cutBack: !reachesUp) } }
            .filter { $0.url.isFileURL && seen.insert($0.url.path).inserted }
            .sorted { $0.url.path.count > $1.url.path.count }
        if let found = files.first(where: { fileManager.fileExists(atPath: $0.url.path) }) { return found.url }
        return files.lazy.filter(\.cutBack).compactMap { existingFile($0.url, fileManager: fileManager) }.first
    }

    /// A path as text, not a URL (`file:`, `https:`) or anything else a scheme names.
    static func isPlainPath(_ link: String) -> Bool {
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if isFileLine(text) { return true }
        guard let scheme = URL(string: text)?.scheme else { return true }
        return scheme.count <= 1
    }

    /// `README.md:12`, `a.ts:3:1`: a file's name and where in it, which `URL(string:)` would read as the scheme
    /// `readme.md` (a scheme may hold dots) — a file, not a URL.
    static func isFileLine(_ text: String) -> Bool {
        text.range(of: #"^[A-Za-z0-9_][^/:\s]*\.[A-Za-z0-9]+:\d+(:\d+)?$"#, options: .regularExpression) != nil
    }

    public static func action(for url: URL) -> LinkAction {
        switch url.scheme?.lowercased() {
        case "http", "https":
            return .browse(url)
        case "file":
            // Where a link points through is what would open.
            let real = url.resolvingSymlinksInPath()
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: real.path, isDirectory: &isFolder) else { return .ignore }
            let type = (try? real.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            if isFolder.boolValue {
                // A package is a folder too (an app, a workflow), and opening it runs it.
                return type?.conforms(to: .package) == true ? .reveal(real) : .open(real)
            }
            guard let type, isDocument(type), !FileManager.default.isExecutableFile(atPath: real.path) else { return .reveal(real) }
            return .open(real)
        default:
            return .ignore
        }
    }

    /// Pictures, PDFs, text, audio and video, office documents; never a script (a `.command` is text, and Terminal runs it)
    /// nor a configuration profile (XML, and opening it starts installing it).
    static func isDocument(_ type: UTType) -> Bool {
        if runs.contains(where: type.conforms(to:)) { return false }
        return documents.contains(where: type.conforms(to:))
    }

    private static let runs: [UTType] = [.script, .executable, .application, .package]
        + ["com.apple.mobileconfig", "com.apple.configprofile"].compactMap { UTType($0) }
    /// Word processing has no system type of its own: Word, Pages and OpenDocument text by name (a macro-enabled Word
    /// file is also an executable, so it stays out).
    private static let documents: [UTType] = [.image, .pdf, .text, .audiovisualContent, .spreadsheet, .presentation]
        + ["org.openxmlformats.wordprocessingml.document", "com.microsoft.word.doc", "com.apple.iwork.pages.sffpages",
           "com.apple.iwork.pages.pages", "org.oasis-open.opendocument.text"].compactMap { UTType($0) }
}
