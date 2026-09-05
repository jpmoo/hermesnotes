/*
 * The daemon, from a page.
 *
 * Every path here is the daemon's own — `get("/boards")` — because the scheme
 * handler carries it to the socket. Nothing in this file knows that, which is
 * the point: these pages would work unchanged behind a real HTTP server, and
 * behind WebKitGTK's scheme handler if the shell ever changes toolkits.
 *
 * **XMLHttpRequest rather than fetch**, and the reason has changed since this
 * was written. It was first blamed on PySide: `registerScheme` appeared not to
 * stick, `schemeByName` read back empty for every name, and the Fetch API
 * refused the scheme as unknown while the handler still served navigation and
 * subresources — so pages rendered perfectly and every request died as "Failed
 * to fetch", which reads exactly like a dead daemon and was nowhere near one.
 *
 * The real cause was ours: the scheme declared `HostAndPort` syntax and no
 * default port, which Qt refuses — as a warning on stderr rather than an
 * exception, so nothing failed loudly. `scheme.py` says `Host` now and
 * registration takes, `fetch` included.
 *
 * XHR stays because it works, is proven against every panel here, and swapping
 * it back would be churn in the one place where a mistake looks like a dead
 * daemon. The note is kept so the next person does not re-diagnose a bug that
 * no longer exists.
 */
function send(method, path, payload) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, path, true);
    if (payload !== undefined) {
      x.setRequestHeader("content-type", "application/json");
      // The body rides in a header, and the shell reads it from there.
      // `QWebEngineUrlRequestJob.requestBody()` cannot be called at all in this
      // PySide6 build — it segfaults the process rather than returning — so
      // there is no way to read a real request body on the other side. Dragging
      // a card was the first thing that wrote anything, and it crashed the
      // application outright. See the note in `scheme.py`.
      x.setRequestHeader("x-talaria-body", JSON.stringify(payload));
    }
    x.onload = () => {
      let body;
      try {
        body = JSON.parse(x.responseText);
      } catch {
        reject(new Error(`${path} did not answer with JSON`));
        return;
      }
      // The daemon answers `ok: false` with a sentence meant for a person; a
      // status code on its own would throw that sentence away.
      //
      // `message` is preferred over `error` because Fastify's default shape
      // puts the useful half there — `error` is the generic "Internal Server
      // Error" and `message` is the validation complaint that says which field
      // was wrong. Reading `error` first turned every rejected write into the
      // same unhelpful sentence.
      if (body && (body.ok === false || body.error)) {
        reject(new Error(body.message || body.error || "the daemon refused that"));
        return;
      }
      resolve(body && "data" in body ? body.data : body);
    };
    x.onerror = () => reject(new Error("can't reach the daemon — is it running?"));
    // Nothing in the body itself: it cannot be read, and sending a large one
    // twice would only make the header's ceiling arrive sooner.
    x.send(null);
  });
}

/**
 * A request whose answer arrives in pieces.
 *
 * `onEvent` is called with each SSE frame the daemon forwards — Hermes'
 * `token`, `step`, `done` and `error`, unchanged. The promise settles when the
 * stream ends, so a caller can still `await` the whole turn and use the events
 * only to show it happening.
 *
 * `x-talaria-stream` is what tells the shell to answer with a device it is
 * still writing to rather than a finished buffer; without it the reply is
 * assembled and handed over complete, which is the correct behavior for
 * everything else and useless here. See `_wants_stream` in `scheme.py`.
 *
 * XHR rather than `fetch` for the reason the whole file uses XHR — the Fetch
 * API is not available over this scheme — and it happens to be the better tool
 * anyway: `onprogress` hands over `responseText` as it grows, which is exactly
 * a stream of text frames.
 */
export function stream(path, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", path, true);
    x.setRequestHeader("content-type", "application/json");
    x.setRequestHeader("x-talaria-body", JSON.stringify(payload ?? {}));
    x.setRequestHeader("x-talaria-stream", "1");

    // How far into `responseText` has already been handed over. The text only
    // grows, so a cursor is all the state a reader needs.
    let read = 0;
    // A reader that throws — the assistant does, on an `error` frame — has to
    // reach the promise. Thrown inside `onprogress` it would otherwise be an
    // uncaught exception in an event handler and the `await` would resolve as
    // though the turn had gone fine.
    let thrown = null;
    const drain = () => {
      if (thrown) return;
      const text = x.responseText;
      // A frame ends at a blank line; anything after the last one is a frame
      // still being written and waits for the next progress event.
      const edge = text.lastIndexOf("\n\n");
      if (edge < read) return;
      for (const frame of text.slice(read, edge).split("\n\n")) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          // A frame that is not JSON is not a frame. Skipped rather than
          // fatal: the rest of the stream is still worth reading.
          continue;
        }
        try {
          onEvent(event);
        } catch (err) {
          thrown = err;
          // Stops the daemon's read, which stops Hermes: the route treats the
          // reader going away as a stop rather than letting a model write into
          // a socket nobody is reading.
          x.abort();
          reject(err);
          return;
        }
      }
      read = edge + 2;
    };

    x.onprogress = drain;
    x.onload = () => { drain(); if (!thrown) resolve(); };
    x.onerror = () => reject(new Error("can't reach the daemon — is it running?"));
    x.send(null);
  });
}

export const get = (path) => send("GET", path);
export const post = (path, payload) => send("POST", path, payload ?? {});
/* `PUT` because the daemon says `PUT` — `/scratchpad` replaces a document
 * rather than adding one, and the route is declared that way. */
export const put = (path, payload) => send("PUT", path, payload ?? {});

/** Put a message where the user will see it, without a dialog. */
export function complain(node, err) {
  node.innerHTML = "";
  const p = document.createElement("div");
  p.className = "error";
  p.textContent = String(err && err.message ? err.message : err);
  node.appendChild(p);
}

/**
 * A type's name, or nothing.
 *
 * `toCanonical` falls back to the literal string "unknown" when a block's type
 * is not in the index — `collectionKind ?? type?.name ?? "unknown"` — and that
 * word is a placeholder for the mapper's benefit, not a label for a person. It
 * was being shown as though it were a type called Unknown. The rollup already
 * guarded against it and nothing else did, which is exactly the sort of rule
 * that should live in one place.
 */
export function typeLabel(block) {
  const name = block?.typeName;
  return name && name !== "unknown" ? name : "";
}

/** Text into a node, never markup — titles are user data and arrive as typed. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/*
 * A page that is a quadrant of the desk, rather than a window of its own.
 *
 * Every panel page draws its own frame — a rounded border, a header with its
 * name — because normally it *is* the window. In a quadrant that frame lands
 * inside the pane's frame, which already has a border and a title above it, and
 * two nested boxes saying "New Block" reads as a mistake. Marked here, once,
 * because every page imports this module; the styling is in `panel.css`.
 */
if (window.parent !== window) document.documentElement.classList.add("framed");
