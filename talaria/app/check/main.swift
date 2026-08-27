import Foundation

/**
 Every payload the app decodes, decoded.

 Swift's synthesized decoder is all-or-nothing: one field whose type or presence
 has drifted throws the whole response away, and every call site here wraps that
 in `try?` because a panel that fails to draw is worse than one drawing stale
 data. The two together are a silence machine. This session alone it produced
 four separate outages, none of which announced themselves:

   - `Card.completable` — one card missing it emptied a whole board
   - `Health.cursor` declared Int, served "1427" — killed every /health call,
     and with it Spotlight reindexing and every panel's live refresh
   - `SpotlightPayload.epoch`, the same field under an older name, one layer down
   - `Card` reused for `/blocks`, which answers canonical blocks with no `done` —
     the composer's reference menus came up empty and said nothing

 So the shapes are checked against a live daemon rather than trusted. Not a unit
 test: the thing that drifts is the agreement between two programs, and only the
 real answer settles it.

     bash talaria/app/check.sh
 */

var bad = 0
func check(_ name: String, _ body: () throws -> String) {
    do {
        let detail = try body()
        print("  ok    \(name)\(detail.isEmpty ? "" : "   \(detail)")")
    } catch {
        print("  FAIL  \(name)   \(error)")
        bad += 1
    }
}

print("decoding what the daemon actually serves\n")

check("health") {
    let h = try Daemon.health()
    return "cursor \(h.cursor ?? "—"), \(h.blocks) blocks, \(h.freshness)"
}

check("spotlight") {
    let p = try Daemon.spotlight()
    return "\(p.count) items, cursor \(p.epoch ?? "—")"
}

check("types") {
    let t = try Daemon.types()
    guard !t.isEmpty else { throw Daemon.Failure(description: "no types") }
    let fields = t.reduce(0) { $0 + $1.fields.count }
    return "\(t.count) types, \(fields) fields"
}

// The one that was broken. Every reference field, followed to its target type —
// a composer whose menus are empty is indistinguishable from a library with
// nothing in it, so this asserts the decode rather than the count.
check("reference candidates") {
    var checked = 0
    for t in try Daemon.types() {
        for f in t.fields where f.kind == "reference" {
            guard let target = f.targetType else { continue }
            _ = try Daemon.blocks(ofType: target)
            checked += 1
        }
    }
    return "\(checked) reference field(s) resolve"
}

check("boards") {
    let b = try Daemon.boards()
    return "\(b.count) collections"
}

check("one board") {
    guard let first = try Daemon.boards().first else { return "none to open" }
    let (board, _, _) = try Daemon.board(first.id)
    return "\(board.title) — \(board.regions.count) region(s), \(board.members.count) member(s)"
}

check("agenda") {
    let a = try Daemon.agenda(days: 3)
    return "\(a.days.count) day(s), \(a.feeds.count) feed(s)"
}

check("glance") {
    let g = try Daemon.glance(query: "a question nobody asked")
    return "\(g.data.count) hit(s)\(g.error.map { ", \($0)" } ?? "")"
}

print(bad == 0 ? "\nall good" : "\n\(bad) failed")
exit(bad == 0 ? 0 : 1)
