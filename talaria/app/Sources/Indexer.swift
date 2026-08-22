import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// Putting the mirror into Spotlight.
///
/// The daemon has already flattened everything, so this only copies fields into
/// an attribute set. That asymmetry is on purpose: the shape of what gets
/// indexed will change often and Swift is the slow half to change.
enum Indexer {
    /// A domain per kind, so a whole category can be dropped in one call.
    private static func domain(_ kind: String) -> String { "kind.\(kind)" }

    /// The logo, read once and reused.
    ///
    /// Spotlight will otherwise show a generic placeholder beside every result:
    /// an item's icon comes from its own `thumbnailData`, not from the app that
    /// indexed it, so the bundle having an icon is not enough on its own.
    private static let thumbnail: Data? = {
        guard let url = Bundle.main.url(forResource: "Talaria", withExtension: "png") else {
            NSLog("talaria: no Talaria.png in the bundle — results will have no icon")
            return nil
        }
        return try? Data(contentsOf: url)
    }()

    static func reindex(_ payload: Daemon.SpotlightPayload) async throws {
        let index = CSSearchableIndex.default()

        let items = payload.items.map { item -> CSSearchableItem in
            let attrs = CSSearchableItemAttributeSet(contentType: UTType.content)
            attrs.title = item.title
            attrs.displayName = item.title
            attrs.contentDescription = item.description.isEmpty ? item.typeName : item.description
            // What someone might plausibly type: the tags they applied, and the
            // name of the type in their own vocabulary — "project", or whatever
            // they renamed it to.
            attrs.keywords = item.tags + [item.typeName, item.kind]
            attrs.contentCreationDate = ISO8601DateFormatter().date(from: item.createdAt)
            attrs.contentModificationDate = ISO8601DateFormatter().date(from: item.updatedAt)
            // Not contentURL: that would make Spotlight treat this as a file on
            // disk. Activation comes back to us with the identifier instead.
            attrs.relatedUniqueIdentifier = item.id
            attrs.thumbnailData = thumbnail

            return CSSearchableItem(
                uniqueIdentifier: item.id,
                domainIdentifier: domain(item.kind),
                attributeSet: attrs
            )
        }

        // Replace wholesale rather than diffing. At this size it is one call and
        // no bookkeeping, and it means a block that left the mirror — archived,
        // deleted, or filtered out — cannot linger in the index because nobody
        // remembered to remove it.
        try await index.deleteSearchableItems(withDomainIdentifiers: Set(payload.items.map { domain($0.kind) }).sorted())
        try await index.indexSearchableItems(items)
    }

    /// Ask the index what it actually holds.
    ///
    /// The only way to check indexing worked without a person looking at
    /// ⌘Space: CoreSpotlight items live in a different store from file
    /// metadata, so `mdfind` cannot see them and their absence there means
    /// nothing. Also what lets `doctor` report on the index rather than assume.
    static func search(_ text: String) async throws -> [(id: String, title: String)] {
        let escaped = text.replacingOccurrences(of: "\"", with: "")
        // queryContext, not the attributes: initialiser — that one has been
        // deprecated since macOS 13 and is all over the training data.
        let context = CSSearchQueryContext()
        context.fetchAttributes = ["title"]
        let query = CSSearchQuery(
            queryString: "(title == \"*\(escaped)*\"cd) || (textContent == \"*\(escaped)*\"cd)",
            queryContext: context
        )
        var found: [(id: String, title: String)] = []
        for try await item in query.results {
            found.append((id: item.item.uniqueIdentifier, title: item.item.attributeSet.title ?? ""))
        }
        return found
    }

    /// Everything this app has ever indexed, gone.
    static func clear() async throws {
        try await CSSearchableIndex.default().deleteAllSearchableItems()
    }
}
