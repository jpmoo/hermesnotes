/*
 * The canvas, mounted.
 *
 * Everything Hermes' page did around the component — routing, panels, the block
 * editor — is either answered locally or absent. What is left is the loop that
 * matters: read `canvas.json`, ask the mirror about every block it places,
 * render, and hand edits back to the same file.
 */
import { Component, StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CanvasView } from "./components/CanvasView.tsx";
import { CanvasChat } from "./components/CanvasChat.tsx";
import { CanvasTools } from "./components/CanvasTools.tsx";
import { api, flush, hold, type BlockType, type Collection, type Member } from "./api.ts";
import { getDocument, getLinked, toCollection, toMembers } from "./document.ts";
import "./canvas-forked.css";
import "./canvas.css";

function Canvas() {
  const [state, setState] = useState<{
    collection: Collection;
    members: Member[];
    types: BlockType[];
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      /*
       * **Anything pending goes out first.**
       *
       * Edits are written on a pause, and `onChanged` fires the moment the
       * component has finished changing things — well inside that pause. Reading
       * then hands back the document as it was *before* the edit and `hold`
       * replaces the live one with it, so the pending write lands on a document
       * that has forgotten what it was about to say.
       *
       * Converting a note showed it plainly: the note was removed, the block was
       * placed, both were thrown away by the re-read, and the canvas came back
       * empty.
       */
      await flush();
      const doc = await getDocument();
      const linked = await getLinked(
        doc.items.map((i) => i.blockId).filter((id): id is string => Boolean(id)),
      );
      // The document is held by the api module and edited in place; this only
      // ever hands out a rendering of it.
      hold(doc, () => {});
      const types = await api.get<BlockType[]>("/types").catch(() => [] as BlockType[]);
      setState({ collection: toCollection(doc), members: toMembers(doc, linked), types });
    } catch (err) {
      setFailure(String((err as Error).message || err));
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  if (failure) return <div className="canvas-waiting">{failure}</div>;
  if (!state) return <div className="canvas-waiting">Reading the canvas…</div>;
  return (
    <>
      <CanvasView
        collection={state.collection}
        members={state.members}
        types={state.types}
        onChanged={() => void read()}
      />
      {/* The strip, and the chat, both over the canvas rather than inside it —
          which is where the Mac puts them and for the reason it gives: the
          surface knows about items, links and regions, and neither of these is
          one of those. */}
      <CanvasTools onPlaced={() => void read()} />
      <CanvasChat onDrawn={() => void read()} />
    </>
  );
}

/*
 * A canvas that throws says so.
 *
 * Without this the page goes blank and the console holds React's own error
 * reporter rather than the component that failed — which is a long way from
 * "the canvas is broken" to "the canvas is broken *here*". The message is shown
 * rather than swallowed: this is somebody's arrangement of their own notes, and
 * a surface that quietly renders nothing is indistinguishable from an empty
 * canvas.
 */
class Boundary extends Component<{ children: ReactNode }, { failure: Error | null }> {
  state = { failure: null as Error | null };
  static getDerivedStateFromError(failure: Error) {
    return { failure };
  }
  componentDidCatch(failure: Error, info: { componentStack?: string | null }) {
    console.error("canvas:", failure.message, failure.stack, info.componentStack);
  }
  render() {
    if (!this.state.failure) return this.props.children;
    return (
      <div className="canvas-waiting">
        <div>
          <p>The canvas could not be drawn.</p>
          <pre>{this.state.failure.message}</pre>
        </div>
      </div>
    );
  }
}

/*
 * Whether this canvas is a window or a surface on the desk.
 *
 * The shell's pages get this from `ui/api.js`, which every one of them imports;
 * the canvas has its own transport and so never picked it up — which meant the
 * frosting rules keyed on `.framed` sat in the stylesheet doing nothing, and the
 * canvas painted itself solid inside a desk built to show through it.
 */
if (window.parent !== window) document.documentElement.classList.add("framed");

createRoot(document.getElementById("canvas-root")!).render(
  <StrictMode>
    <Boundary>
      <Canvas />
    </Boundary>
  </StrictMode>,
);
