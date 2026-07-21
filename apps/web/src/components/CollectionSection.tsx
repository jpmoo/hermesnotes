import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockCard } from "./BlockCard.tsx";

/**
 * Renders a collection's members as a titled section of full cards. Used to
 * embed a collection inside a Today sheet or a document. Nested collection
 * members are shown as a link rather than recursed.
 */
export function CollectionSection({
  collectionId,
  types,
  reportLabel,
}: {
  collectionId: string;
  types: BlockType[];
  reportLabel?: (label: string) => void;
}) {
  const [state, setState] = useState<{ collection: Collection; members: Member[] } | null>(null);

  useEffect(() => {
    void api
      .get<{ collection: Collection; members: Member[] }>(`/collections/${collectionId}`)
      .then((d) => {
        setState(d);
        reportLabel?.(oneLineText(d.collection.properties) || "Untitled");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);

  if (!state) return null;
  const typeById = new Map(types.map((t) => [t.id, t]));
  const title = oneLineText(state.collection.properties) || "Untitled";
  return (
    <section className="today-section">
      <h2 className="today-h">
        {title}
        <Link className="sec-open" to={`/collections/${collectionId}`}>
          open ↗
        </Link>
      </h2>
      {state.members.length === 0 ? (
        <div className="hint">Empty.</div>
      ) : (
        state.members.map((m) =>
          m.collectionKind ? (
            <Link key={m.id} className="sec-sublink" to={`/collections/${m.id}`}>
              {oneLineText(m.properties) || "Untitled collection"} ↗
            </Link>
          ) : (
            <BlockCard
              key={m.id}
              block={m as unknown as Block}
              type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
              onConflict={() => {}}
              onDeleted={() => {}}
            />
          ),
        )
      )}
    </section>
  );
}
