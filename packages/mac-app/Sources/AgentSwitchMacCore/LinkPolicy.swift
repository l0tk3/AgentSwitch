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

    /// Pictures, PDFs, text, audio and video, office documents; never a script (a `.command` is text, and Terminal runs it).
    static func isDocument(_ type: UTType) -> Bool {
        let runs: [UTType] = [.script, .executable, .application, .package]
        if runs.contains(where: type.conforms(to:)) { return false }
        let documents: [UTType] = [.image, .pdf, .text, .audiovisualContent, .spreadsheet, .presentation]
        return documents.contains(where: type.conforms(to:))
    }
}
