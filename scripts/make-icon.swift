// Draws Sumi's app icon — an ink ensō on paper with a vermilion seal — and writes an .iconset.
// Usage: swift scripts/make-icon.swift <output.iconset>

import AppKit
import CoreGraphics

func drawIcon(size: CGFloat) -> NSBitmapImageRep {
    let pixels = Int(size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let context = NSGraphicsContext.current!.cgContext
    let unit = size / 1024
    context.scaleBy(x: unit, y: unit)

    // The standard macOS icon plate: an 824pt rounded square centred on a 1024pt canvas.
    let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
    let platePath = CGPath(roundedRect: plate, cornerWidth: 185, cornerHeight: 185, transform: nil)

    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.28))
    context.addPath(platePath)
    context.setFillColor(CGColor(red: 0.98, green: 0.975, blue: 0.96, alpha: 1))
    context.fillPath()
    context.restoreGState()

    // Paper: a soft top-to-bottom wash.
    context.saveGState()
    context.addPath(platePath)
    context.clip()
    let paper = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [
            CGColor(red: 1.0, green: 0.998, blue: 0.992, alpha: 1),
            CGColor(red: 0.945, green: 0.936, blue: 0.914, alpha: 1),
        ] as CFArray,
        locations: [0, 1]
    )!
    context.drawLinearGradient(paper, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    context.restoreGState()

    // The ensō: one brush stroke, heavy where the brush lands and thinning as it lifts.
    let centre = CGPoint(x: 512, y: 520)
    let radius: CGFloat = 232
    let start: CGFloat = 250 * .pi / 180
    let sweep: CGFloat = 318 * .pi / 180
    let steps = 240
    var outer: [CGPoint] = []
    var inner: [CGPoint] = []
    for i in 0 ... steps {
        let t = CGFloat(i) / CGFloat(steps)
        let angle = start - sweep * t
        // Pressure: quick swell at the start, a long even body, a tapering tail.
        let swell = min(1, t / 0.07)
        let tail = pow(max(0, 1 - max(0, t - 0.62) / 0.38), 1.35)
        let width = (34 + 30 * sin(t * .pi * 0.9)) * (0.35 + 0.65 * swell) * (0.1 + 0.9 * tail)
        // A hand-drawn circle is never perfectly round.
        let r = radius + 9 * sin(t * .pi * 2 + 0.6) - 16 * t
        let direction = CGPoint(x: cos(angle), y: sin(angle))
        outer.append(CGPoint(x: centre.x + direction.x * (r + width), y: centre.y + direction.y * (r + width)))
        inner.append(CGPoint(x: centre.x + direction.x * (r - width), y: centre.y + direction.y * (r - width)))
    }
    let stroke = CGMutablePath()
    stroke.move(to: outer[0])
    for point in outer.dropFirst() { stroke.addLine(to: point) }
    for point in inner.reversed() { stroke.addLine(to: point) }
    stroke.closeSubpath()
    context.addPath(stroke)
    context.setFillColor(CGColor(red: 0.105, green: 0.1, blue: 0.095, alpha: 1))
    context.fillPath()

    // The seal.
    let seal = CGRect(x: 640, y: 262, width: 96, height: 96)
    context.addPath(CGPath(roundedRect: seal, cornerWidth: 22, cornerHeight: 22, transform: nil))
    context.setFillColor(CGColor(red: 0.84, green: 0.25, blue: 0.17, alpha: 1))
    context.fillPath()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let arguments = CommandLine.arguments
guard arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift <output.iconset>\n".utf8))
    exit(2)
}
let output = URL(fileURLWithPath: arguments[1])
try? FileManager.default.removeItem(at: output)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let variants: [(name: String, size: CGFloat)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for variant in variants {
    let rep = drawIcon(size: variant.size)
    let png = rep.representation(using: .png, properties: [:])!
    try png.write(to: output.appendingPathComponent(variant.name + ".png"))
}
print("wrote \(variants.count) images to \(output.path)")
