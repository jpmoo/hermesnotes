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

export const get = (path) => send("GET", path);
export const post = (path, payload) => send("POST", path, payload ?? {});

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
