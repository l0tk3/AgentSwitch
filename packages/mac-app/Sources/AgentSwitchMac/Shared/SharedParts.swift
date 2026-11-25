import AgentSwitchMacCore
import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Small pieces the pages share: what you said in its box (a terminal's record), the quiet word of a button, a file's
// mark, rows that wrap, the red button that deletes; a token put into a reply's field; files dropped or pasted.

/// What you said, right-aligned in a raised square box, as you typed it (its code drawn as code, TypedText); `N attached`
/// under it.
struct UserBox: View {
    let text: String
    var attached = 0
    var faded = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 140)
            VStack(alignment: .trailing, spacing: 4) {
                // Ink on a quiet ground in both looks: the classic look's bubble is a wash of the ink, round (it was
                // the accent's colour with white text until 2026-10-07, docs/ui-v0.md §8); the pixel look's a raised box.
                TypedText(text: text, size: Look.typed, lineSpacing: 5)
                    .foregroundStyle(Look.ink)
                    .padding(.horizontal, look.isClassic ? 14 : 13)
                    .padding(.vertical, 9)
                    // A box with round corners, not a capsule: one line of text in a radius of 15 was a pill.
                    .grounded(Look.said, radius: Look.saidRadius)
                    .framed(look.isClassic ? Color.clear : Look.line, radius: Look.saidRadius)
                    .opacity(faded ? 0.55 : 1)
                if attached > 0 { Text("\(attached) attached").mono(11).foregroundStyle(Look.ink2) }
            }
        }
    }
}

/// A secondary word that brightens under the pointer (`▸ Read Aloud`, `+N Files`).
struct QuietButtonStyle: ButtonStyle {
    var active = false

    func makeBody(configuration: Configuration) -> some View {
        QuietButtonBody(configuration: configuration, active: active)
    }
}

private struct QuietButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let active: Bool
    @State private var hovering = false

    var body: some View {
        configuration.label
            .foregroundStyle(active ? Color.signal : hovering || configuration.isPressed ? Look.ink : Look.ink2)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// A file's mark: hollow on the Mac only, the spinner while it comes, solid once here.
struct FileMark: View {
    let state: DispatchFileState
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch state {
        case .remote: mark(PixelArt.hollow, symbol: "doc").accessibilityLabel("On the Mac")
        case .downloading: BrailleSpinner()
        case .local: mark(PixelArt.square, symbol: "doc.fill").accessibilityLabel("Downloaded")
        }
    }

    /// A hollow or a solid square; a sheet, empty or filled, in the classic look.
    @ViewBuilder
    private func mark(_ rows: [String], symbol: String) -> some View {
        if look.isClassic {
            Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(Look.ink2)
        } else {
            PixelSprite(rows: rows, pixel: 2, color: Look.ink2)
        }
    }
}

/// Rows of items that wrap (a reply's files, a room's work).
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + CGFloat(max(rows.count - 1, 0)) * lineSpacing
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !row.items.isEmpty && row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append(index)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// A button that deletes: the system's button with its word in red (the demo's red buttons), paler while it cannot be
/// pressed — a colour set by hand does not dim by itself.
struct SettingsDeleteButton: View {
    @Environment(\.isEnabled) private var isEnabled
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(role: .destructive, action: action) { Text(title).foregroundStyle(Color.failed.opacity(isEnabled ? 1 : 0.4)) }
    }
}

/// A token to put into the input at its cursor, once. `tokens`: a reply's files, typed there with
/// the spaces typing them would take (docs/terminal-v0.md §4) instead of `text`.
struct InsertRequest: Equatable {
    let id = UUID()
    let text: String
    var tokens: [String] = []
}

/// A drop on a record or a field.
@MainActor
enum RecordPage {
    /// The file URLs of a drop, read from their providers.
    static func load(_ providers: [NSItemProvider], then attach: @escaping @MainActor ([URL]) -> Void) {
        Task { @MainActor in
            var urls: [URL] = []
            for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? URL {
                    urls.append(url)
                } else if let data = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? Data,
                          let url = URL(dataRepresentation: data, relativeTo: nil) {
                    urls.append(url)
                }
            }
            attach(urls)
        }
    }
}

/// What the clipboard holds for a reply.
@MainActor
enum DispatchModel {
    /// An image on the clipboard as PNG (screenshots and copies from Preview come as TIFF or PNG).
    static func pastedImage(_ board: NSPasteboard) -> DispatchUploadFile? {
        if let png = board.data(forType: .png) { return DispatchUploadFile(name: pastedName(), type: "image/png", data: png) }
        guard let image = NSImage(pasteboard: board), let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return DispatchUploadFile(name: pastedName(), type: "image/png", data: png)
    }

    private static func pastedName() -> String {
        let format = DateFormatter()
        format.dateFormat = "yyyyMMdd-HHmmss"
        return "pasted-\(format.string(from: Date())).png"
    }
}
