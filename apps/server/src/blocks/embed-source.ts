import { deriveEmbedSource, type PropertySchema } from "@hermes/shared";

/**
 * Single source of truth for a block's embed_source (design doc §4):
 * text blocks embed their content directly; typed blocks derive from their
 * includeEmbed fields via the shared, generic helper. No per-type logic.
 */
export function computeEmbedSource(
  type: { isText: boolean; propertySchema: PropertySchema | null },
  block: { content?: string | null; properties?: Record<string, unknown> | null },
): string {
  if (type.isText) return block.content ?? "";
  if (!type.propertySchema) return "";
  return deriveEmbedSource(type.propertySchema, block.properties ?? {});
}
