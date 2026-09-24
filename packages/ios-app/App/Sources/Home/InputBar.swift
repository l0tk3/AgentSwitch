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

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            if let pin = model.pin {
                HStack(spacing: 4) {
                    Label(pin.label, systemImage: "cpu").font(.caption)
                    Button { model.pin = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .accessibilityLabel("改回自动选择")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(.blue.opacity(0.12), in: Capsule())
            }
            AttachmentStrip()
            if error != nil {
                ErrorText(message: $error)
            }
            HStack(alignment: .bottom, spacing: 8) {
                extras
                TextField("让 Mac 上的 agent 做什么…", text: $model.composeText, axis: .vertical)
                    .lineLimit(1...6)
                    // Passwords may be typed here: keep the keyboard from learning or suggesting them.
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                Button { Task { error = await model.send() } } label: {
                    if model.sending {
                        ProgressView().frame(width: 32, height: 32)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                    }
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
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
            Task { add(await Self.load(items), prepare: true) }
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                Task {
                    let (files, skipped) = await Task.detached(priority: .userInitiated) { Self.read(urls) }.value
                    if !skipped.isEmpty { error = "没加上：\(skipped.joined(separator: "、"))（超过 50 MB 或读不出来）" }
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
        let images = UIPasteboard.general.images ?? []
        guard !images.isEmpty else { error = "剪贴板里没有图片"; return }
        // JPEG: a pasted photo as PNG would be many times larger; ImagePrep then shrinks it and turns it upright.
        add(images.enumerated().compactMap { i, image in
            image.jpegData(compressionQuality: 0.9).map { UploadFile(name: images.count == 1 ? "pasted.jpg" : "pasted-\(i + 1).jpg", type: "image/jpeg", data: $0) }
        }, prepare: true)
    }

    /// Photos as their original bytes (HEIC or JPEG); ImagePrep shrinks and re-encodes them.
    private static func load(_ items: [PhotosPickerItem]) async -> [UploadFile] {
        var files: [UploadFile] = []
        for (i, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
            files.append(UploadFile(name: "photo-\(i + 1).\(type.preferredFilenameExtension ?? "jpg")", type: type.preferredMIMEType ?? "image/jpeg", data: data))
        }
        return files
    }

    /// Files picked in the Files app: read inside their security scope; a file over the limit is not read at all.
    nonisolated private static func read(_ urls: [URL]) -> (files: [UploadFile], skipped: [String]) {
        var files: [UploadFile] = []
        var skipped: [String] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= PendingAttachment.maxFileBytes, let data = try? Data(contentsOf: url) else {
                skipped.append(url.lastPathComponent)
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(UploadFile(name: url.lastPathComponent, type: type, data: data))
        }
        return (files, skipped)
    }

    private var canSend: Bool {
        let hasContent = !model.composeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty
        return model.api != nil && !model.sending && model.preparingAttachments == 0 && hasContent
    }

    private var extras: some View {
        Menu {
            Section {
                Button("拍照", systemImage: "camera") { Keyboard.dismiss(); takingPhoto = true }
                    .disabled(!CameraPicker.isAvailable)
                Button("照片", systemImage: "photo.on.rectangle") { Keyboard.dismiss(); pickingPhotos = true }
                Button("文件", systemImage: "folder") { Keyboard.dismiss(); pickingFiles = true }
                Button("粘贴图片", systemImage: "doc.on.clipboard") { pasteImages() }
            }
            Button("插入密文", systemImage: "lock.doc") { Keyboard.dismiss(); model.sheet = .pickCiphertext }
                .disabled(model.ciphertexts.isEmpty)
            Button("生成密文", systemImage: "key") { Keyboard.dismiss(); model.sheet = .makeCiphertext }
            Menu("指定执行者", systemImage: "cpu") {
                Button("自动（路由器决定）") { model.pin = nil }
                ForEach(model.targets?.pinOptions ?? [], id: \.self) { ref in
                    Button(ref.label) { model.pin = ref }
                }
            }
        } label: {
            Image(systemName: "plus.circle.fill").font(.system(size: 32)).foregroundStyle(.secondary)
        }
        .accessibilityLabel("更多")
    }
}
