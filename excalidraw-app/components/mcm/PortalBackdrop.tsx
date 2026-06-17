import { useEffect, useRef, useState } from "react";

import {
  listPortalBackdrops,
  type PortalBackdropImage,
} from "../../data/backdrops";

// Multinational welcome themes — they crossfade in turn on the client-facing
// surfaces (portal + waiting room). These are the BUNDLED DEFAULTS: the live
// rotation is now admin-managed (Admin → Backdrops, stored in R2), fetched on
// mount via listPortalBackdrops(). If the admin list is empty or the fetch
// fails, we fall back to these so the page never breaks. Add a bundled theme by
// dropping the image in public/backgrounds/ and appending its path here.
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
 * The rotation is admin-managed (uploaded to R2, read via the portal API on
 * mount); it falls back to the bundled THEMES above when the admin list is
 * empty or the fetch fails, so the page never breaks.
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
  // The live source list: bundled default paths, OR admin object URLs once the
  // fetch resolves with ≥1 item. We track the fetched items separately so we
  // can revoke their object URLs on unmount.
  const [sources, setSources] = useState<string[]>(THEMES);
  const fetchedRef = useRef<PortalBackdropImage[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listPortalBackdrops().then((items) => {
      if (cancelled) {
        // Lost the race (unmounted) — clean up the object URLs we created.
        items.forEach((it) => URL.revokeObjectURL(it.src));
        return;
      }
      if (items.length >= 1) {
        fetchedRef.current = items;
        setSources(items.map((it) => it.src));
        // Reset the rotation to the new (admin) list.
        setActive(0);
        setSeen(new Set([0]));
      }
    });
    return () => {
      cancelled = true;
      fetchedRef.current.forEach((it) => URL.revokeObjectURL(it.src));
      fetchedRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (reduceMotion() || sources.length < 2) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setActive((cur) => {
        const next = (cur + 1) % sources.length;
        setSeen((s) => (s.has(next) ? s : new Set(s).add(next)));
        return next;
      });
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [sources]);

  return (
    <div className="mcm-portal__bg" aria-hidden="true">
      {sources.map((src, i) => (
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
