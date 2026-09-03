import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * How many of a list to show at once, and which slice.
 *
 * Per list, and only per list: a size set here changes this list and no other.
 * It briefly also wrote a shared default, so that lists nobody had set followed
 * whatever was picked last — which sounds helpful and is not. The Types page
 * shows eight of these at once, and setting one made seven others move on the
 * next load. A setting that changes things you did not set is not a
 * convenience, it is a list you cannot trust to stay where you put it.
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
export const PAGE_SIZE_KEY = "hn.blockview.pagesize";

const clean = (v: string | null): number | null => {
  const n = Number(v);
  return PAGE_SIZES.includes(n as (typeof PAGE_SIZES)[number]) ? n : null;
};

/**
 * The size this list should use, and a setter that pins it here and nowhere
 * else.
 *
 * `scope` names the list. Lists that name themselves keep their own size;
 * everything unnamed shares one, which is the closest thing to a right answer
 * for a list with no identity to hang a preference on. A list nobody has set
 * shows the default and keeps showing it until somebody sets *that* list.
 */
export function usePageSize(scope?: string): [number, (n: number) => void] {
  const key = scope ? `${PAGE_SIZE_KEY}.${scope}` : PAGE_SIZE_KEY;
  const read = () => {
    try {
      return clean(localStorage.getItem(key)) ?? DEFAULT_PAGE_SIZE;
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
  where = "bottom",
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (n: number) => void;
  /** Which end of the list this one is, for the margin against it. */
  where?: "top" | "bottom";
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  /**
   * The page box holds what is being typed, not the page.
   *
   * A field bound straight to the page number cannot be cleared — deleting the
   * "1" to type "12" reads as 0, clamps back to 1, and puts the caret behind a
   * digit that reappeared under it. So it keeps its own text, and only commits
   * when that text is a page.
   */
  const [typed, setTyped] = useState(String(page));
  useEffect(() => setTyped(String(page)), [page]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || raw.trim() === "") {
      setTyped(String(page));
      return;
    }
    onPage(Math.min(pages, Math.max(1, Math.floor(n))));
  };

  return (
    <div className={`pager pager-${where}`}>
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
        <label className="hint pager-jump">
          <input
            type="number"
            min={1}
            max={pages}
            value={typed}
            aria-label="Page number"
            onChange={(e) => setTyped(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit((e.target as HTMLInputElement).value);
                e.preventDefault();
              }
            }}
            disabled={pages <= 1}
          />
          of {pages}
        </label>
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
