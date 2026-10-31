import AgentSwitchMacCore
import SwiftUI

/// Nodes (docs/mesh-v0.md; demo `docs/design/concepts/mesh.html` §3): this Mac as a node, and every node and phone
/// paired with it. A pair between two nodes has two directions — this Mac uses it, it uses this Mac — each with a
/// switch: off at once (the other side's token is void), on again by pairing that direction anew. Took the place of
/// Devices (2026-10-10).
struct NodesView: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation
    @State private var linking = false
    @State private var removing: NodeRow?
    @State private var askingTools = false

    private var store: NodesStore { model.nodes }
    private var rows: [NodeRow] { NodeRows.build(nodes: store.nodes, devices: model.devices) }

    var body: some View {
        Form {
            Section {
                LabeledContent(model.remote?.name ?? store.list?.own.name ?? Host.current().localizedName ?? "This Mac") {
                    Text(addresses).font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Toggle("Allow Pairing", isOn: Binding(get: { model.remoteEnabled }, set: { model.setRemoteAccess($0) }))
                Toggle("Paired Nodes May Type", isOn: Binding(get: { store.mesh?.keyboard ?? true }, set: { on in Task { await store.setKeyboard(on, model) } }))
                    .disabled(store.mesh == nil)
                Toggle("Paired Nodes May Read Files", isOn: Binding(get: { store.mesh?.files ?? true }, set: { on in Task { await store.setFiles(on, model) } }))
                    .disabled(store.mesh == nil)
                // Changing them is a step past reading them: off while reading is (docs/files-v0.md §12.5).
                Toggle("Paired Nodes May Change Files", isOn: Binding(get: { (store.mesh?.files ?? true) && (store.mesh?.changes ?? true) }, set: { on in Task { await store.setChanges(on, model) } }))
                    .disabled(store.mesh == nil || !(store.mesh?.files ?? true))
                // yazi beside a terminal (docs/yazi-v0.md §3); a service that does not know the switch says nothing of it: no row.
                if let tools = store.mesh?.tools {
                    Toggle("Paired Nodes May Open yazi", isOn: Binding(get: { tools }, set: { on in
                        if on { askingTools = true } else { Task { await store.setTools(false, model) } }
                    }))
                }
            } header: {
                SectionLabel("This Mac")
            } footer: {
                Footer("Allow Pairing：手机和其他节点能否连接这台 Mac。Paired Nodes May Type：其他节点能否用键盘直接在这台 Mac 的终端里输入；关闭后它们只能使用回复框和指定按键。Paired Nodes May Read Files：手机和其他节点能否在文件栏中浏览这台 Mac 的文件，各自的范围在下面每一行的 Files 中设置。Paired Nodes May Change Files：它们能否在读得到的范围内新建、改名、移到废纸篓，以及从手机传文件进来；AgentSwitch 自己的文件夹不会被改动。Paired Nodes May Open yazi：其他节点能否在这台 Mac 的终端旁边打开 yazi；yazi 能执行 shell 命令且不经审批，默认关闭；手机始终不能。")
            }
            Section {
                if rows.isEmpty {
                    Text(store.unsupported ? "内置服务版本较旧，不支持节点。" : "No Paired Nodes").foregroundStyle(.secondary)
                }
                ForEach(rows) { row in
                    NodeRowView(row: row, busy: store.busy, filesOn: store.mesh?.files ?? true,
                                setUses: { on in on ? (linking = true) : stopUsing(row) },
                                setUsedBy: { on in on ? navigation.select(.pairing) : stopBeingUsed(row) },
                                setScope: { scope in if let device = row.device { Task { await store.setScope(scope, of: device, model) } } },
                                remove: { removing = row })
                }
            } header: {
                SectionLabel("Nodes")
            } footer: {
                Footer("每一行是一个已配对的节点或手机，两个方向各有一个开关。关闭立即生效；重新打开需要再次配对该方向。Files：它在文件栏中能浏览和附加这台 Mac 的哪些文件。范围只限制其他设备在文件栏中能浏览和附加的文件。配对的设备仍可在终端中让 agent 读取其他位置。SSH Host：这台 Mac 用 ssh 连接该节点时用的主机名（例如 ~/.ssh/config 里的 Host），终端的 Open in VS Code 通过它用 Remote - SSH 打开文件夹；只保存在这台 Mac 上。")
            }
            Section {
                HStack(spacing: 8) {
                    Button("Show Pairing Code…") { navigation.select(.pairing) }
                    Button("Pair With a Link…") { linking = true }.disabled(store.unsupported || !model.daemonReady)
                    Spacer()
                }
            } footer: {
                Footer("要让手机或另一个节点使用这台 Mac：Show Pairing Code。要让这台 Mac 使用另一个节点：在那个节点上生成配对码，复制它的链接，然后 Pair With a Link。")
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }.help("Refresh")
            }
        }
        .task {
            store.watched += 1
            defer { store.watched -= 1 }
            await reload()
            await store.loadMesh(model)
            // The rows follow the nodes while the page is up (the service's poll asks; this keeps it asking often).
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3)); await store.refreshIfDue(model) }
        }
        .sheet(isPresented: $linking) { PairWithLinkSheet().environment(model) }
        .confirmationDialog("允许配对的节点打开 yazi？", isPresented: $askingTools) {
            Button("Turn On", role: .destructive) { Task { await store.setTools(true, model) } }
        } message: {
            Text("配对的节点将能在这台 Mac 的终端旁边打开 yazi，并用它执行 shell 命令，不经过任何人审批。")
        }
        .confirmationDialog("移除「\(removing?.name ?? "")」？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove", role: .destructive) { if let row = removing { Task { await remove(row) } } }
        } message: {
            Text(removing?.node != nil ? "两个方向都会断开；对方会把这台 Mac 从它的列表中移除。再次使用需重新配对。" : "该设备将立即断开连接，再次使用需重新配对。")
        }
    }

    private var addresses: String {
        guard model.remoteEnabled else { return "Pairing Off" }
        guard let remote = model.remote else { return "" }
        let lan = remote.lan.first.map { "LAN \($0)" }
        let tail = remote.tailnet.last.map { "Tailscale \($0)" }
        return [lan, tail].compactMap { $0 }.joined(separator: " · ")
    }

    private func reload() async {
        await model.refreshDevices()
        await store.refresh(model)
    }

    private func stopUsing(_ row: NodeRow) {
        guard let node = row.node else { return }
        Task { await store.stopUsing(node, both: false, model) }
    }

    private func stopBeingUsed(_ row: NodeRow) {
        guard let device = row.device else { return }
        Task { await store.revoke(device, model) }
    }

    private func remove(_ row: NodeRow) async {
        if let node = row.node { await store.stopUsing(node, both: true, model) } else if let device = row.device { await store.revoke(device, model) }
    }
}

/// `[Mac]  Mac mini   Online · 192.168.1.30                 [Remove…]`
///         `This Mac Uses It                                    (on)`
///         `It Uses This Mac                                    (on)`
private struct NodeRowView: View {
    let row: NodeRow
    let busy: Bool
    /// `Paired Nodes May Read Files`: off, the scope stays as it is and cannot be changed.
    var filesOn = true
    let setUses: (Bool) -> Void
    let setUsedBy: (Bool) -> Void
    var setScope: (FileScope) -> Void = { _ in }
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.title3).foregroundStyle(.secondary).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                    Text(row.line).font(.caption).foregroundStyle(row.node?.state == .revoked ? Color.attention : Color.secondary)
                }
                Spacer(minLength: 12)
                Button(role: .destructive, action: remove) { Text("Remove…").foregroundStyle(.red) }.disabled(busy)
            }
            if row.canBeUsed {
                direction("This Mac Uses It", on: row.uses, set: setUses)
            }
            direction("It Uses This Mac", on: row.usedBy, set: setUsedBy)
            if let node = row.node { SSHHostField(node: node.id) }
            // What of this Mac's files it may read (docs/files-v0.md §7.5): a row only while it uses this Mac.
            if let device = row.device, device.files != nil {
                FilesScopeRows(scope: device.files ?? .home, busy: busy, set: setScope)
                    .disabled(!filesOn || busy)
                    .opacity(filesOn ? 1 : 0.5)
            }
        }
        .padding(.vertical, 2)
    }

    private func direction(_ label: String, on: Bool, set: @escaping (Bool) -> Void) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            if !on { Text("Off").font(.caption).foregroundStyle(.tertiary) }
            Toggle(label, isOn: Binding(get: { on }, set: set)).labelsHidden().toggleStyle(.switch).controlSize(.small).disabled(busy)
        }
        .padding(.leading, 34)
    }

    private var symbol: String {
        switch row.kind {
        case .phone: "iphone"
        case .linux: "server.rack"
        case .mac: "desktopcomputer"
        }
    }
}

/// `SSH Host                                  [dellarch      ]`: what this Mac's ssh knows the node by, for opening a
/// terminal's folder in the code editor over SSH (docs/terminal-v0.md §1 Mac "在编辑器中打开"). Kept on this Mac alone.
private struct SSHHostField: View {
    @AppStorage private var host: String

    init(node: String) { _host = AppStorage(wrappedValue: "", EditorLink.sshHostKey(node: node)) }

    var body: some View {
        HStack(spacing: 8) {
            Text("SSH Host").font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            if !host.isEmpty, !EditorLink.validHost(host.trimmingCharacters(in: .whitespaces)) {
                Text("Invalid").font(.caption).foregroundStyle(Color.attention)
            }
            TextField("SSH Host", text: $host, prompt: Text("Host in ~/.ssh/config"))
                .labelsHidden().textFieldStyle(.roundedBorder).font(.callout.monospaced()).frame(width: 180)
        }
        .padding(.leading, 34)
    }
}

/// Pair With a Link: the link another node showed, read back before anything is sent (its name, where it is, the start
/// of its certificate's fingerprint), and whether this Mac is handed to it in return.
struct PairWithLinkSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State var link = ""
    @State private var back = true
    @State private var problem: String?
    @State private var done: String?

    private var payload: PairingPayload? { try? PairingLink.parse(link.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair With a Link").font(.headline)
            Text("在另一个节点的设置中点 Show Pairing Code，复制它的链接，粘贴到这里。").font(.callout).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("agentswitch://pair?p=…", text: $link).textFieldStyle(.roundedBorder).font(.callout.monospaced()).lineLimit(1)
                Button("Paste") { link = NSPasteboard.general.string(forType: .string) ?? link }
            }
            if let payload {
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent("Name", value: payload.name)
                        LabeledContent("Address", value: (payload.lan + payload.tailnet).prefix(3).joined(separator: " · "))
                        LabeledContent("Fingerprint", value: Self.shortFingerprint(payload.fp))
                    }
                    .font(.callout)
                    .padding(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if !link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Label("不是 AgentSwitch 的配对链接。", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.attention).font(.callout)
            }
            Toggle("Let It Use This Mac Too", isOn: $back).disabled(!model.remoteEnabled)
            Text(model.remoteEnabled ? "同时把这台 Mac 交给对方使用，一次配好两个方向。" : "这台 Mac 的 Allow Pairing 已关闭，对方无法使用它。")
                .font(.caption).foregroundStyle(.secondary)
            if let problem { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.attention).font(.callout).textSelection(.enabled) }
            if let done { Label(done, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout) }
            HStack {
                if model.nodes.busy { ProgressView().controlSize(.small) }
                Spacer()
                Button(done == nil ? "Cancel" : "Done") { dismiss() }.keyboardShortcut(.cancelAction)
                if done == nil {
                    Button("Pair") { Task { await pair() } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                        .disabled(payload == nil || model.nodes.busy)
                }
            }
        }
        .padding(20)
        .frame(width: 480)
    }

    private func pair() async {
        problem = nil
        switch await model.nodes.add(link: link, back: back && model.remoteEnabled, model) {
        case .success(let added): done = NodeText.paired(added)
        case .failure(let error): problem = error.reason
        }
    }

    /// `7F3A 19C2 · E804 55B1`: the first sixteen characters, as both nodes would show them.
    static func shortFingerprint(_ fp: String) -> String {
        let head = Array(fp.uppercased().prefix(16))
        guard head.count == 16 else { return fp }
        let group = { (i: Int) in String(head[i..<(i + 4)]) }
        return "\(group(0)) \(group(4)) · \(group(8)) \(group(12))"
    }
}

/// `Files  [Home Folder ▾]`, and under `Selected Folders` each folder with `−`, then `Add Folder…`.
private struct FilesScopeRows: View {
    let scope: FileScope
    let busy: Bool
    let set: (FileScope) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("Files").font(.callout).foregroundStyle(.secondary)
                Spacer(minLength: 12)
                Picker("Files", selection: Binding(get: { scope.mode }, set: { choose($0) })) {
                    ForEach(FileScope.Mode.allCases, id: \.self) { Text(FileScope.word($0)).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
            }
            if scope.mode == .folders {
                ForEach(scope.folders, id: \.self) { folder in
                    HStack(spacing: 6) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(DisplayPath.short(folder, home: NSHomeDirectory())).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Button { set(FileScope(mode: .folders, folders: scope.folders.filter { $0 != folder })) } label: { Image(systemName: "minus") }
                            .buttonStyle(.borderless)
                            .help("Remove")
                    }
                    .padding(.leading, 16)
                }
                Button("Add Folder…") {
                    let more = Self.chooseFolders()
                    if !more.isEmpty { set(FileScope(mode: .folders, folders: scope.folders + more.filter { !scope.folders.contains($0) })) }
                }
                .buttonStyle(.link)
                .padding(.leading, 16)
            }
        }
        .padding(.leading, 34)
    }

    /// A mode chosen; `Selected Folders` with none yet asks for them first (cancelled: nothing changes).
    private func choose(_ mode: FileScope.Mode) {
        guard mode != scope.mode else { return }
        if mode == .folders {
            let chosen = scope.folders.isEmpty ? Self.chooseFolders() : scope.folders
            guard !chosen.isEmpty else { return }
            return set(FileScope(mode: .folders, folders: chosen))
        }
        set(FileScope(mode: mode))
    }

    private static func chooseFolders() -> [String] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Allow"
        guard panel.runModal() == .OK else { return [] }
        return panel.urls.map(\.path)
    }
}
