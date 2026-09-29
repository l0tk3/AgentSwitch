// Draws the AgentSwitch app icon for both apps with CoreGraphics: the pixel mark of docs/ui-v0.md §7 (one source
// switched onto three lanes, the lit one on top) with the depth of an identity mark (§7.2.10: a 1-pixel hard shadow,
// half-lit pixels in the diagonal steps, a faint glow on the lit lane), on the terminal's black with faint scanlines —
// docs/design/visual-v1/depth.html, "应用图标". Every cell is a whole number of pixels at 1024.
//
//   swift scripts/make-icons.swift
//
// Writes Resources/AppIcon.icns (macOS: rounded tile on a transparent canvas, per the macOS icon grid) and
// ../ios-app/App/Assets.xcassets/AppIcon.appiconset/icon-1024{,-dark,-tinted}.png (iOS: full bleed, the system applies
// the mask; the dark and tinted variants are the mark alone on a transparent canvas, the system draws the ground).
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let size = 1024

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

/// PixelArt.markRows (AgentSwitchKit / AgentSwitchMacCore): S the source, a/A the lit lane and its end, b/B and c/C the
/// others.
let mark = [
    "...........AAA",
    "......aaaaaAAA",
    ".....a.....AAA",
    "....a.........",
    "SSSa.......BBB",
    "SSSbbbbbbbbBBB",
    "SSSc.......BBB",
    "....c.........",
    ".....c.....CCC",
    "......cccccCCC",
    "...........CCC",
].map { Array($0) }

func lit(_ c: Character) -> Bool { "aAS".contains(c) }
func on(_ x: Int, _ y: Int) -> Bool { y >= 0 && y < mark.count && x >= 0 && x < mark[y].count && mark[y][x] != "." }

/// Empty cells in an inside corner of a diagonal step, with the cell they lean on (pixel.js aaCells).
let halfLit: [(x: Int, y: Int, c: Character)] = mark.indices.flatMap { y in
    mark[y].indices.compactMap { x -> (x: Int, y: Int, c: Character)? in
        guard mark[y][x] == "." else { return nil }
        let n = on(x, y - 1), s = on(x, y + 1), w = on(x - 1, y), e = on(x + 1, y)
        let corner = (n && e && !on(x + 1, y - 1)) || (n && w && !on(x - 1, y - 1)) || (s && e && !on(x + 1, y + 1)) || (s && w && !on(x - 1, y + 1))
        guard corner, [n, s, w, e].filter({ $0 }).count == 2 else { return nil }
        return (x, y, n ? mark[y - 1][x] : mark[y + 1][x])
    }
}

/// `plain`: the black tile with the mark. `dark`: the mark alone (the system draws the dark ground). `tinted`: the mark
/// alone in greys, for the system to tint.
enum Style { case plain, dark, tinted }

func render(tile: CGRect, cornerRadius: CGFloat, shadow: Bool, style: Style = .plain) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let path = CGPath(roundedRect: tile, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
    if style == .plain {
        if shadow {
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: srgb(0x000000, 0.35))
            ctx.addPath(path)
            ctx.setFillColor(srgb(0x000000))
            ctx.fillPath()
            ctx.restoreGState()
        }
        drawTile(ctx, space, path, tile)
    }
    drawMark(ctx, tile, style: style)
    return ctx.makeImage()!
}

/// Black, a little lifted toward the top left, with scanlines (the terminal window's surface).
func drawTile(_ ctx: CGContext, _ space: CGColorSpace, _ path: CGPath, _ tile: CGRect) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.setFillColor(srgb(0x000000))
    ctx.fill(tile)
    let gradient = CGGradient(colorsSpace: space, colors: [srgb(0x1C1C1F), srgb(0x000000)] as CFArray, locations: [0, 1])!
    let center = CGPoint(x: tile.minX + tile.width * 0.3, y: tile.maxY - tile.height * 0.2)
    ctx.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: tile.width * 1.1, options: [])
    let period = (tile.height / 64).rounded()
    var y = tile.maxY
    ctx.setFillColor(srgb(0xFFFFFF, 0.03))
    while y > tile.minY {
        ctx.fill(CGRect(x: tile.minX, y: y - period / 3, width: tile.width, height: period / 3))
        y -= period
    }
    ctx.restoreGState()
}

/// The mark centred in the tile at about three quarters of its width (with the shadow's extra cell). Cells and their
/// origin fall on multiples of 8 at 1024, so they stay whole pixels down to the 128 export.
func drawMark(_ ctx: CGContext, _ tile: CGRect, style: Style) {
    let cols = mark[0].count, rows = mark.count
    func snap(_ v: CGFloat) -> CGFloat { (v / 8).rounded() * 8 }
    let cell = ((tile.width * 0.75 / CGFloat(cols + 1)) / 8).rounded(.down) * 8
    let originX = snap(tile.midX - CGFloat(cols) * cell / 2)
    let top = snap(tile.midY + CGFloat(rows) * cell / 2)
    func rect(_ x: Int, _ y: Int) -> CGRect { CGRect(x: originX + CGFloat(x) * cell, y: top - CGFloat(y + 1) * cell, width: cell, height: cell) }
    let cells = mark.indices.flatMap { y in mark[y].indices.compactMap { x in mark[y][x] == "." ? nil : (x: x, y: y, c: mark[y][x]) } }

    let ink: UInt32 = style == .tinted ? 0xFFFFFF : 0xE9E6DF
    let dim: UInt32 = style == .tinted ? 0x7A7A7A : 0x5B5955
    func tone(_ c: Character) -> CGColor { srgb(lit(c) ? ink : dim) }

    // A faint glow under the lit lane.
    if style != .tinted {
        ctx.saveGState()
        ctx.setShadow(offset: .zero, blur: cell * 0.9, color: srgb(0xE9E6DF, 0.55))
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setFillColor(srgb(0xE9E6DF, 0.28))
        for c in cells where lit(c.c) { ctx.fill(rect(c.x, c.y)) }
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }
    // The hard shadow: one cell down and right, a step darker than the ground.
    if style == .plain {
        ctx.setFillColor(srgb(0x2C2A28))
        for c in cells { ctx.fill(rect(c.x + 1, c.y + 1)) }
    }
    for h in halfLit {
        ctx.setFillColor(tone(h.c).copy(alpha: 0.42)!)
        ctx.fill(rect(h.x, h.y))
    }
    for c in cells {
        ctx.setFillColor(tone(c.c))
        ctx.fill(rect(c.x, c.y))
    }
}

func writePNG(_ image: CGImage, to url: URL, pixels: Int) throws {
    let rep = NSBitmapImageRep(cgImage: image)
    let scaled = NSImage(size: NSSize(width: pixels, height: pixels))
    scaled.addRepresentation(rep)
    guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { throw CocoaError(.fileWriteUnknown) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
    NSGraphicsContext.current?.imageInterpolation = .high
    scaled.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    try out.representation(using: .png, properties: [:])!.write(to: url)
}

// iOS: full bleed, opaque.
let full = CGRect(x: 0, y: 0, width: size, height: size)
let iconSet = root.deletingLastPathComponent().appendingPathComponent("ios-app/App/Assets.xcassets/AppIcon.appiconset")
let iosIcon = iconSet.appendingPathComponent("icon-1024.png")
try writePNG(render(tile: full, cornerRadius: 0, shadow: false), to: iosIcon, pixels: 1024)
try writePNG(render(tile: full, cornerRadius: 0, shadow: false, style: .dark), to: iconSet.appendingPathComponent("icon-1024-dark.png"), pixels: 1024)
try writePNG(render(tile: full, cornerRadius: 0, shadow: false, style: .tinted), to: iconSet.appendingPathComponent("icon-1024-tinted.png"), pixels: 1024)

// macOS: 824-pt tile with ~185-pt corners centred on the 1024 canvas.
let mac = render(tile: CGRect(x: 100, y: 100, width: 824, height: 824), cornerRadius: 185, shadow: true)
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try writePNG(mac, to: iconset.appendingPathComponent("icon_\(base)x\(base).png"), pixels: base)
    try writePNG(mac, to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"), pixels: base * 2)
}
let resources = root.appendingPathComponent("Resources")
try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", resources.appendingPathComponent("AppIcon.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("wrote \(iosIcon.path) and \(resources.appendingPathComponent("AppIcon.icns").path)")
