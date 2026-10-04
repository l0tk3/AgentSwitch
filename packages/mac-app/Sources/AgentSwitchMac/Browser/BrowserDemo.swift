#if DEBUG
import AgentSwitchMacCore
import AppKit

/// A made-up shared browser for the Browser page in `-designPreview` (MainWindowPreview.swift), the tabs of the demo page
/// `docs/design/implemented/browser.html`: Codex in a terminal on a pull request (busy, its last click boxed) and an issue
/// list, a task's login waiting for a code, and yours — a file of the Mac's and a local dev server. Each tab's frame is a
/// picture drawn here (JPEG, as the daemon sends). Reads answer from the data; writes are accepted and change nothing.
struct BrowserDemoService: BrowserService {
    let list: BrowserTabList
    let frames: [String: BrowserFrame]
    let servers: [BrowserLocalServer]

    static let codex = BrowserOwner(kind: .terminal, id: "k1", label: "codex · AgentSwitch")
    static let task = BrowserOwner(kind: .task, id: "t7", label: "登录财务平台下载对账单")
    /// The pull request's merge button on its page (CSS pixels = the frame's here).
    static let mergeBox = BrowserBox(x: 48, y: 446, width: 172, height: 36)

    /// The page each made-up tab shows, in the order their pictures are drawn.
    @MainActor static let pages: [(id: String, page: DemoPage)] = [("pr", .pullRequest), ("issues", .issues), ("portal", .login),
                                                                   ("mesh", .file), ("vite", .dev)]

    /// The picture of a tab at a size this Mac set (the page's zoom, MainWindowPreview): the made-up browser itself
    /// never resizes its pictures.
    @MainActor
    static func frame(of id: String, sized viewport: BrowserViewportRequest) -> BrowserFrame? {
        pages.first { $0.id == id }.map {
            DemoPage.frame($0.page, viewport: CGSize(width: viewport.width, height: viewport.height), scale: viewport.scale)
        }
    }

    /// `holding`: the tab this Mac holds (after `[ Take Over ]`: `pr`, the pull request; `portal`, the task's login;
    /// `vite`: your dev server's page, on this screen); `empty`: no tabs at all.
    @MainActor
    init(holding: String? = nil, empty: Bool = false) {
        let at = Date()
        let held = { (id: String) in holding == id ? BrowserDefaults.screen : nil }
        let pr = BrowserTab(id: "pr", owner: Self.codex, title: "Add native Dispatch page · Pull Request #128",
                            url: "https://github.com/acme/app/pull/128", site: "github.com", status: holding == "pr" ? .idle : .busy,
                            heldBy: held("pr"),
                            action: BrowserAction(tool: "browser_click", description: #"click "Merge pull request""#, box: Self.mergeBox, at: at),
                            openedAt: at)
        let issues = BrowserTab(id: "issues", owner: Self.codex, title: "Issues · acme/app", url: "https://github.com/acme/app/issues",
                                site: "github.com", openedAt: at)
        let portal = BrowserTab(id: "portal", owner: Self.task, title: "登录 · 财务平台", url: "https://portal.example.com/login",
                                site: "portal.example.com", status: holding == "portal" ? .idle : .waiting, heldBy: held("portal"),
                                action: BrowserAction(tool: "user", description: "等你：短信验证码"), openedAt: at)
        let mesh = BrowserTab(id: "mesh", title: "mesh.html", url: "file:///Users/me/Projects/AgentSwitch/docs/design/concepts/mesh.html",
                              site: "~/Projects/AgentSwitch/docs/design", kind: .file, openedAt: at)
        let vite = BrowserTab(id: "vite", title: "Acme · Dev", url: "http://localhost:5173/", site: "localhost:5173", kind: .local,
                              heldBy: held("vite"), openedAt: at)
        list = empty ? .empty : BrowserTabList(running: true, groups: [
            BrowserTabGroup(owner: Self.codex, tabs: [pr, issues]),
            BrowserTabGroup(owner: Self.task, tabs: [portal]),
            BrowserTabGroup(owner: .you, tabs: [mesh, vite]),
        ])
        frames = Dictionary(uniqueKeysWithValues: Self.pages.map { ($0.id, DemoPage.frame($0.page)) })
        servers = [
            BrowserLocalServer(port: 5173, pid: 4242, name: "vite", cwd: NSHomeDirectory() + "/Projects/site"),
            BrowserLocalServer(port: 3000, bind: "all", pid: 4343, name: "next dev", cwd: NSHomeDirectory() + "/Projects/web"),
        ]
    }

    func browserTabs() async throws -> BrowserTabList { list }

    func openTab(_ target: BrowserTarget) async throws -> BrowserTab {
        throw DaemonError.http(status: 403, message: "演示数据，未打开。")
    }

    func closeTab(id: String) async throws {}

    /// The tab, then its picture; the stream stays open, as the daemon's does.
    func tabStream(id: String, options: BrowserStreamOptions) -> AsyncThrowingStream<BrowserStreamEvent, Error> {
        let tab = list.tab(id), frame = frames[id]
        return AsyncThrowingStream { continuation in
            if let tab { continuation.yield(.tab(tab)) }
            if let frame { continuation.yield(.frame(frame)) }
        }
    }

    func sendInput(tabId: String, events: [BrowserInputEvent], screen: String) async throws {}
    func navigate(tabId: String, to target: BrowserTarget, screen: String) async throws -> BrowserTab { try tab(tabId) }
    func history(tabId: String, _ action: BrowserHistoryAction, screen: String) async throws -> BrowserTab { try tab(tabId) }
    func takeOver(tabId: String, screen: String) async throws -> BrowserTab { try tab(tabId) }
    func handBack(tabId: String, screen: String) async throws -> BrowserTab { try tab(tabId) }
    func setViewport(tabId: String, _ viewport: BrowserViewportRequest, screen: String) async throws -> BrowserTab { try tab(tabId) }
    func localServers() async throws -> [BrowserLocalServer] { servers }

    func fill(tabId: String, token: String, screen: String) async throws -> BrowserFillResult {
        throw DaemonError.http(status: 403, message: "演示数据，未填入。")
    }

    private func tab(_ id: String) throws -> BrowserTab {
        guard let tab = list.tab(id) else { throw DaemonError.http(status: 404, message: "not found") }
        return tab
    }

    static let recents = ["https://github.com/acme/app/pulls", "http://localhost:5173/",
                          "file:///Users/me/Projects/AgentSwitch/docs/design/implemented/browser.html"]
}

/// The made-up pages, drawn into 1280 × 800 JPEG frames: other people's sites in their own colours (the demo's
/// `--site-*`), the Mac's file and dev server dark.
@MainActor
enum DemoPage {
    case pullRequest, issues, login, file, dev

    static let size = CGSize(width: 1280, height: 800)

    /// `viewport`, `scale`: the page's size in CSS pixels and the frame pixels to each — the tabs' own 1280 × 800 at 1,
    /// or the size and the pixels of a tab this Mac sized (a zoomed page). The pages are drawn for 1280 × 800 and do not
    /// reflow: a smaller viewport shows their top left.
    static func frame(_ page: DemoPage, viewport: CGSize = size, scale: Double = 1) -> BrowserFrame {
        let width = (Double(viewport.width) * scale).rounded(), height = (Double(viewport.height) * scale).rounded()
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width), pixelsHigh: Int(height), bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: rep)!
        let flipped = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
        context.cgContext.translateBy(x: 0, y: height)
        context.cgContext.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = flipped
        draw(page)
        NSGraphicsContext.restoreGraphicsState()
        let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) ?? Data()
        return BrowserFrame(seq: 1, data: jpeg.base64EncodedString(), width: width, height: height, scale: scale)
    }

    // MARK: drawing

    private static func hex(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }

    private static func fill(_ rect: CGRect, _ color: NSColor, radius: CGFloat = 0) {
        color.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
    }

    private static func stroke(_ rect: CGRect, _ color: NSColor, radius: CGFloat = 0, width: CGFloat = 1) {
        color.setStroke()
        let path = NSBezierPath(roundedRect: rect.insetBy(dx: width / 2, dy: width / 2), xRadius: radius, yRadius: radius)
        path.lineWidth = width
        path.stroke()
    }

    private static func text(_ string: String, _ at: CGPoint, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor, mono: Bool = false) {
        let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
        (string as NSString).draw(at: at, withAttributes: [.font: font, .foregroundColor: color])
    }

    private static func width(_ string: String, size: CGFloat, weight: NSFont.Weight = .regular) -> CGFloat {
        (string as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: weight)]).width
    }

    private static let ink = hex(0x1F2328), ink2 = hex(0x59636E), line = hex(0xD1D9E0), green = hex(0x1F883D), blue = hex(0x0969DA)

    private static func draw(_ page: DemoPage) {
        switch page {
        case .pullRequest: pullRequest()
        case .issues: issues()
        case .login: login()
        case .file: file()
        case .dev: dev()
        }
    }

    private static func gitHubTop() {
        fill(CGRect(origin: .zero, size: size), .white)
        fill(CGRect(x: 0, y: 0, width: size.width, height: 64), hex(0x1F2328))
        fill(CGRect(x: 24, y: 18, width: 28, height: 28), .white, radius: 14)
        text("acme / app", CGPoint(x: 66, y: 20), size: 17, weight: .semibold, color: .white)
        fill(CGRect(x: 900, y: 16, width: 300, height: 32), hex(0x2D333B), radius: 6)
        text("Type / to search", CGPoint(x: 914, y: 23), size: 13, color: hex(0x8B949E))
    }

    private static func pullRequest() {
        gitHubTop()
        text("Add native Dispatch page", CGPoint(x: 48, y: 96), size: 30, weight: .regular, color: ink)
        text("#128", CGPoint(x: 48 + width("Add native Dispatch page ", size: 30), y: 96), size: 30, color: ink2)
        fill(CGRect(x: 48, y: 148, width: 86, height: 30), green, radius: 15)
        text("⟟ Open", CGPoint(x: 64, y: 154), size: 14, weight: .semibold, color: .white)
        text("codex-bot wants to merge 14 commits into main from codex/dispatch-page", CGPoint(x: 148, y: 154), size: 14, color: ink2)
        var x: CGFloat = 48
        for (n, tab) in ["Conversation 4", "Commits 14", "Checks 3", "Files changed 38"].enumerated() {
            text(tab, CGPoint(x: x, y: 206), size: 14, weight: n == 0 ? .semibold : .regular, color: n == 0 ? ink : ink2)
            if n == 0 { fill(CGRect(x: x - 8, y: 236, width: width(tab, size: 14, weight: .semibold) + 16, height: 2), hex(0xFD8C73)) }
            x += width(tab, size: 14) + 40
        }
        fill(CGRect(x: 0, y: 238, width: size.width, height: 1), line)
        stroke(CGRect(x: 48, y: 268, width: 860, height: 236), line, radius: 8)
        for (n, check) in ["All checks have passed", "3 successful checks", "No conflicts with base branch"].enumerated() {
            fill(CGRect(x: 72, y: 296 + CGFloat(n) * 40, width: 20, height: 20), green, radius: 10)
            text(check, CGPoint(x: 104, y: 296 + CGFloat(n) * 40), size: 15, weight: n == 1 ? .regular : .semibold, color: n == 1 ? ink2 : ink)
        }
        fill(CGRect(x: 48, y: 420, width: 860, height: 1), line)
        let merge = BrowserDemoService.mergeBox
        fill(CGRect(x: merge.x, y: merge.y, width: merge.width, height: merge.height), green, radius: 6)
        text("Merge pull request", CGPoint(x: merge.x + 16, y: merge.y + 9), size: 14, weight: .semibold, color: .white)
        text("You can also open this in GitHub Desktop or view command line instructions.", CGPoint(x: 236, y: 455), size: 13, color: ink2)
        text("Reviewers", CGPoint(x: 960, y: 274), size: 13, weight: .semibold, color: ink2)
        text("No reviews", CGPoint(x: 960, y: 298), size: 13, color: ink2)
        text("Labels", CGPoint(x: 960, y: 344), size: 13, weight: .semibold, color: ink2)
        fill(CGRect(x: 960, y: 368, width: 86, height: 24), hex(0xDDF4FF), radius: 12)
        text("mac-app", CGPoint(x: 974, y: 372), size: 12, weight: .semibold, color: blue)
        for n in 0..<3 {
            let y = 540 + CGFloat(n) * 76
            fill(CGRect(x: 48, y: y, width: 36, height: 36), hex(0xEAEEF2), radius: 18)
            text(["codex-bot pushed 3 commits", "codex-bot requested a review", "CI · build and test"][n], CGPoint(x: 100, y: y + 2), size: 14, weight: .semibold, color: ink)
            text(["2 minutes ago", "5 minutes ago", "all jobs succeeded"][n], CGPoint(x: 100, y: y + 24), size: 13, color: ink2)
        }
    }

    private static func issues() {
        gitHubTop()
        text("Issues", CGPoint(x: 48, y: 96), size: 30, color: ink)
        text("12 Open · 48 Closed", CGPoint(x: 48, y: 146), size: 14, weight: .semibold, color: ink2)
        for n in 0..<8 {
            let y = 190 + CGFloat(n) * 64
            fill(CGRect(x: 48, y: y, width: 1184, height: 1), line)
            fill(CGRect(x: 60, y: y + 22, width: 16, height: 16), green, radius: 8)
            text(["Dispatch page loses scroll position", "Terminal list flickers on resize", "Browser: show the agent's last click",
                  "Live Activity counts finished tasks", "Gateway status stays red after restart", "Pair a second phone",
                  "Settings: remember the last page", "Crash when the folder is removed"][n], CGPoint(x: 92, y: y + 18), size: 15, weight: .semibold, color: ink)
        }
    }

    private static func login() {
        fill(CGRect(origin: .zero, size: size), hex(0xF6F8FA))
        fill(CGRect(x: 440, y: 120, width: 400, height: 470), .white, radius: 8)
        stroke(CGRect(x: 440, y: 120, width: 400, height: 470), line, radius: 8)
        text("财务平台", CGPoint(x: 590, y: 160), size: 26, weight: .semibold, color: ink)
        text("邮箱", CGPoint(x: 472, y: 230), size: 14, weight: .semibold, color: ink)
        stroke(CGRect(x: 472, y: 256, width: 336, height: 40), line, radius: 6)
        text("finance@me.com", CGPoint(x: 486, y: 266), size: 15, color: ink)
        text("短信验证码", CGPoint(x: 472, y: 318), size: 14, weight: .semibold, color: ink)
        stroke(CGRect(x: 472, y: 344, width: 336, height: 40), blue, radius: 6, width: 2)
        text("请输入 6 位验证码", CGPoint(x: 486, y: 354), size: 15, color: ink2)
        fill(CGRect(x: 472, y: 420, width: 336, height: 42), green, radius: 6)
        text("登录", CGPoint(x: 624, y: 431), size: 16, weight: .semibold, color: .white)
    }

    private static func file() {
        fill(CGRect(origin: .zero, size: size), .black)
        let paper = hex(0xE9E6DF), dim = hex(0x8D8A84)
        text("Mesh · 网状连接（演示）", CGPoint(x: 40, y: 40), size: 20, weight: .bold, color: paper, mono: true)
        text("每台 Mac 本来就是服务端，手机连上任意一台即可。", CGPoint(x: 40, y: 80), size: 15, color: dim)
        for (n, name) in ["MacBook Pro", "Mac mini", "iPad", "iPhone 17 Pro"].enumerated() {
            let x: CGFloat = 40 + CGFloat(n % 2) * 300, y: CGFloat = 140 + CGFloat(n / 2) * 110
            stroke(CGRect(x: x, y: y, width: 200, height: 56), hex(0x4D4B48))
            text(name, CGPoint(x: x + 16, y: y + 18), size: 15, color: paper, mono: true)
        }
        text("──────", CGPoint(x: 248, y: 158), size: 15, color: dim, mono: true)
        text("┈┈┈┈┈┈", CGPoint(x: 248, y: 268), size: 15, color: dim, mono: true)
    }

    private static func dev() {
        fill(CGRect(origin: .zero, size: size), hex(0x0D1117))
        let gradient = NSGradient(starting: hex(0x6D28D9), ending: hex(0xDB2777))
        gradient?.draw(in: CGRect(x: 0, y: 0, width: size.width, height: 96), angle: 0)
        text("Acme · Dev", CGPoint(x: 40, y: 30), size: 28, weight: .bold, color: .white)
        text("vite v6 · HMR connected", CGPoint(x: 40, y: 128), size: 15, color: hex(0x9DA7B3))
        fill(CGRect(x: 40, y: 168, width: 560, height: 120), hex(0x161B22), radius: 8)
        text("Dashboard", CGPoint(x: 64, y: 188), size: 15, color: hex(0x9DA7B3))
        text("$12,480", CGPoint(x: 64, y: 216), size: 40, weight: .bold, color: hex(0xE6EDF3))
        fill(CGRect(x: 40, y: 312, width: 560, height: 80), hex(0x161B22), radius: 8)
        text("改了 src/App.tsx，热更新后这里立即变。", CGPoint(x: 64, y: 342), size: 15, color: hex(0x9DA7B3))
    }
}
#endif
