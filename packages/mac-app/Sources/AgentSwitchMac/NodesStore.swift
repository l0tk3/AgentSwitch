import AgentSwitchMacCore
import Foundation
import Observation

/// The nodes this Mac uses (docs/mesh-v0.md), as its own service keeps them, and what paired nodes may do here: read
/// again every few seconds while a screen that shows them is up, seldom otherwise. Kept by the app's model, like the
/// devices beside it; Settings › Nodes and the main window's node menu read it.
@MainActor
@Observable
final class NodesStore {
    /// Nil until the service has answered once.
    private(set) var list: NodeList?
    private(set) var mesh: MeshSettings?
    /// The service has no such routes (an older one): no node menu, and the settings page says so.
    private(set) var unsupported = false
    private(set) var busy = false
    /// A screen that shows the nodes is up (the settings page; the main window while it uses another node).
    @ObservationIgnored var watched = 0
    @ObservationIgnored private var asked = Date.distantPast

    var nodes: [NodeStatus] { list?.nodes ?? [] }
    func node(_ id: String?) -> NodeStatus? { id.flatMap { id in nodes.first { $0.id == id } } }

    /// While watched; with nodes in the book and nobody looking; with none.
    static let watchedEvery: TimeInterval = 3
    static let idleEvery: TimeInterval = 20
    static let emptyEvery: TimeInterval = 120

    /// The service's poll: asks when it is time.
    func refreshIfDue(_ model: AppModel, now: Date = Date()) async {
        guard !unsupported else { return }
        let every = watched > 0 ? Self.watchedEvery : nodes.isEmpty ? Self.emptyEvery : Self.idleEvery
        guard now.timeIntervalSince(asked) >= every else { return }
        await refresh(model)
    }

    func refresh(_ model: AppModel) async {
        guard model.daemonReady else { return }
        asked = Date()
        do {
            let fresh = try await model.client.nodes()
            if fresh != list { list = fresh }
            unsupported = false
        } catch DaemonError.notSupported {
            unsupported = true
            list = nil
        } catch {
            // Not answering just now: what was read last stays.
        }
    }

    func loadMesh(_ model: AppModel) async {
        guard model.daemonReady, !unsupported else { return }
        if let fresh = try? await model.client.meshSettings(), fresh != mesh { mesh = fresh }
    }

    func setKeyboard(_ on: Bool, _ model: AppModel) async {
        do { mesh = try await model.client.saveMeshSettings(MeshSettings(keyboard: on, files: mesh?.files ?? true, changes: mesh?.changes ?? true, tools: mesh?.tools)) } catch { model.errorMessage = error.localizedDescription }
    }

    /// `Paired Nodes May Read Files` (docs/files-v0.md §7.5).
    func setFiles(_ on: Bool, _ model: AppModel) async {
        do { mesh = try await model.client.saveMeshSettings(MeshSettings(keyboard: mesh?.keyboard ?? true, files: on, changes: mesh?.changes ?? true, tools: mesh?.tools)) } catch { model.errorMessage = error.localizedDescription }
    }

    /// `Paired Nodes May Change Files` (docs/files-v0.md §12.5).
    func setChanges(_ on: Bool, _ model: AppModel) async {
        do { mesh = try await model.client.saveMeshSettings(MeshSettings(keyboard: mesh?.keyboard ?? true, files: mesh?.files ?? true, changes: on, tools: mesh?.tools)) } catch { model.errorMessage = error.localizedDescription }
    }

    /// `Paired Nodes May Open yazi` (docs/yazi-v0.md §3).
    func setTools(_ on: Bool, _ model: AppModel) async {
        do { mesh = try await model.client.saveMeshSettings(MeshSettings(keyboard: mesh?.keyboard ?? true, files: mesh?.files ?? true, changes: mesh?.changes ?? true, tools: on)) } catch { model.errorMessage = error.localizedDescription }
    }

    /// What of this Mac's files a paired device may read; the devices read again for their rows.
    func setScope(_ scope: FileScope, of device: Device, _ model: AppModel) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await model.client.setDeviceFiles(id: device.id, scope: scope)
            await model.refreshDevices()
        } catch { model.errorMessage = (error as? DaemonError)?.reason ?? error.localizedDescription }
    }

    /// Pair with the node a link names; the answer, or why not in the service's own words.
    func add(link: String, back: Bool, _ model: AppModel) async -> Result<NodeAdded, DaemonError> {
        busy = true
        defer { busy = false }
        do {
            let added = try await model.client.addNode(link: link.trimmingCharacters(in: .whitespacesAndNewlines), back: back)
            await refresh(model)
            await model.refreshDevices()
            return .success(added)
        } catch let error as DaemonError {
            return .failure(error)
        } catch {
            return .failure(.unreachable(error.localizedDescription))
        }
    }

    /// This Mac stops using a node (it is told); `both`: it stops using this Mac as well.
    func stopUsing(_ node: NodeStatus, both: Bool, _ model: AppModel) async {
        busy = true
        defer { busy = false }
        do {
            try await model.client.removeNode(id: node.id, both: both)
            // What the window remembered of its pages goes with it.
            NativeTerminalsPage.forget(node: node.id)
        } catch { model.errorMessage = error.localizedDescription }
        await refresh(model)
        await model.refreshDevices()
    }

    /// A node or a phone stops using this Mac: its device here is revoked.
    func revoke(_ device: Device, _ model: AppModel) async {
        busy = true
        defer { busy = false }
        do { try await model.client.revokeDevice(id: device.id) } catch { model.errorMessage = error.localizedDescription }
        await model.refreshDevices()
        await refresh(model)
    }

    #if DEBUG
    /// `-designPreview`: what the pictures show.
    func loadDemo(_ list: NodeList?, mesh: MeshSettings = MeshSettings()) {
        self.list = list
        self.mesh = mesh
    }
    #endif
}
