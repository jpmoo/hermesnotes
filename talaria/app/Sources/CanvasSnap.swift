import CoreGraphics
import Foundation

/**
 Where a thing being dragged wants to land.

 Written as arithmetic with no view in it, because snapping is the feature most
 likely to be *nearly* right — one axis working and the other not, a guide drawn
 where nothing aligns, a rule that fights another rule — and none of that is
 visible by looking at it. A pure engine can be asked directly whether a box
 dropped two points from an edge lands on it, and told when it is wrong.

 Everything here is in canvas coordinates. The tolerance is handed in already
 converted from screen points, so a snap feels the same at any zoom rather than
 becoming a magnet at 6× and unreachable at 0.15×.
 */
enum Snap {
    /// How close, in screen points, counts as wanting to snap.
    static let reach: CGFloat = 6

    /// What matched, so the surface can draw it.
    enum Reason: Equatable {
        /// Two edges, or two centres, lined up.
        case alignment
        /// The dotted grid.
        case grid
        /// Made the same size as something else.
        case size
        /// Put the same distance from its neighbour as the others are.
        case spacing
        /// A connector pulled back into a straight line.
        case straight
    }

    /**
     A line to draw while a snap is holding.

     In canvas coordinates and as a segment rather than an infinite line: a
     guide that runs off both edges of the screen says "something aligns" and
     not *what*. Ending it at the things it joins says both.
     */
    struct Guide: Equatable {
        var from: CGPoint
        var to: CGPoint
        var reason: Reason
    }

    struct Result: Equatable {
        var rect: CGRect
        var guides: [Guide]
    }

    // MARK: The pieces

    /// The three interesting places along an axis: both edges and the middle.
    private static func stops(_ lo: CGFloat, _ hi: CGFloat) -> [CGFloat] {
        [lo, (lo + hi) / 2, hi]
    }

    /// The best offer for one axis: how far to move, and what it lined up with.
    private struct Offer {
        var delta: CGFloat
        var at: CGFloat
        var reason: Reason
        var partner: CGRect?
    }

    private static func better(_ a: Offer?, _ b: Offer?) -> Offer? {
        guard let a else { return b }
        guard let b else { return a }
        // Nearest wins, and a tie goes to the first — which is alignment,
        // because it is offered first below. A grid that beat an edge on an
        // exact tie would pull a box off something it was already touching.
        return abs(b.delta) < abs(a.delta) ? b : a
    }

    // MARK: Moving

    /**
     Where a box being dragged should actually sit.

     Each axis is decided on its own. That is not a simplification — a box can
     be aligned left with one thing and vertically centred on another, and
     forcing one answer for both would mean the second never happens.

     The order things are offered matters only for ties: alignment first,
     because a box already touching an edge should not be pulled off it by a
     grid line an equal distance away.
     */
    static func move(
        _ rect: CGRect,
        others: [CGRect],
        grid: CGFloat?,
        tolerance: CGFloat
    ) -> Result {
        var x: Offer?
        var y: Offer?

        // Edges and centres.
        for other in others {
            for mine in stops(rect.minX, rect.maxX) {
                for theirs in stops(other.minX, other.maxX) where abs(theirs - mine) <= tolerance {
                    x = better(x, Offer(delta: theirs - mine, at: theirs, reason: .alignment, partner: other))
                }
            }
            for mine in stops(rect.minY, rect.maxY) {
                for theirs in stops(other.minY, other.maxY) where abs(theirs - mine) <= tolerance {
                    y = better(y, Offer(delta: theirs - mine, at: theirs, reason: .alignment, partner: other))
                }
            }
        }

        // The same gap as the neighbours already have.
        if let offer = spacingOffer(rect, others: others, tolerance: tolerance, horizontal: true) {
            x = better(x, offer)
        }
        if let offer = spacingOffer(rect, others: others, tolerance: tolerance, horizontal: false) {
            y = better(y, offer)
        }

        // The grid, last, so it loses every tie.
        if let step = grid, step > 0 {
            if let offer = gridOffer(rect.minX, step: step, tolerance: tolerance) { x = better(x, offer) }
            if let offer = gridOffer(rect.minY, step: step, tolerance: tolerance) { y = better(y, offer) }
        }

        var moved = rect
        moved.origin.x += x?.delta ?? 0
        moved.origin.y += y?.delta ?? 0

        var guides: [Guide] = []
        if let x { guides.append(guide(vertical: x, moved: moved)) }
        if let y { guides.append(guide(horizontal: y, moved: moved)) }
        return Result(rect: moved, guides: guides)
    }

    private static func gridOffer(_ value: CGFloat, step: CGFloat, tolerance: CGFloat) -> Offer? {
        let nearest = (value / step).rounded() * step
        guard abs(nearest - value) <= tolerance else { return nil }
        return Offer(delta: nearest - value, at: nearest, reason: .grid, partner: nil)
    }

    /**
     The gap the neighbours are already using.

     Only among boxes that share a band with this one — things in a row are
     things at the same height, and "evenly spaced" between two objects on
     opposite sides of the canvas is a coincidence rather than a layout.

     The gap is taken from the closest pair on either side, which is the one a
     person is most likely to be copying. Offered on both sides: continuing a row
     to the right and to the left are the same intention.
     */
    private static func spacingOffer(
        _ rect: CGRect,
        others: [CGRect],
        tolerance: CGFloat,
        horizontal: Bool
    ) -> Offer? {
        let band = others.filter { other in
            horizontal
                ? other.minY < rect.maxY && other.maxY > rect.minY
                : other.minX < rect.maxX && other.maxX > rect.minX
        }
        guard band.count >= 2 else { return nil }

        let sorted = band.sorted { horizontal ? $0.minX < $1.minX : $0.minY < $1.minY }
        var best: Offer?
        for i in 0..<(sorted.count - 1) {
            let a = sorted[i], b = sorted[i + 1]
            let gap = horizontal ? b.minX - a.maxX : b.minY - a.maxY
            guard gap > 0 else { continue }
            // The same gap again, on the far side of each end of the run.
            for anchor in [sorted[0], sorted[sorted.count - 1]] {
                let before = horizontal
                    ? anchor.minX - gap - rect.width
                    : anchor.minY - gap - rect.height
                let after = horizontal ? anchor.maxX + gap : anchor.maxY + gap
                for target in [before, after] {
                    let mine = horizontal ? rect.minX : rect.minY
                    guard abs(target - mine) <= tolerance else { continue }
                    best = better(best, Offer(delta: target - mine, at: target, reason: .spacing, partner: anchor))
                }
            }
        }
        return best
    }

    private static func guide(vertical offer: Offer, moved: CGRect) -> Guide {
        // Drawn between the two things it is about, with a little overshoot so
        // it reads as a line rather than as an edge of one of the boxes.
        let lows = [moved.minY, offer.partner?.minY ?? moved.minY]
        let highs = [moved.maxY, offer.partner?.maxY ?? moved.maxY]
        return Guide(
            from: CGPoint(x: offer.at, y: (lows.min() ?? 0) - 8),
            to: CGPoint(x: offer.at, y: (highs.max() ?? 0) + 8),
            reason: offer.reason
        )
    }

    private static func guide(horizontal offer: Offer, moved: CGRect) -> Guide {
        let lows = [moved.minX, offer.partner?.minX ?? moved.minX]
        let highs = [moved.maxX, offer.partner?.maxX ?? moved.maxX]
        return Guide(
            from: CGPoint(x: (lows.min() ?? 0) - 8, y: offer.at),
            to: CGPoint(x: (highs.max() ?? 0) + 8, y: offer.at),
            reason: offer.reason
        )
    }

    // MARK: Resizing

    /**
     Where a corner being dragged should actually land.

     The same three answers as a move — an edge, the grid, and now a size — but
     applied to one corner while the opposite one stays where it is. Matching a
     size is the one that has no equivalent in a move, and it is the one people
     reach for most: two boxes the same width look deliberate and two boxes four
     points apart look like a mistake nobody noticed.
     */
    static func resize(
        _ rect: CGRect,
        movingMinX: Bool,
        movingMinY: Bool,
        others: [CGRect],
        grid: CGFloat?,
        tolerance: CGFloat
    ) -> Result {
        let edgeX = movingMinX ? rect.minX : rect.maxX
        let edgeY = movingMinY ? rect.minY : rect.maxY
        var x: Offer?
        var y: Offer?

        for other in others {
            for theirs in stops(other.minX, other.maxX) where abs(theirs - edgeX) <= tolerance {
                x = better(x, Offer(delta: theirs - edgeX, at: theirs, reason: .alignment, partner: other))
            }
            for theirs in stops(other.minY, other.maxY) where abs(theirs - edgeY) <= tolerance {
                y = better(y, Offer(delta: theirs - edgeY, at: theirs, reason: .alignment, partner: other))
            }
            // The same width or height as that one.
            let wantW = movingMinX ? rect.maxX - other.width : rect.minX + other.width
            if abs(wantW - edgeX) <= tolerance {
                x = better(x, Offer(delta: wantW - edgeX, at: wantW, reason: .size, partner: other))
            }
            let wantH = movingMinY ? rect.maxY - other.height : rect.minY + other.height
            if abs(wantH - edgeY) <= tolerance {
                y = better(y, Offer(delta: wantH - edgeY, at: wantH, reason: .size, partner: other))
            }
        }

        if let step = grid, step > 0 {
            if let offer = gridOffer(edgeX, step: step, tolerance: tolerance) { x = better(x, offer) }
            if let offer = gridOffer(edgeY, step: step, tolerance: tolerance) { y = better(y, offer) }
        }

        var box = rect
        if let x {
            if movingMinX { box.origin.x += x.delta; box.size.width -= x.delta }
            else { box.size.width += x.delta }
        }
        if let y {
            if movingMinY { box.origin.y += y.delta; box.size.height -= y.delta }
            else { box.size.height += y.delta }
        }

        var guides: [Guide] = []
        if let x { guides.append(guide(vertical: x, moved: box)) }
        if let y { guides.append(guide(horizontal: y, moved: box)) }
        return Result(rect: box, guides: guides)
    }

    // MARK: Connectors

    /**
     A bend pulled nearly back to nothing is a straight line.

     The one snap a connector needs and the one it cannot do without: a line
     dragged out and then pushed back never quite returns, so every diagram
     accumulates connectors that are two points off straight and look like a
     mistake. Zero is the only value here worth being exact about.

     Answers the bend to use and whether it snapped, so the surface can say so.
     */
    static func bend(_ offset: CGSize, tolerance: CGFloat) -> (CGSize, Bool) {
        if hypot(offset.width, offset.height) <= tolerance { return (.zero, true) }
        // Also worth having: a bend that is straight on one axis. Pulling a
        // handle sideways along a horizontal line should be able to stay level.
        var snapped = offset
        var did = false
        if abs(offset.width) <= tolerance { snapped.width = 0; did = true }
        if abs(offset.height) <= tolerance { snapped.height = 0; did = true }
        return (snapped, did)
    }
}
