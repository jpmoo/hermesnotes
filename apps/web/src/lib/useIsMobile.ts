import { useEffect, useState } from "react";

/** True on phone-width viewports (coarse pointer or ≤ 720px wide). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => match());
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const on = () => setMobile(match());
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  return mobile;
}

function match(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 720px)").matches;
}
