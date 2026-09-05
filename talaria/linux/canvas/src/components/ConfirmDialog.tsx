import { useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";

/**
 * On-theme confirmation modal. Backdrop click and Escape cancel; the Cancel
 * button is focused by default so a destructive action is never one stray
 * Enter away.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  requireText,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Make the confirm button wait for this word to be typed. For the handful of
   * actions where a second dialog would only be a second reflex — the point is
   * to make the hand stop, not to ask twice.
   */
  requireText?: string;
  /**
   * Anything the decision itself needs — a choice that changes what confirming
   * means. Sits between the message and the typed confirmation, so a box ticked
   * here is read before the word is typed.
   */
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const armed = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Portal to <body>: callers may live inside the auto-hiding right panel,
  // whose collapse (display:none) or stacking context would swallow an
  // in-place modal the moment the pointer heads toward it.
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        {message && <p className="modal-message">{message}</p>}
        {children}
        {requireText && (
          <label className="field">
            <span>
              Type <b>{requireText}</b> to confirm
            </span>
            <input
              type="text"
              autoComplete="off"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}
        <div className="modal-actions">
          <button ref={cancelRef} className="ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={danger ? "danger" : "primary"} disabled={!armed} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The choice that changes what a collection's archive means.
 *
 * One component because there are three doors to the same act — the Collections
 * list, the info pane, the Archive — and a checkbox that appears at one of them
 * is worse than none: it teaches that archiving a collection leaves its blocks
 * alone, right up until the door where it doesn't.
 *
 * `count` is what is known, not what is required. It was once the condition for
 * showing this at all, which meant a count that failed to arrive removed the
 * option and said nothing. The server acts on what is actually in the
 * collection; the number is only here to say what you are agreeing to.
 */
export function MembersChoice({
  checked,
  onChange,
  count,
  action,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  count?: number | null;
  action: "archive" | "unarchive";
}) {
  const noun =
    count == null
      ? action === "archive"
        ? "the blocks in it"
        : "the blocks archived with it"
      : `${count} block${count === 1 ? "" : "s"}`;
  return (
    <label className="modal-choice">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Also {action} {noun}
        {action === "archive"
          ? " — for a collection whose blocks arrived with it, like an import."
          : " — whatever went into the Archive alongside it comes back too."}
      </span>
    </label>
  );
}
