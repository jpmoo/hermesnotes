import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector column type for Drizzle. Stores/reads a JS number[] as pgvector's
 * `[1,2,3]` text form.
 */
export const vector = (name: string, config: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
    dataType() {
      return `vector(${config.dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .slice(1, -1)
        .split(",")
        .map(Number);
    },
  })(name);

/**
 * Zero-pad (or validate) an embedding to the fixed index width. Zero-padding
 * preserves cosine similarity exactly, so vectors from different-dimension
 * models can share one HNSW index. Throws if the native vector is wider than
 * the index — that means EMBEDDING_INDEX_DIM must be raised for this model.
 */
export function padEmbedding(vec: number[], indexDim: number): number[] {
  if (vec.length > indexDim) {
    throw new Error(
      `embedding dimension ${vec.length} exceeds index width ${indexDim}; ` +
        `raise EMBEDDING_INDEX_DIM (max 2000)`,
    );
  }
  if (vec.length === indexDim) return vec;
  return vec.concat(new Array(indexDim - vec.length).fill(0));
}
