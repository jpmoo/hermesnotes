import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type User } from "../api.ts";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Access-key entry: a key carried in the URL fragment (#k=...) is exchanged
    // for a session cookie, then stripped so it never persists in history.
    const bootstrap = async () => {
      const match = window.location.hash.match(/[#&]k=([^&]+)/);
      if (match) {
        const key = decodeURIComponent(match[1]!);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        try {
          setUser(await api.post<User>("/auth/exchange", { key }));
          return;
        } catch (err) {
          if (!(err instanceof ApiError)) console.error(err);
        }
      }
      try {
        setUser(await api.get<User>("/auth/me"));
      } catch (err) {
        if (!(err instanceof ApiError)) console.error(err);
      }
    };
    bootstrap().finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.post<User>("/auth/login", { email, password }));
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      setUser(await api.post<User>("/auth/register", { email, password, displayName }));
    },
    [],
  );

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
