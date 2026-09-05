/*
 * The daemon, from a page.
 *
 * Every path here is the daemon's own — `get("/boards")` — because the scheme
 * handler carries it to the socket. Nothing in this file knows that, which is
 * the point: these pages would work unchanged behind a real HTTP server, and
 * behind WebKitGTK's scheme handler if the shell ever changes toolkits.
 *
 * **XMLHttpRequest rather than fetch, and it is not nostalgia.** QtWebEngine
 * refuses the Fetch API on a custom scheme unless that scheme was registered
 * with `FetchApiAllowed` before the engine started — and in this PySide6 build
 * `registerScheme` does not stick at all: `schemeByName` reads back empty for
 * every name, including plain ones. The handler still serves navigation and
 * subresources, so the pages render perfectly and every request dies as "Failed
 * to fetch", which reads exactly like a dead daemon and is nowhere near it.
 * XHR is not gated the same way and reaches the handler. If a later Qt makes
 * registration work, this can go back to `fetch` and nothing above it changes.
 */
function send(method, path, payload) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, path, true);
    if (payload !== undefined) x.setRequestHeader("content-type", "application/json");
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
      if (body && body.ok === false) { reject(new Error(body.error || "the daemon refused that")); return; }
      if (body && body.error) { reject(new Error(body.error)); return; }
      resolve(body && "data" in body ? body.data : body);
    };
    x.onerror = () => reject(new Error("can't reach the daemon — is it running?"));
    x.send(payload === undefined ? null : JSON.stringify(payload ?? {}));
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

/** Text into a node, never markup — titles are user data and arrive as typed. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
