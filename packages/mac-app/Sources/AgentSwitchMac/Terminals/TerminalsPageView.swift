import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The Terminals page (docs/terminal-v0.md §1 Mac; dispatch-v0 §1): the list on the left — its edge dragged for its
/// width, past the window's edge to close it —, the panes on the right, and over both the page's question when it asks
/// one. Always dark, in the terminal's own ground.
struct TerminalsPageView: View {
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                if !model.sideClosed {
                    TerminalSidebar(model: model).frame(width: model.sideWidth)
                    SideEdge(model: model, pageWidth: geometry.size.width)
                }
                TerminalPanesArea(model: model)
            }
            .overlay {
                if let sheet = model.sheet { TerminalSheetView(sheet: sheet, model: model) }
            }
        }
        .background(Color(nsColor: model.ground))
        .environment(\.colorScheme, .dark)
        .tint(.brand)
        .followsWindow()
    }
}

/// The list's right edge: 1 pt drawn, 7 to take hold of. Dragged it sets the list's width; a double click puts it back.
private struct SideEdge: View {
    let model: TerminalsModel
    let pageWidth: CGFloat
    @State private var hovering = false
    @State private var dragging = false

    var body: some View {
        Rectangle()
            .fill(hovering || dragging ? Look.ink2 : Look.line)
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .overlay {
                Color.clear.frame(width: 7).contentShape(Rectangle())
                    .onHover { inside in
                        hovering = inside
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { value in
                            dragging = true
                            model.dragSide(to: model.sideWidth + value.translation.width - moved, pageWidth: pageWidth)
                            moved = value.translation.width
                        }
                        .onEnded { _ in
                            dragging = false
                            moved = 0
                        })
                    .simultaneousGesture(TapGesture(count: 2).onEnded { model.sideWidth = TerminalsModel.Side.width })
            }
            .zIndex(1)
            .help("Drag · Double-Click Resets")
    }

    /// How far the drag under way has moved the edge already.
    @State private var moved: CGFloat = 0
}
