// Re-export the full Lucide icon map from its own module so a dynamic import()
// of THIS file code-splits all ~1500 icons into a lazy chunk — keeping them out
// of the main bundle until the icon picker (or a custom icon) needs them.
export { icons } from "lucide-react";
