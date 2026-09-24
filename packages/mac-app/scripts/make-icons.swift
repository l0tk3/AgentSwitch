// Draws the AgentSwitch app icon for both apps with CoreGraphics (no SF Symbols: their license excludes app icons).
// One node on the left routes to three on the right: a task dispatched to the agents.
//
//   swift scripts/make-icons.swift
//
// Writes Resources/AppIcon.icns (macOS: rounded tile on a transparent canvas, per the macOS icon grid) and
// ../ios-app/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png (iOS: full bleed, the system applies the mask).
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let size = 1024

func render(tile: CGRect, cornerRadius: CGFloat) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let path = CGPath(roundedRect: tile, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)

    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: space, colors: [
        CGColor(srgbRed: 0.24, green: 0.36, blue: 0.89, alpha: 1),
        CGColor(srgbRed: 0.43, green: 0.26, blue: 0.85, alpha: 1),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: tile.minX, y: tile.maxY), end: CGPoint(x: tile.maxX, y: tile.minY), options: [])
    ctx.restoreGState()

    // Geometry in tile-relative units so the glyph scales with the tile.
    let unit = tile.width / 1024
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: tile.minX + x * unit, y: tile.minY + y * unit) }
    let source = p(330, 512)
    let targets = [p(700, 300), p(700, 512), p(700, 724)]

    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.95))
    ctx.setLineWidth(46 * unit)
    ctx.setLineCap(.round)
    for t in targets {
        ctx.move(to: source)
        ctx.addCurve(to: t, control1: p(500, 512), control2: CGPoint(x: tile.minX + 530 * unit, y: t.y))
    }
    ctx.strokePath()

    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fillEllipse(in: CGRect(x: source.x - 82 * unit, y: source.y - 82 * unit, width: 164 * unit, height: 164 * unit))
    for t in targets {
        ctx.fillEllipse(in: CGRect(x: t.x - 60 * unit, y: t.y - 60 * unit, width: 120 * unit, height: 120 * unit))
    }
    return ctx.makeImage()!
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
let ios = render(tile: CGRect(x: 0, y: 0, width: size, height: size), cornerRadius: 0)
let iosIcon = root.deletingLastPathComponent().appendingPathComponent("ios-app/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
try writePNG(ios, to: iosIcon, pixels: 1024)

// macOS: 824-pt tile with ~185-pt corners centred on the 1024 canvas.
let mac = render(tile: CGRect(x: 100, y: 100, width: 824, height: 824), cornerRadius: 185)
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
