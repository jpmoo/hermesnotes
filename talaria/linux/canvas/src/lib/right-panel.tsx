/*
 * Hermes' right-hand panel, which Talaria does not have.
 *
 * In the web app a canvas sits beside a panel that shows whatever is selected,
 * and the canvas both reads that selection and renders its own controls into
 * the panel's bottom slot. Talaria's canvas is the whole surface — the desk
 * slides between surfaces rather than splitting one — so there is no slot and
 * nothing to portal into.
 *
 * `selectBlock` still means something, though, and it is the useful half: it is
 * how the canvas says "this is the block somebody just asked for". Here that
 * opens it in Hermes, which is the same move every other Talaria surface makes.
 */
export function usePanels() {
  return {
    /*
     * Nothing. In Hermes this puts the block in the panel beside the canvas;
     * here the only "elsewhere" is the Hermes window, and both callers reach it
     * having *just made* the thing — a note converted into a block, a block
     * created from the toolbar. Both are already on the canvas, drawn where the
     * note was. Navigating away from a canvas somebody is arranging, at the
     * moment they add to it, is the opposite of what the call means.
     */
    selectBlock: (_id: string) => {},
    /** No slot: the controls that would portal into it simply do not render. */
    bottomSlotEl: null as HTMLElement | null,
    selectedBlockId: null as string | null,
  };
}
