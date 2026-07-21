import type { FilterGroup } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { api, type BlockType } from "../api.ts";
import { normalizeFilter } from "../lib/filter.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";

/** Query builder that autosaves to the collection (used in the right panel). */
export function QueryPanel({
  collectionId,
  initial,
  onSaved,
}: {
  collectionId: string;
  initial: unknown;
  onSaved: () => void;
}) {
  const [filter, setFilter] = useState<FilterGroup>(() => normalizeFilter(initial));
  const [types, setTypes] = useState<BlockType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes);
    void api.get<{ name: string }[]>("/tags").then((t) => setTags(t.map((x) => x.name)));
  }, []);

  const change = (f: FilterGroup) => {
    setFilter(f);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await api.patch(`/collections/${collectionId}`, { filter_query: f });
      onSaved();
    }, 600);
  };

  return <QueryBuilder value={filter} onChange={change} types={types} tags={tags} />;
}
