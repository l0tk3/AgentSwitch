import AgentSwitchKit
import SwiftUI

/// A member's avatars picked by the user (2026-11-24): two tabs, one for each look — Pixel (the library's faces and
/// characters), Classic (its emoji, and the colour of the ground under one). Each shows the avatar as that look draws
/// it; `Reset` in a tab puts that look back to the seat's own. `Save` sends what changed; the session keeps it in
/// every room.
struct RoomAvatarPicker: View {
    let model: RoomPageModel
    let handle: String
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss

    enum Tab: Hashable { case pixel, classic }

    /// One look's choice: as it is, a library id, or back to the seat's own.
    enum Pick: Equatable {
        case kept
        case id(String)
        case reset
    }

    @State private var tab: Tab = .pixel
    @State private var library: RoomAvatarLibrary?
    @State private var pixel: Pick = .kept
    @State private var emoji: Pick = .kept
    /// The classic ground's colour; nil: as it is.
    @State private var bg: Int?
    @State private var saving = false
    @State private var error: String?

    private var seat: RoomSeat? { model.detail?.seat(handle) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.l) {
                    Picker("Look", selection: $tab) {
                        Text("Pixel").tag(Tab.pixel)
                        Text("Classic").tag(Tab.classic)
                    }
                    .pickerStyle(.segmented)
                    preview
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    if let library {
                        if tab == .pixel { pixelTab(library) } else { classicTab(library) }
                    } else if error == nil {
                        HStack { Spacer(); BrailleSpinner(color: Theme.secondaryInk); Spacer() }.padding(.top, 30)
                    }
                }
                .padding(Theme.Space.l)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Avatar").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Cancel") } else { Text("Cancel").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { BrailleSpinner(color: Theme.ink) } else if look.isClassic { Text("Save").bold() } else { Text("Save").mono(15, weight: .medium) }
                    }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
                    .disabled(saving || !changed)
                }
            }
        }
        .presentationDetents([.large])
        .task { await load() }
    }

    private var changed: Bool { pixel != .kept || emoji != .kept || bg != nil }

    // MARK: - what it will look like

    /// The avatar as it would be with what is picked.
    private var shown: RoomAvatar {
        let was = seat?.avatar
        var p = was?.pixel
        switch pixel {
        case .kept: break
        case .reset: p = nil
        case .id(let id):
            if let f = library?.faces.first(where: { $0.id == id }) { p = .face(id: id, face: f.face) }
            else if let a = library?.art.first(where: { $0.id == id }) { p = .grid(id: id, palette: a.palette, rows: a.rows) }
        }
        var c = was?.classic
        switch emoji {
        case .kept: break
        case .reset: c = nil
        case .id(let id): if let e = library?.emoji.first(where: { $0.id == id }) { c = RoomClassicAvatar(id: id, emoji: e.emoji, bg: c?.bg ?? defaultBg) }
        }
        if let bg, let had = c { c = RoomClassicAvatar(id: had.id, emoji: had.emoji, bg: bg) }
        return RoomAvatar(pixel: p, classic: c)
    }

    /// The ground an emoji takes when none was chosen: the face's colour.
    private var defaultBg: Int { seat?.face?.color ?? 0 }

    private var preview: some View {
        HStack(spacing: 14) {
            RoomFaceView(face: seat?.face, side: 64, avatar: shown, handle: handle)
                .environment(\.interfaceLook, tab == .pixel ? .pixel : .classic)
            VStack(alignment: .leading, spacing: 4) {
                Text("@\(handle)").font(.system(size: 17, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink)
                Text(tab == .pixel ? "像素风格下显示" : "Classic 风格下显示").font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            Button("Reset") {
                if tab == .pixel { pixel = seat?.avatar?.pixel == nil ? .kept : .reset } else { emoji = seat?.avatar?.classic == nil ? .kept : .reset; bg = nil }
            }
            .buttonStyle(SquareButtonStyle(destructive: true))
            .disabled(tab == .pixel ? shown.pixel == nil : shown.classic == nil)
        }
    }

    // MARK: - the tabs

    private func pixelTab(_ library: RoomAvatarLibrary) -> some View {
        let current = shown.pixel?.id
        return VStack(alignment: .leading, spacing: Theme.Space.m) {
            SectionLabel("Characters")
            grid(min: 48) {
                ForEach(library.art) { a in
                    cell(selected: current == a.id) { pixel = .id(a.id) } content: { RoomGridView(palette: a.palette, rows: a.rows, side: 40) }
                }
            }
            SectionLabel("Faces")
            grid(min: 48) {
                ForEach(library.faces) { f in
                    cell(selected: current == f.id) { pixel = .id(f.id) } content: { RoomFaceView(face: f.face, side: 36) }
                }
            }
        }
        .environment(\.interfaceLook, .pixel)
    }

    private func classicTab(_ library: RoomAvatarLibrary) -> some View {
        let current = shown.classic
        let ground = bg ?? current?.bg ?? defaultBg
        return VStack(alignment: .leading, spacing: Theme.Space.m) {
            SectionLabel("Color")
            HStack(spacing: 8) {
                ForEach(0..<10, id: \.self) { n in
                    let rgb = RoomFace(rows: [], color: n)
                    Button { bg = n; if current == nil, let first = library.emoji.first { emoji = .id(first.id) } } label: {
                        Circle().fill(Color(light: rgb.rgb(dark: false), dark: rgb.rgb(dark: true)))
                            .frame(width: 24, height: 24)
                            .overlay { if ground == n && current != nil { Circle().strokeBorder(Theme.ink, lineWidth: 2).padding(-3) } }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Color \(n)")
                }
            }
            SectionLabel("Emoji")
            grid(min: 44) {
                ForEach(library.emoji) { e in
                    cell(selected: current?.id == e.id || (current?.id == nil && current?.emoji == e.emoji)) { emoji = .id(e.id) } content: {
                        Text(e.emoji).font(.system(size: 26)).frame(width: 36, height: 36)
                    }
                }
            }
        }
    }

    private func grid<Content: View>(min: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: min), spacing: 6)], spacing: 6, content: content)
    }

    private func cell<Content: View>(selected: Bool, pick: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
        Button(action: pick) {
            content()
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(selected ? Theme.signal.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: look.isClassic ? 10 : 0))
                .overlay { if selected { RoundedRectangle(cornerRadius: look.isClassic ? 10 : 0).strokeBorder(Theme.signal, lineWidth: 2) } }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - reading and saving

    private func load() async {
        tab = look.isClassic ? .classic : .pixel
        #if DEBUG
        if DemoRooms.isDemo {
            library = DemoAvatars.library
            if DemoRooms.screen == "roomavatarclassic" { tab = .classic }
            return
        }
        #endif
        guard let api = app.api else { error = "没有连上 Mac。"; return }
        do { library = try await api.roomAvatars() } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        let pixelChoice: RoomAvatarChoice? = switch pixel {
        case .kept: nil
        case .id(let id): .id(id)
        case .reset: .reset
        }
        var classicChoice: RoomAvatarChoice?
        switch emoji {
        case .reset: classicChoice = .reset
        case .id(let id): classicChoice = .emoji(id: id, bg: bg ?? shown.classic?.bg)
        case .kept:
            // Only the ground changed: the same emoji sent again on it.
            if let bg, let c = seat?.avatar?.classic { classicChoice = c.id.map { .emoji(id: $0, bg: bg) } ?? .emojiText(c.emoji, bg: bg) }
        }
        guard pixelChoice != nil || classicChoice != nil else { dismiss(); return }
        #if DEBUG
        if DemoRooms.isDemo { dismiss(); return }
        #endif
        saving = true
        defer { saving = false }
        error = nil
        let done = await model.run(app.api) { try await $0.setAvatar(handle, in: model.id, pixel: pixelChoice, classic: classicChoice) }
        if done { dismiss() } else { error = model.error ?? "没能保存。" }
    }
}
