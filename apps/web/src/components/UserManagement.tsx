import { useEffect, useState } from "react";
import { api, ApiError, type AdminUser } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * Admin-only: toggle public sign-up and manage accounts (reset a password,
 * delete an account and all its data). The first admin account and your own
 * account are never deletable.
 */
export function UserManagement() {
  const { user } = useAuth();
  const [allowReg, setAllowReg] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [deleting, setDeleting] = useState<AdminUser | null>(null);

  const loadUsers = () =>
    api.get<{ users: AdminUser[] }>("/admin/users").then((r) => setUsers(r.users)).catch(() => {});

  useEffect(() => {
    void api.get<{ allowRegistration: boolean }>("/admin/registration").then((r) => setAllowReg(r.allowRegistration)).catch(() => {});
    void loadUsers();
  }, []);

  const flash = (msg: string) => {
    setNote(msg);
    setError(null);
    setTimeout(() => setNote(null), 4000);
  };
  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof ApiError ? e.message : fallback);

  const toggleRegistration = async (next: boolean) => {
    setAllowReg(next); // optimistic
    try {
      await api.put("/admin/registration", { allowRegistration: next });
    } catch (e) {
      setAllowReg(!next);
      fail(e, "could not update registration setting");
    }
  };

  const doReset = async () => {
    if (!resetting || newPassword.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/users/${resetting.id}/password`, { password: newPassword });
      flash(`Password reset for ${resetting.email}.`);
      setResetting(null);
      setNewPassword("");
    } catch (e) {
      fail(e, "could not reset password");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/admin/users/${deleting.id}`);
      flash(`Deleted ${deleting.email} and all their data.`);
      setDeleting(null);
      await loadUsers();
    } catch (e) {
      fail(e, "could not delete user");
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="panel-h" style={{ marginTop: 0 }}>Users</div>

      <label className="row" style={{ gap: 10, alignItems: "center", marginBottom: 6, cursor: "pointer" }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={allowReg ?? false}
          disabled={allowReg === null}
          onChange={(e) => void toggleRegistration(e.target.checked)}
        />
        <span>Allow public account creation</span>
      </label>
      <p className="hint" style={{ marginTop: 0 }}>
        When off, only existing users can sign in — the sign-up form is hidden and the register
        endpoint is refused server-side.
      </p>

      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
      {note && <div className="hint" style={{ marginTop: 10 }}>{note}</div>}

      <div className="user-list" style={{ marginTop: 14 }}>
        {users.map((u) => (
          <div key={u.id} className="row user-row" style={{ gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {u.displayName || u.email}
                {u.isAdmin && <span className="pill" style={{ marginLeft: 8 }}>admin</span>}
                {u.id === user?.id && <span className="hint" style={{ marginLeft: 8 }}>(you)</span>}
              </div>
              <div className="hint">
                {u.email} · {u.blockCount} block{u.blockCount === 1 ? "" : "s"} · joined{" "}
                {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
            {resetting?.id === u.id ? (
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <input
                  type="password"
                  placeholder="New password (min 8)"
                  value={newPassword}
                  autoFocus
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={{ width: 180 }}
                />
                <button className="primary" disabled={busy || newPassword.length < 8} onClick={() => void doReset()}>
                  Save
                </button>
                <button className="ghost" onClick={() => { setResetting(null); setNewPassword(""); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <button className="ghost" onClick={() => { setResetting(u); setNewPassword(""); }}>
                  Reset password
                </button>
                <button
                  className="danger"
                  disabled={u.protected || u.id === user?.id}
                  title={u.protected ? "The first admin account can't be deleted" : u.id === user?.id ? "You can't delete your own account here" : undefined}
                  onClick={() => setDeleting(u)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.displayName || deleting?.email || ""}?`}
        message={`This permanently deletes this account and ALL of their data — ${deleting?.blockCount ?? 0} block(s), collections, notes, tags, calendar feeds, and settings. This cannot be undone.`}
        confirmLabel="Delete account"
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
