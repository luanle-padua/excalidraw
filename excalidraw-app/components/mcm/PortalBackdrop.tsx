import { useEffect, useState } from "react";

// Multinational welcome themes — they crossfade in turn on the client-facing
// surfaces (portal + waiting room). Add a national theme by dropping the image
// in public/backgrounds/ and appending its path here; the rotation scales
// itself (anh Luân 06-16: "đa quốc gia, sau này thêm nhiều cái nữa").
const THEMES = [
  "/backgrounds/client-forest.webp",
  "/backgrounds/client-africa.webp",
  "/backgrounds/client-usa.webp",
  "/backgrounds/client-vn.webp",
  "/backgrounds/client-africa2.webp",
  "/backgrounds/client-pl.webp",
  "/backgrounds/client-in.webp",
];
const ROTATE_MS = 9000;

const reduceMotion = (): boolean =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Rotating multinational backdrop shared by the client portal and the guest
 * waiting room: stacked theme layers that crossfade (CSS owns the fade), a
 * legibility scrim, and the Canvas M wordmark watermark.
 *
 * Perf: a theme's image is only attached once that theme has been shown
 * (`seen`), so the page loads ONE backdrop up front, not all of them — these
 * are large photos and the set keeps growing. (They should still be optimized;
 * see docs note.) Once loaded a layer stays mounted, so rotating back is
 * instant. Honours prefers-reduced-motion (holds the first theme).
 */
export const PortalBackdrop = () => {
  const [active, setActive] = useState(0);
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]));

  useEffect(() => {
    if (reduceMotion() || THEMES.length < 2) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setActive((cur) => {
        const next = (cur + 1) % THEMES.length;
        setSeen((s) => (s.has(next) ? s : new Set(s).add(next)));
        return next;
      });
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="mcm-portal__bg" aria-hidden="true">
      {THEMES.map((src, i) => (
        <span
          key={src}
          className={`mcm-portal__bg-layer${
            i === active ? " mcm-portal__bg-layer--on" : ""
          }`}
          // Data-driven theme image; only attached once first shown (lazy load).
          // eslint-disable-next-line react/forbid-dom-props
          style={seen.has(i) ? { backgroundImage: `url("${src}")` } : undefined}
        />
      ))}
      <span className="mcm-portal__bg-scrim" />
      <img
        className="mcm-portal__watermark"
        src="/canvas-m.png"
        alt=""
        aria-hidden="true"
        decoding="async"
      />
    </div>
  );
};

export default PortalBackdrop;
