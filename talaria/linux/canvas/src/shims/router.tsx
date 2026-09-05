/*
 * `react-router-dom`, which this canvas does not have.
 *
 * Hermes' canvas navigates to a block's page — it is one view inside a
 * single-page app. Talaria has no pages: a block opens in the Hermes window,
 * which is the shell's job, so `navigate` becomes the same move Glance makes
 * when a card is clicked. Aliased in `vite.config.ts` rather than edited into
 * the component, because the component is a fork and every edit is a merge
 * conflict with a future Hermes.
 */
export function useNavigate() {
  return (to: string | number) => {
    if (typeof to === "number") return;
    // The shell's navigation route decides where it belongs: a Hermes URL to
    // the Hermes window, anything else to the browser.
    const at = String(to);
    const id = /\/block\/([0-9a-fA-F-]+)/.exec(at)?.[1];
    if (!id) return;
    window.location.href = `talaria-app://daemon/open/block/${id}`;
  };
}
