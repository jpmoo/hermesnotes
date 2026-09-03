import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * How many of a list to show at once, and which slice.
 *
 * Per list, with the last choice as the default for lists nobody has set. A
 * single global size meant deciding once for a page of three hundred imported
 * notes and a rollup of four; a purely per-list one meant setting it again
 * everywhere. This is both: change it on a list and that list remembers, and
 * every list you have never touched follows whatever you last picked.
 *
 * Stored in `localStorage` under the same scope key the view mode and column
 * counts already use — how a particular list is arranged has always lived
 * there, and putting one of the four settings somewhere else would only make it
 * behave differently.
 *
 * Worth being honest about what this fixes. It is not fewer rows out of the
 * database; every block still arrives. It is fewer rows built into a DOM, and
 * on this app a block card is a live editor — three hundred of those is the
 * cost, not three hundred JSON objects.
 */

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
/** The size for lists that have never been set — the last one chosen anywhere. */
export const PAGE_SIZE_KEY = "hn.blockview.pagesize";

const clean = (v: string | null): number | null => {
  const n = Number(v);
  return PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number]) ? n : null;
};

/**
 * The size this list should use, and a setter that pins it here.
 *
 * `scope` names the list. Without one there is nothing to remember a choice
 * against, so it reads and writes the shared default — which is right: an
 * unnamed list is not a place, and a size set on it is just the size.
 */
export function usePageSize(scope?: string): [number, (n: number) => void] {
  const key = scope ? `${PAGE_SIZE_KEY}.${scope}` : PAGE_SIZE_KEY;
  const read = () => {
    try {
      return clean(localStorage.getItem(key)) ?? clean(localStorage.getItem(PAGE_SIZE_KEY)) ?? DEFAULT_PAGE_SIZE;
    } catch {
      return DEFAULT_PAGE_SIZE;
    }
  };
  const [size, setSize] = useState(read);
  // Re-read when the list changes underneath the hook — the same component
  // instance serves a different collection as somebody navigates between two.
  useEffect(() => setSize(read()), [key]);
  return [
    size,
    (n: number) => {
      setSize(n);
      try {
        localStorage.setItem(key, String(n));
        // Also the default, so the next list nobody has set follows this one.
        localStorage.setItem(PAGE_SIZE_KEY, String(n));
      } catch {
        /* a browser refusing storage still gets the size for this session */
      }
    },
  ];
}

export function Pager({
  page,
  size,
  total,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(page * size, total);
  return (
    <div className="pager">
      <span className="hint pager-range">
        {first}–{last} of {total}
      </span>
      <div className="pager-nav">
        <button
          className="icon-btn"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          title="Previous page"
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="hint">
          {page} of {pages}
        </span>
        <button
          className="icon-btn"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
          title="Next page"
          aria-label="Next page"
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <label className="pager-size hint">
        Show
        <select
          value={size}
          onChange={(e) => onSize(Number(e.target.value))}
          aria-label="Items per page"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
