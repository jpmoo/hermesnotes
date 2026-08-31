/**
 * The Hermes Notes mark.
 *
 * Inline rather than an `<img>` pointing at a file, for one reason: `fill` is
 * `currentColor`, so the wing takes the colour of whatever it is sitting in.
 * The mark it replaces was a teal PNG, which meant a fixed teal on the login
 * card, in the sidebar, and on a dark theme that wanted something lighter — and
 * no way to say so short of shipping a second file.
 *
 * One path, square, `viewBox` 0 0 32 32. Callers size it and colour it; nothing
 * here decides either. The favicon is the same path as a static file
 * (`public/brand/wing.svg`), which cannot be `currentColor` because a browser
 * tab inherits nothing from the page.
 */
export function WingMark({
  size = 28,
  className,
  title = "Hermes Notes",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label={title}
    >
      <path d="M28.665 25.537c-1.966-1.094-3.116-2.962-3.232-4.673-0.619-9.164-15.889-10.357-23.662-19.509l-0 0c0.403 11.661 13.204 11.604 20.744 17.449-4.879-2.113-12.876-1.649-18.664-5.404 2.7 8.775 12.332 5.886 19.406 8.271-4.212-0.411-9.768 1.968-15.020 0.086 4.638 7.31 10.654 2.427 16.483 2.47-2.94 0.749-5.977 4.025-10.036 3.718 4.946 4.76 7.536 0.139 11.079-1.633-0.357 0.425-0.583 0.967-0.61 1.565-0.064 1.443 1.054 2.665 2.497 2.73s2.665-1.054 2.73-2.497c0.052-1.169-0.672-2.193-1.716-2.574z" />
    </svg>
  );
}
