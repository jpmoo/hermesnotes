import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";

/**
 * The day's scratchpad, and nothing else on the page.
 *
 * For Talaria's desk, which puts today's page in a quarter of the screen beside
 * the composer, Glance and the workspaces. It embeds this in a web view rather
 * than drawing its own editor, because "renders the way it renders in Hermes"
 * has exactly one faithful implementation and it is this one — markdown, the
 * `@` and `#` pickers, piping into a block, the lot. A second editor in Swift
 * would be weeks of work whose only possible outcome is two editors that
 * disagree.
 *
 * So this is deliberately thin: find the note for a date, hand it to the same
 * `TextBlockEditor` the Today page uses, and draw no chrome around it. The
 * shell skips its sidebar, nav and panels for any `/embed/` path — a quarter of
 * a laptop screen has no room for a navigation rail, and a second copy of the
 * app's chrome inside the app's own companion would be absurd.
 */
export function EmbedScratchpadPage() {
  const { date } = useParams<{ date: string }>();
  const [note, setNote] = useState<Block | null>(null);
  const [type, setType] = useState<BlockType | undefined>();
  const [error, setError] = useState<string | null>(null);
  // Bumped to remount the editor after a conflict, the same way the Today page
  // does it: the editor holds the document it loaded with, so a reload has to
  // be a new one rather than a new prop.
  const [nonce, setNonce] = useState(0);

  const day = date ?? new Date().toLocaleDateString("en-CA");

  const load = () => {
    api
      .get<Block>(`/today/${day}/note`)
      .then(async (block) => {
        setNote(block);
        setError(null);
        if (block.blockTypeId) {
          const types = await api.get<BlockType[]>("/block-types");
          setType(types.find((t) => t.id === block.blockTypeId));
        }
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, [day]);

  if (error) return <div className="embed-scratchpad embed-empty">{error}</div>;
  if (!note) return <div className="embed-scratchpad embed-empty">…</div>;

  return (
    <div className="embed-scratchpad" data-block-id={note.id}>
      <TextBlockEditor
        key={`${note.id}:${nonce}`}
        block={note}
        type={type}
        onConflict={() => {
          setNonce((n) => n + 1);
          load();
        }}
        onDeleted={load}
        canDelete={false}
        hideBanner
      />
    </div>
  );
}
