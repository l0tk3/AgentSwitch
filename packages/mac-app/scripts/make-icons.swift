// Draws the AgentSwitch app icon for both apps with CoreGraphics (no SF Symbols: their license excludes app icons).
// The switch: one input and three lanes, the chosen one solid, the others faint; on the accent blue of docs/ui-v0.md.
// The menu bar glyph (MenuBarGlyph.swift) is the same drawing, bolder.
//
//   swift scripts/make-icons.swift
//
// Writes Resources/AppIcon.icns (macOS: rounded tile on a transparent canvas, per the macOS icon grid) and
// ../ios-app/App/Assets.xcassets/AppIcon.appiconset/icon-1024{,-dark,-tinted}.png (iOS: full bleed, the system applies
// the mask; the dark and tinted variants are the glyph alone on a transparent canvas, the system draws the ground).
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let size = 1024

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

/// `plain`: the accent tile with a white glyph. `dark`: the glyph alone in the dark-mode accent. `tinted`: the glyph
/// alone in white, for the system to tint.
enum Style { case plain, dark, tinted }

func render(tile: CGRect, cornerRadius: CGFloat, shadow: Bool, style: Style = .plain) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let path = CGPath(roundedRect: tile, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

    // The tile: the accent (#2F5BEA), a little lighter at the top; on macOS a soft shadow under it.
    if shadow && style == .plain {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: srgb(0x000000, 0.28))
        ctx.addPath(path)
        ctx.setFillColor(srgb(0x2F5BEA))
        ctx.fillPath()
        ctx.restoreGState()
    }
    if style == .plain { drawTile(ctx, space, path, tile) }
    drawGlyph(ctx, tile, color: style == .dark ? srgb(0x6D8BFF) : srgb(0xFFFFFF))
    return ctx.makeImage()!
}

func drawTile(_ ctx: CGContext, _ space: CGColorSpace, _ path: CGPath, _ tile: CGRect) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: space, colors: [srgb(0x4570F5), srgb(0x2F5BEA), srgb(0x2449CF)] as CFArray,
                              locations: [0, 0.45, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: tile.midX, y: tile.maxY), end: CGPoint(x: tile.midX, y: tile.minY), options: [])
    ctx.restoreGState()
}

func drawGlyph(_ ctx: CGContext, _ tile: CGRect, color: CGColor) {
    // Geometry in tile-relative units (y up) so the glyph scales with the tile.
    let unit = tile.width / 1024
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: tile.minX + x * unit, y: tile.minY + y * unit) }
    let source = p(292, 512)
    let lanes: [CGFloat] = [732, 512, 292]
    let chosen = 0
    func lane(_ y: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.move(to: source)
        path.addCurve(to: p(560, y), control1: p(440, 512), control2: p(412, y))
        path.addLine(to: p(736, y))
        return path
    }
    func dot(_ center: CGPoint, _ r: CGFloat) -> CGRect {
        CGRect(x: center.x - r * unit, y: center.y - r * unit, width: 2 * r * unit, height: 2 * r * unit)
    }
    ctx.setLineWidth(40 * unit)
    ctx.setLineCap(.round)
    ctx.setStrokeColor(color)
    ctx.setFillColor(color)

    // The lanes not taken, as one faint layer (no darker overlaps where they meet).
    ctx.saveGState()
    ctx.setAlpha(0.34)
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    for (i, y) in lanes.enumerated() where i != chosen {
        ctx.addPath(lane(y))
        ctx.strokePath()
        ctx.fillEllipse(in: dot(p(736, y), 50))
    }
    ctx.endTransparencyLayer()
    ctx.restoreGState()

    ctx.addPath(lane(lanes[chosen]))
    ctx.strokePath()
    ctx.fillEllipse(in: dot(p(736, lanes[chosen]), 58))
    ctx.fillEllipse(in: dot(source, 76))
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
let ios = render(tile: CGRect(x: 0, y: 0, width: size, height: size), cornerRadius: 0, shadow: false)
let iconSet = root.deletingLastPathComponent().appendingPathComponent("ios-app/App/Assets.xcassets/AppIcon.appiconset")
let iosIcon = iconSet.appendingPathComponent("icon-1024.png")
try writePNG(ios, to: iosIcon, pixels: 1024)
let full = CGRect(x: 0, y: 0, width: size, height: size)
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
