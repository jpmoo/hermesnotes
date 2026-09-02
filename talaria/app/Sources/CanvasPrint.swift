import AppKit
import SwiftUI

/**
 The canvas as a picture, with nothing on it that only exists to be clicked.

 A second renderer, deliberately. The surface draws for somebody who is about to
 do something — hover states, grips, guides, a marquee, a strip of tools — and an
 export has none of that. Trying to reuse the interactive view would mean
 threading a "pretend nobody is here" flag through every layer of it, which is
 the sort of flag that gets forgotten in one branch and puts a selection outline
 in a PDF.

 What is *not* duplicated is the part that could drift: where a line runs and
 which sides it leaves from, what box a region occupies, what shape a shape is.
 All of that comes from the same `LinkGeometry`, `CanvasRegion.box` and
 `CanvasShape.path` the surface uses. This file decides only what color to paint
 things, and there is no version of that which can disagree about a diagram.

 At one to one, in canvas coordinates, translated so the top-left of everything
 sits at the origin. No zoom: an export is not a screenshot of a viewport, it is
 the thing itself.
 */
struct CanvasPrint: View {
    let items: [CanvasItem]
    let links: [CanvasLink]
    let regions: [CanvasRegion]
    /// Already decoded, because rendering happens off the back of a menu and
    /// reading files inside a view body is as wrong here as it is anywhere.
    let pictures: [UUID: NSImage]
    /// The extent of everything, in canvas coordinates.
    let bounds: CGRect

    /// A margin, so nothing is cut off at the edge of the page and a diagram is
    /// not flush against its own border.
    static let margin: CGFloat = 40

    /**
     Everything, and how much room it takes.

     Nil when there is nothing to draw: exporting an empty canvas should say so
     rather than write a blank page somebody has to open to find out.
     */
    static func extent(items: [CanvasItem], regions: [CanvasRegion]) -> CGRect? {
        var boxes = items.map(\.rect)
        for region in regions {
            if let box = CanvasRegion.box(of: region.members.compactMap { id in
                items.first { $0.id == id }?.rect
            }) {
                // A region's name is written above its box and has to be inside
                // the page too.
                boxes.append(box.insetBy(dx: 0, dy: -CanvasRegion.titleHeight))
            }
        }
        guard var all = boxes.first else { return nil }
        for box in boxes.dropFirst() { all = all.union(box) }
        return all.insetBy(dx: -margin, dy: -margin)
    }

    private func rect(of id: UUID) -> CGRect? {
        if let item = items.first(where: { $0.id == id }) { return item.rect }
        if let region = regions.first(where: { $0.id == id }) {
            return CanvasRegion.box(of: region.members.compactMap { m in
                items.first { $0.id == m }?.rect
            })
        }
        return nil
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // The page. White rather than clear: a PNG with a transparent
            // background looks like a mistake in most of the places somebody
            // will put one, and a PDF with none prints as whatever the printer
            // decides.
            Color.white

            ZStack(alignment: .topLeading) {
                ForEach(regions) { region in regionView(region) }
                // Framed, and drawing in page coordinates rather than canvas
                // ones. A `Canvas` has no size of its own inside a stack of
                // positioned things — it took whatever the stack worked out and
                // drew the lines somewhere outside it, so the export came out
                // with every box and no connection between any of them.
                connections
                    .frame(width: bounds.width, height: bounds.height)
                    .offset(x: bounds.minX, y: bounds.minY)
                ForEach(items) { item in itemView(item) }
            }
            // Everything else is drawn in canvas coordinates; this is what puts
            // the top-left of the drawing at the top-left of the page.
            .offset(x: -bounds.minX, y: -bounds.minY)
        }
        .frame(width: bounds.width, height: bounds.height)
    }

    @ViewBuilder
    private func regionView(_ region: CanvasRegion) -> some View {
        if let box = CanvasRegion.box(of: region.members.compactMap { id in
            items.first { $0.id == id }?.rect
        }) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Hex.color(region.fill) ?? .clear)
                if region.strokeWidth > 0 {
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(
                            Hex.color(region.stroke) ?? .black.opacity(0.35),
                            style: StrokeStyle(lineWidth: region.strokeWidth,
                                               dash: region.strokeStyle.dash(region.strokeWidth))
                        )
                }
            }
            .frame(width: box.width, height: box.height)
            .overlay(alignment: region.hAlign.frame) {
                if !region.title.isEmpty {
                    Text(CanvasText.attributed(region.title))
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .foregroundStyle(Hex.color(region.textColor) ?? .black.opacity(0.6))
                        .padding(.horizontal, 4)
                        .offset(y: -(box.height / 2) - CanvasRegion.titleHeight / 2)
                }
            }
            .position(x: box.midX, y: box.midY)
        }
    }

    /// Every line, in one canvas. The same geometry the surface draws, at 1:1.
    private var connections: some View {
        Canvas { context, _ in
            // Its own origin is the top-left of the page, and the geometry
            // below is in canvas coordinates — so everything is shifted once,
            // here, rather than by an offset the canvas would not inherit.
            context.translateBy(x: -bounds.minX, y: -bounds.minY)
            for link in links {
                guard link.width > 0,
                      let a = rect(of: link.from), let b = rect(of: link.to) else { continue }
                let g = LinkGeometry.of(from: a, to: b, bend: link.bend)
                let color = Hex.color(link.color) ?? .black.opacity(0.55)
                var path = Path()
                path.move(to: g.start)
                path.addQuadCurve(to: g.end, control: g.control)
                context.stroke(path, with: .color(color),
                               style: StrokeStyle(lineWidth: link.width, dash: link.style.dash(link.width)))
                if link.style == .double {
                    let gap = max(link.width * 1.6, 2.5)
                    let d = g.arrival
                    let side = CGVector(dx: -d.dy * gap, dy: d.dx * gap)
                    var twin = Path()
                    twin.move(to: CGPoint(x: g.start.x + side.dx, y: g.start.y + side.dy))
                    twin.addQuadCurve(
                        to: CGPoint(x: g.end.x + side.dx, y: g.end.y + side.dy),
                        control: CGPoint(x: g.control.x + side.dx, y: g.control.y + side.dy)
                    )
                    context.stroke(twin, with: .color(color), lineWidth: link.width)
                }
                let d = g.arrival
                let len = max(link.width * 6, 5), half = max(link.width * 3, 2.5)
                let back = CGPoint(x: g.end.x - d.dx * len, y: g.end.y - d.dy * len)
                let side = CGVector(dx: -d.dy, dy: d.dx)
                var head = Path()
                head.move(to: g.end)
                head.addLine(to: CGPoint(x: back.x + side.dx * half, y: back.y + side.dy * half))
                head.addLine(to: CGPoint(x: back.x - side.dx * half, y: back.y - side.dy * half))
                head.closeSubpath()
                context.fill(head, with: .color(color))
            }
        }
    }

    @ViewBuilder
    private func itemView(_ item: CanvasItem) -> some View {
        ZStack(alignment: combined(item.hAlign, item.vAlign)) {
            if item.shape != .plain, item.image == nil {
                let box = CGRect(x: 0, y: 0, width: item.w, height: item.h)
                let inset = max(item.strokeWidth / 2, 1)
                if let fill = Hex.color(item.fill) {
                    item.shape.path(in: box).fill(fill)
                    item.shape.foldPath(in: box).fill(fill)
                    item.shape.foldPath(in: box).fill(
                        LinearGradient(
                            colors: [Color.black.opacity(0.30), Color.black.opacity(0.08)],
                            startPoint: .bottomTrailing,
                            endPoint: .topLeading
                        )
                    )
                }
                if item.strokeWidth > 0 {
                    let color = Hex.color(item.stroke) ?? .black.opacity(0.7)
                    item.shape.path(in: box.insetBy(dx: inset, dy: inset))
                        .stroke(color, style: StrokeStyle(lineWidth: item.strokeWidth,
                                                           dash: item.strokeStyle.dash(item.strokeWidth)))
                    if item.strokeStyle == .double {
                        let gap = max(item.strokeWidth * 2, 3)
                        item.shape.path(in: box.insetBy(dx: inset + gap, dy: inset + gap))
                            .stroke(color, lineWidth: item.strokeWidth)
                    }
                }
            }
            if let picture = pictures[item.id] {
                Image(nsImage: picture).resizable().frame(width: item.w, height: item.h)
            } else {
                // Clipped rather than scrolled. A box somebody made smaller than
                // its words scrolls on screen and cannot on paper, so a page
                // shows what the canvas shows and stops there — which is the
                // honest translation of a scroll into something that does not.
                Text(CanvasText.attributed(item.text))
                    .font(.system(size: 12))
                    .multilineTextAlignment(item.hAlign.swiftUI)
                    .foregroundStyle(Hex.color(item.textColor) ?? .black)
                    .padding(item.shape == .plain ? 0 : 10)
                    .frame(width: item.w, height: item.h, alignment: combined(item.hAlign, item.vAlign))
                    .clipped()
            }
        }
        .frame(width: item.w, height: item.h, alignment: combined(item.hAlign, item.vAlign))
        .position(x: item.rect.midX, y: item.rect.midY)
    }
}

/// Turning that view into files.
enum CanvasRender {
    /// Twice the size, so a PNG holds up when somebody looks at it closely or
    /// drops it into a document at half scale. A PDF needs no such thing — it is
    /// vector all the way down.
    static let pngScale: CGFloat = 2

    @MainActor
    static func png(_ view: CanvasPrint) -> Data? {
        let renderer = ImageRenderer(content: view)
        renderer.scale = pngScale
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    @MainActor
    static func pdf(_ view: CanvasPrint, size: CGSize) -> Data? {
        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData) else { return nil }
        var box = CGRect(origin: .zero, size: size)
        guard let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }

        let renderer = ImageRenderer(content: view)
        var wrote = false
        renderer.render { _, draw in
            context.beginPDFPage(nil)
            // No flip. `render` hands over a closure that already puts the view
            // the right way up in whatever context it is given — flipping first
            // turned every glyph upside down and back to front, which is what a
            // second flip looks like when the first one was already done for you.
            draw(context)
            context.endPDFPage()
            wrote = true
        }
        guard wrote else { return nil }
        context.closePDF()
        return out as Data
    }
}
