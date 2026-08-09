import { createContext, useContext, type ReactNode } from "react";

/**
 * The day a page stands on. A Today page is about its own date, so everything
 * embedded there should read that way: a smart list of "due today" means the day
 * you're looking at, a matrix in date mode counts its columns from there, and an
 * embedded calendar opens on that month rather than this one.
 *
 * Null everywhere else, which means the real today — so nothing outside a Today
 * page changes, and a component that doesn't care can ignore this entirely.
 */
const Ctx = createContext<string | null>(null);

export function AsOfProvider({ date, children }: { date: string | null; children: ReactNode }) {
  return <Ctx.Provider value={date}>{children}</Ctx.Provider>;
}

/** The date this page is about (YYYY-MM-DD), or null for the actual today. */
export function useAsOf(): string | null {
  return useContext(Ctx);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Today, or the day the page is standing on. */
export function useToday(): string {
  const asOf = useAsOf();
  if (asOf) return asOf;
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
