// Draws the AgentSwitch app icon for both apps with CoreGraphics: the app's mark as its shaded picture (docs/ui-v0.md §9,
// `ShadedSprite.dispatch`: one source switched onto three lanes, the nearest lane and its end the lightest, each further
// one a tone darker, the blocks raised — tones of the one ink and no hue), over a hard shadow a cell down and right and
// a faint glow on the nearest lane, on the terminal's black with faint scanlines. Every cell is a whole number of pixels
// at 1024.
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

/// `ShadedSprite.dispatch` (AgentSwitchLive / AgentSwitchMacCore; keep in step): one character a cell, `.` clear, the
/// others the ink's tones from highlight to ground.
let mark = [
    "............WWW#", ".........###W##m", ".......###..W##m", "......##....#mmd", ".....##.........", "....##..........",
    "WWW##.......mmmd", "W##mmmmmmmmmmddk", "W##mddddddddmddk", "#mmdd.......dkkk", "....dd..........", ".....dd.........",
    "......dd....dddk", ".......ddd..dkks", ".........ddddkks", "............ksss",
].map { Array($0) }

/// The tones on the tile's black; for the tinted variant plain greys the system tints, the darkest lifted so the
/// furthest lane still reads.
let tones: [Character: UInt32] = ["W": 0xFFFFFF, "#": 0xE9E6DF, "m": 0xA9A6A0, "d": 0x6F6C68, "k": 0x3B3A37, "s": 0x1E1D1B]
let tintedTones: [Character: UInt32] = ["W": 0xFFFFFF, "#": 0xE4E4E4, "m": 0xA6A6A6, "d": 0x767676, "k": 0x525252, "s": 0x3C3C3C]

/// The nearest lane with its source and its end — the two lightest tones, above the middle lane or in the source: what
/// the glow sits under.
func near(_ x: Int, _ y: Int) -> Bool { "W#".contains(mark[y][x]) && (y <= 6 || x <= 2) }

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

/// The mark centred in the tile at about five eighths of its width (the shadow's extra cell beside it). Cells and their
/// origin fall on multiples of 8 at 1024, so they stay whole pixels down to the 128 export.
func drawMark(_ ctx: CGContext, _ tile: CGRect, style: Style) {
    let cols = mark[0].count, rows = mark.count
    func snap(_ v: CGFloat) -> CGFloat { (v / 8).rounded() * 8 }
    let cell = ((tile.width * 0.75 / CGFloat(cols + 1)) / 8).rounded(.down) * 8
    let originX = snap(tile.midX - CGFloat(cols) * cell / 2)
    let top = snap(tile.midY + CGFloat(rows) * cell / 2)
    func rect(_ x: Int, _ y: Int) -> CGRect { CGRect(x: originX + CGFloat(x) * cell, y: top - CGFloat(y + 1) * cell, width: cell, height: cell) }
    let cells = mark.indices.flatMap { y in mark[y].indices.compactMap { x in mark[y][x] == "." ? nil : (x: x, y: y, c: mark[y][x]) } }
    let palette = style == .tinted ? tintedTones : tones

    // A faint glow under the nearest lane.
    if style != .tinted {
        ctx.saveGState()
        ctx.setShadow(offset: .zero, blur: cell * 0.9, color: srgb(0xE9E6DF, 0.5))
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setFillColor(srgb(0xE9E6DF, 0.28))
        for c in cells where near(c.x, c.y) { ctx.fill(rect(c.x, c.y)) }
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }
    // The hard shadow: one cell down and right, a step off the ground.
    if style == .plain {
        ctx.setFillColor(srgb(0x2C2A28))
        for c in cells { ctx.fill(rect(c.x + 1, c.y + 1)) }
    }
    for c in cells {
        ctx.setFillColor(srgb(palette[c.c] ?? 0xFF00FF))
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
