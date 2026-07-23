import { useEffect, useRef } from "react";
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
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

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
        <div className="modal-actions">
          <button ref={cancelRef} className="ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
