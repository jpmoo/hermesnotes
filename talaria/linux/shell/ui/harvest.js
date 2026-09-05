/*
 * What Talaria's own window is showing, for Glance to read.
 *
 * The ladder in `glance.py` climbs through other people's windows —
 * accessibility trees, the primary selection, a synthetic copy. None of that
 * reaches a page we drew ourselves: the desk is a Talaria window, so
 * `frontmost.py` deliberately ignores it, and every rung below is asking about
 * whatever was in front *before* the desk opened. Selecting a sentence on the
 * desk and pressing the Glance key read the window behind it, which is the
 * defect this answers.
 *
 * This is the Mac's rung 2, the one it takes through its own JS bridge, with
 * one addition the Mac has no need for: **the desk offers everything it is
 * showing, not only what is selected.** A full-screen surface of four panes is
 * itself the context — "where was I" is answered by what is on it — and asking
 * somebody to highlight the thing they are already looking at is asking them to
 * do the computer's job.
 *
 * Evaluated in the top frame and reaching into the quadrants, which is allowed
 * because they are the same origin: every page here is served from
 * `talaria-app://daemon/ui/`.
 */
(() => {
  const CAP = 4000;

  /** Every same-origin document on this page, the outer one first. */
  function documents() {
    const found = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        // Cross-origin throws rather than returning null, and a quadrant that
        // is somebody else's page is not ours to read.
        const doc = frame.contentDocument;
        if (doc) found.push(doc);
      } catch { /* not ours */ }
    }
    return found;
  }

  /* Selection first, and from any frame. A selection lives in the document it
   * was made in, so the outer page's `getSelection` knows nothing about text
   * highlighted inside a quadrant. */
  const picked = [];
  for (const doc of documents()) {
    const text = String(doc.defaultView?.getSelection?.() ?? "").trim();
    if (text) picked.push(text);
  }
  if (picked.length) {
    return { text: picked.join("\n\n").slice(0, CAP), how: "selected" };
  }

  /*
   * Nothing highlighted, so the surface itself.
   *
   * Only the surface in view: the desk's rail holds the canvas and the writing
   * surface off-screen either side, and their text is in the document whether
   * or not anybody can see it. Handing all three to a semantic search would
   * answer a question about a screen the reader is not looking at.
   */
  const surface = [...document.querySelectorAll(".surface")]
    .find((s) => !s.inert) || document.body;

  /*
   * What a page *says* is its content, and its furniture left behind.
   *
   * The first version handed over `innerText` and the result was mostly
   * chrome — the type dropdown's every option, the chat's three example
   * questions, the word "Create" — which is a fine description of the screen
   * and a terrible semantic query. So each page marks its content with
   * `data-context` and this reads that, falling back to the whole document for
   * a page that declares nothing.
   *
   * Controls are dropped and their *values* kept, which is the distinction that
   * matters: an empty compose form contributes nothing, and one with a title
   * half typed contributes the title. Today's note is a control too, and is the
   * reason this rule exists rather than a list of selectors to skip.
   */
  function contentOf(root, doc) {
    const marked = [...root.querySelectorAll("[data-context]")];
    const regions = marked.length ? marked : [root];
    const parts = [];
    for (const region of regions) {
      const copy = region.cloneNode(true);
      for (const junk of copy.querySelectorAll("option, select, button, svg, summary")) {
        junk.remove();
      }
      const said = copy.innerText?.trim();
      if (said) parts.push(said);
      // Values live on the live nodes; a clone of an input carries the
      // attribute it was born with, not what somebody typed into it.
      for (const field of region.querySelectorAll("input, textarea")) {
        const value = String(field.value || "").trim();
        if (value) parts.push(value);
      }
    }
    return parts.join("\n\n").trim();
  }

  const parts = [];
  for (const doc of documents()) {
    // A quadrant's own document has no `.surface`; the outer one is scoped to
    // the surface in view, and a frame contributes only if it sits inside it.
    const from = doc === document
      ? surface
      : (surface.contains(doc.defaultView.frameElement) ? doc.body : null);
    const text = from && contentOf(from, doc);
    if (text) parts.push(text);
  }
  const all = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return all ? { text: all.slice(0, CAP), how: "showing" } : null;
})()
