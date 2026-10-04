// Writes the AgentSwitch app icon for both apps (docs/ui-v0.md §10): three windows one behind another, the front one
// waiting at its prompt. Two icons, each a layered Icon Composer document the system draws itself:
//
//   AppIcon.icon        the classic one, Liquid Glass: a black ground, three glass windows, a dark prompt and cursor
//   AppIconPixel.icon   the pixel one: the same picture cell by cell in the ink's six tones, flat
//
// Neither has a hue: black, white and the greys between (the user, of the cursor that was blue: 这个黑色就行).
//
//   swift scripts/make-icons.swift
//
// Writes Resources/AppIcon.icon and Resources/AppIconPixel.icon (the Mac's bundle icon is the classic one),
// Resources/AppIconPixel.png (the Dock's icon while the app runs in the pixel look, DockIcon.swift), and the same two
// documents into ../ios-app/App (the pixel one is the alternate icon there). Needs Xcode's Icon Composer for the PNG.
import AppKit
import CoreGraphics
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let size = 1024

func svg(_ body: String) -> String {
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(size)\" height=\"\(size)\" viewBox=\"0 0 \(size) \(size)\">\(body)</svg>\n"
}

// MARK: the classic icon

/// A window: 470 × 340, corners of 70; each one behind is 88 right and up.
func window(_ step: Int, opacity: Double) -> String {
    let x = 189 + 88 * step, y = 430 - 88 * step
    let fade = opacity < 1 ? " fill-opacity=\"\(opacity)\"" : ""
    return svg("<rect x=\"\(x)\" y=\"\(y)\" width=\"470\" height=\"340\" rx=\"70\" fill=\"#ffffff\"\(fade)/>")
}

func stroke(_ path: String, _ color: String) -> String {
    svg("<path d=\"\(path)\" fill=\"none\" stroke=\"\(color)\" stroke-width=\"44\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>")
}

let ground = "{ \"linear-gradient\" : [ \"display-p3:0.17,0.17,0.19,1.0\", \"display-p3:0.03,0.03,0.04,1.0\" ] }"

func glass(_ name: String, translucency: Double) -> String {
    """
        { "name" : "\(name)", "layers" : [ { "image-name" : "\(name).svg", "name" : "\(name)", "glass" : true } ],
          "shadow" : { "kind" : "neutral", "opacity" : 0.5 }, "translucency" : { "enabled" : true, "value" : \(translucency) }, "specular" : true }
    """
}

/// The ground is the same black in the light and the dark style: the app's own surface (ui-v0 §8).
func document(ground: String, groups: [String]) -> String {
    """
    {
      "fill" : \(ground),
      "fill-specializations" : [ { "value" : \(ground) }, { "appearance" : "dark", "value" : \(ground) } ],
      "groups" : [
    \(groups.joined(separator: ",\n"))
      ],
      "supported-platforms" : { "circles" : [ "watchOS" ], "squares" : "shared" }
    }

    """
}

let classic = (
    json: document(ground: ground, groups: [
        """
            { "name" : "prompt", "layers" : [ { "image-name" : "prompt.svg", "name" : "prompt", "glass" : false } ],
              "shadow" : { "kind" : "none", "opacity" : 0 }, "translucency" : { "enabled" : false, "value" : 0.5 }, "specular" : false }
        """,
        glass("front", translucency: 0.5), glass("mid", translucency: 0.6), glass("back", translucency: 0.7),
    ]),
    assets: [
        "front.svg": window(0, opacity: 1), "mid.svg": window(1, opacity: 0.5), "back.svg": window(2, opacity: 0.28),
        // The prompt and its cursor, one dark ink.
        "prompt.svg": stroke("M277 538 L349 600 L277 662 M413 662 L513 662", "#141416"),
    ]
)

// MARK: the pixel icon

/// A window as a plain raised panel, 12 × 9 cells with its corners clipped (no title bar; the user: 这个把顶栏去掉):
/// one character a cell, the ink's tones from highlight to ground (ShadedSprite: W # m d k s). `light` is its edge
/// above and left, `dark` the one below and right; `inner` rows stand in for its face.
func panel(light: Character, face: Character, dark: Character, inner: [String]? = nil) -> [String] {
    let wide = 10
    let middle = (0 ..< 7).map { row in "\(light)\(inner?[row] ?? String(repeating: face, count: wide))\(dark)" }
    return ["." + String(repeating: light, count: wide) + "."] + middle + ["." + String(repeating: dark, count: wide) + "."]
}

/// A row of the black ground above a window and a column of it to its right (`x`): what parts it from the one behind.
func parted(_ rows: [String]) -> [String] {
    [String(repeating: "x", count: rows[0].count + 1)] + rows.map { $0 + "x" }
}

/// The prompt on the front window's face: a `>` of five rows, two cells wide, stepping in to its point and out
/// again, and a cursor four cells long on its last row (the user, of five ways to draw it side by side: 改成A).
let prompt = ["##########", "#ss#######", "##ss######", "###ss#####", "##ss######", "#ss##ssss#", "##########"]

/// The three windows from back to front, each three cells left of and below the one behind it.
let stamps: [(rows: [String], x: Int, y: Int)] = [
    (panel(light: "d", face: "k", dark: "s"), 6, 0),
    (parted(panel(light: "m", face: "d", dark: "k")), 3, 2),
    (parted(panel(light: "W", face: "#", dark: "m", inner: prompt)), 0, 5),
]
let tones: [Character: String] = ["W": "#ffffff", "#": "#e9e6df", "m": "#a9a6a0", "d": "#6f6c68", "k": "#3b3a37", "s": "#1e1d1b"]
let cell = 34
let columns = stamps.map { $0.x + $0.rows[0].count }.max() ?? 0, lines = stamps.map { $0.y + $0.rows.count }.max() ?? 0

/// The board the stamps make, a later one over an earlier one: 18 × 15 cells.
let board: [[Character]] = stamps.reduce(Array(repeating: Array(repeating: Character("."), count: columns), count: lines)) { board, stamp in
    board.enumerated().map { y, row in
        row.enumerated().map { x, under in
            let sy = y - stamp.y, sx = x - stamp.x
            guard stamp.rows.indices.contains(sy), sx >= 0, sx < stamp.rows[sy].count else { return under }
            let over = Array(stamp.rows[sy])[sx]
            return over == "." ? under : over
        }
    }
}

let pixels = svg(board.enumerated().flatMap { y, row in
    row.enumerated().compactMap { x, tone in
        tones[tone].map { "<rect x=\"\((size - columns * cell) / 2 + x * cell)\" y=\"\((size - lines * cell) / 2 + y * cell)\" width=\"\(cell)\" height=\"\(cell)\" fill=\"\($0)\"/>" }
    }
}.joined())

let pixel = (
    json: document(ground: "{ \"solid\" : \"display-p3:0.0,0.0,0.0,1.0\" }", groups: [
        """
            { "name" : "pixels", "layers" : [ { "image-name" : "pixels.svg", "name" : "pixels", "glass" : false } ],
              "shadow" : { "kind" : "none", "opacity" : 0 }, "translucency" : { "enabled" : false, "value" : 0 }, "specular" : false }
        """,
    ]),
    assets: ["pixels.svg": pixels]
)

// MARK: writing

func write(_ icon: (json: String, assets: [String: String]), to url: URL) throws {
    try? FileManager.default.removeItem(at: url)
    try FileManager.default.createDirectory(at: url.appendingPathComponent("Assets"), withIntermediateDirectories: true)
    try icon.json.write(to: url.appendingPathComponent("icon.json"), atomically: true, encoding: .utf8)
    for (name, text) in icon.assets { try text.write(to: url.appendingPathComponent("Assets/\(name)"), atomically: true, encoding: .utf8) }
    print("wrote \(url.path)")
}

/// The document as the system draws it on a Mac: the tile alone, full bleed.
func render(_ icon: URL) throws -> CGImage {
    let developer = Pipe()
    let select = Process()
    select.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    select.arguments = ["-p"]
    select.standardOutput = developer
    try select.run()
    select.waitUntilExit()
    let path = String(decoding: developer.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    let tool = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("Applications/Icon Composer.app/Contents/Executables/ictool")
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-icon-\(ProcessInfo.processInfo.processIdentifier).png")
    defer { try? FileManager.default.removeItem(at: out) }
    let draw = Process()
    draw.executableURL = tool
    draw.arguments = [icon.path, "--export-image", "--output-file", out.path, "--platform", "macOS", "--rendition", "Default",
                      "--width", "\(size)", "--height", "\(size)", "--scale", "1"]
    draw.standardOutput = FileHandle.nullDevice
    try draw.run()
    draw.waitUntilExit()
    // Read whole before the file goes: an image source decodes late.
    guard draw.terminationStatus == 0, let data = try? Data(contentsOf: out), let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw CocoaError(.fileReadCorruptFile, userInfo: [NSLocalizedDescriptionKey: "ictool did not draw \(icon.lastPathComponent)"])
    }
    return image
}

/// The tile on the Mac's icon grid: 824 of 1024 with the usual soft shadow under it, as a Dock icon is.
func docked(_ tile: CGImage) -> Data? {
    guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 20, color: CGColor(gray: 0, alpha: 0.3))
    ctx.draw(tile, in: CGRect(x: 100, y: 100, width: 824, height: 824))
    return ctx.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) }
}

do {
    let resources = root.appendingPathComponent("Resources"), phone = root.appendingPathComponent("../ios-app/App").standardizedFileURL
    for folder in [resources, phone] {
        try write(classic, to: folder.appendingPathComponent("AppIcon.icon"))
        try write(pixel, to: folder.appendingPathComponent("AppIconPixel.icon"))
    }
    guard let png = docked(try render(resources.appendingPathComponent("AppIconPixel.icon"))) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: resources.appendingPathComponent("AppIconPixel.png"))
    print("wrote \(resources.appendingPathComponent("AppIconPixel.png").path)")
} catch {
    FileHandle.standardError.write(Data("make-icons: \(error.localizedDescription)\n".utf8))
    exit(1)
}
