import AgentSwitchKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The input box. The "+" holds the extras: attachments (camera, photos, files, a pasted image), a saved or new
/// ciphertext, and pinning the next task to an executor (a removable chip; the router chooses by default).
struct InputBar: View {
    @Environment(AppModel.self) private var model
    @State private var error: String?
    @State private var takingPhoto = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingFiles = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let pin = model.pin {
                HStack(spacing: 6) {
                    Text("Pin → \(ModelName.display(pin.model))").mono(12, weight: .medium)
                    Button { model.pin = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 14) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("恢复自动选择")
                }
                .foregroundStyle(Theme.signal)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .framed(Theme.signal, radius: Theme.Radius.control)
            }
            AttachmentStrip()
            if error != nil {
                ErrorText(message: $error)
            }
            HStack(alignment: .bottom, spacing: Theme.Space.s) {
                extras
                TextField("输入任务或问题", text: $model.composeText, axis: .vertical)
                    .lineLimit(1...6)
                    // Passwords may be typed here: keep the keyboard from learning or suggesting them.
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, look.isClassic ? 14 : 12)
                    .padding(.vertical, 9)
                    // The classic look's field: its own ground, round as a bubble.
                    .grounded(look.isClassic ? Theme.panel : Color.clear, radius: Theme.Radius.bubble)
                    .framed(Theme.line, radius: Theme.Radius.bubble)
                // Square; ink once there is something to send (the primary button, §7.2.3), pink while pressed. A disc
                // in the accent with an arrow in the classic look.
                Button { Task { error = await model.send() } } label: {
                    if model.sending {
                        BrailleSpinner(color: Theme.base)
                    } else if look.isClassic {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                    } else {
                        Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced))
                    }
                }
                .buttonStyle(SquareIconButtonStyle(active: canSend || model.sending))
                .disabled(!canSend)
                .accessibilityLabel("send")
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, Theme.Space.s)
        .padding(.bottom, Theme.Space.s)
        // Down to the screen's edge: the conversation scrolls under the bar and must not show below it.
        .background(alignment: .top) {
            VStack(spacing: 0) { Theme.line.frame(height: 1); Theme.base }
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { data in
                takingPhoto = false
                if let data { add([UploadFile(name: "photo.jpg", type: "image/jpeg", data: data)], prepare: true) }
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: PendingAttachment.maxCount, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { add(await PickedFiles.photos(items), prepare: true) }
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                Task {
                    let (files, skipped) = await Task.detached(priority: .userInitiated) { PickedFiles.read(urls) }.value
                    if !skipped.isEmpty { error = "未添加：\(skipped.joined(separator: "、"))（超过 50 MB 或无法读取）" }
                    add(files, prepare: false)
                }
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }

    private func add(_ files: [UploadFile], prepare: Bool) {
        guard !files.isEmpty else { return }
        Task { if let problem = await model.addAttachments(files, prepare: prepare) { error = problem } }
    }

    private func pasteImages() {
        let images = PickedFiles.pastedImages()
        guard !images.isEmpty else { error = "剪贴板中无图片"; return }
        add(images, prepare: true)
    }

    private var canSend: Bool {
        let hasContent = !model.composeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty
        return model.api != nil && !model.sending && model.outgoing == nil && model.preparingAttachments == 0 && hasContent
    }

    private var extras: some View {
        Menu {
            Section {
                // Every row an icon (§7.2.5, 2026-09-30: the system's own, as other apps' menus have them).
                Button("Camera", systemImage: "camera") { Keyboard.dismiss(); takingPhoto = true }
                    .disabled(!CameraPicker.isAvailable)
                Button("Photos", systemImage: "photo.on.rectangle") { Keyboard.dismiss(); pickingPhotos = true }
                Button("Files", systemImage: "folder") { Keyboard.dismiss(); pickingFiles = true }
                Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImages() }
            }
            Button("Insert Ciphertext", systemImage: "lock") { Keyboard.dismiss(); model.sheet = .pickCiphertext }
                .disabled(model.ciphertexts.isEmpty)
            Button("New Ciphertext", systemImage: "plus") { Keyboard.dismiss(); model.sheet = .makeCiphertext }
            Menu("Pin Model", systemImage: "pin") {
                Button("Auto") { model.pin = nil }
                ForEach(model.targets?.pinOptions ?? [], id: \.self) { ref in
                    Button(ref.displayName) { model.pin = ref }
                }
            }
        } label: {
            if look.isClassic {
                Image(systemName: "plus.circle").font(.system(size: 26, weight: .light)).foregroundStyle(.secondary)
                    .frame(width: 34, height: 38)
            } else {
                Text("+")
                    .font(.system(size: 20, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(width: 38, height: 38)
                    .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
            }
        }
        .tint(Theme.ink)   // not the signal colour: it is neither selected nor the primary action
        .accessibilityLabel("more")
    }
}
