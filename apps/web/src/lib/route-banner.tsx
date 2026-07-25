import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * The banner of the entity currently open on a full page (block or collection).
 * Those pages publish their `properties.banner` here so the shell's
 * PageBackground can use it — landing-page banners come from prefs instead.
 */
const Ctx = createContext<{ banner: unknown; set: (v: unknown) => void }>({
  banner: null,
  set: () => {},
});

export function RouteBannerProvider({ children }: { children: ReactNode }) {
  const [banner, setBanner] = useState<unknown>(null);
  return <Ctx.Provider value={{ banner, set: setBanner }}>{children}</Ctx.Provider>;
}

export function useRouteBanner(): unknown {
  return useContext(Ctx).banner;
}

/** Publish the current page entity's banner; clears on unmount / value change. */
export function useSetRouteBanner(value: unknown): void {
  const { set } = useContext(Ctx);
  const key = JSON.stringify(value ?? null);
  useEffect(() => {
    set(value ?? null);
    return () => set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
