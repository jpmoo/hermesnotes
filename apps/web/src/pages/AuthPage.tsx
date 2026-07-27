import { useState, type FormEvent } from "react";
import { ApiError } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";

export function AuthPage({
  defaultMode = "login",
  allowRegistration = true,
}: {
  defaultMode?: "login" | "register";
  allowRegistration?: boolean;
}) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">(allowRegistration ? defaultMode : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, displayName || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <img className="logo" src={`${import.meta.env.BASE_URL}brand/HermesLogoSmall.png`} alt="Hermes Notes" />
        {mode === "register" && (
          <label className="field">
            <span>Display name (optional)</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {(allowRegistration || mode === "register") && (
          <div style={{ marginTop: 14, textAlign: "center" }}>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
