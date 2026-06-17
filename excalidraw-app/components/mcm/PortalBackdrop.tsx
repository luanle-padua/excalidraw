import { useEffect, useRef, useState } from "react";

import {
  fetchBrandingLogo,
  getPortalBranding,
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
 * Resolve once the image at `src` has actually decoded (true) or failed/blank
 * (false). We adopt an admin backdrop ONLY after this confirms it paints, so a
 * dead/revoked object URL can never blank the portal — we keep the bundled
 * THEMES instead. (A revoked or broken object URL renders as nothing, which is
 * exactly the blank we're guarding against.)
 */
const imageLoads = (src: string): Promise<boolean> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });

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
  // The signed-in client's company logo (object URL) — overlaid on the backdrop.
  // null for staff/admin or a client with no logo. Revoked on unmount.
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  const logoRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Resolve THIS client's branding first: country picks the backdrop, the
      // logo overlays it. Staff/admin (or pre-identification) → null → the full
      // default rotation, no logo. Never throws (getPortalBranding swallows).
      const branding = await getPortalBranding();
      if (branding?.logoUrl) {
        const src = await fetchBrandingLogo(branding.logoUrl);
        if (cancelled) {
          if (src) {
            URL.revokeObjectURL(src);
          }
        } else if (src) {
          logoRef.current = src;
          setLogoSrc(src);
        }
      }
      const items = await listPortalBackdrops(branding?.country);
      // PRELOAD + VALIDATE before adopting: only keep admin images that actually
      // decode. This is what makes a blank impossible — if the fetch raced with a
      // StrictMode unmount/remount (so an object URL got revoked), or an image is
      // otherwise broken, it simply won't be adopted and we hold the THEMES.
      const loaded = await Promise.all(items.map((it) => imageLoads(it.src)));
      if (cancelled) {
        // Lost the race (unmounted) — clean up every object URL we created.
        items.forEach((it) => URL.revokeObjectURL(it.src));
        return;
      }
      const good = items.filter((_, i) => loaded[i]);
      // Revoke the ones that did NOT load — they'd only leak.
      items.forEach((it, i) => {
        if (!loaded[i]) {
          URL.revokeObjectURL(it.src);
        }
      });
      if (good.length >= 1) {
        // Keep these alive for the component's lifetime; revoked on unmount.
        fetchedRef.current = good;
        setSources(good.map((it) => it.src));
        // Reset the rotation to the new (admin) list.
        setActive(0);
        setSeen(new Set([0]));
      }
      // good.length === 0 → keep the bundled THEMES (never blank).
    })();
    return () => {
      cancelled = true;
      fetchedRef.current.forEach((it) => URL.revokeObjectURL(it.src));
      fetchedRef.current = [];
      if (logoRef.current) {
        URL.revokeObjectURL(logoRef.current);
        logoRef.current = null;
      }
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
      {/* The signed-in client's company logo, overlaid on the backdrop. */}
      {logoSrc && (
        <img
          className="mcm-portal__client-logo"
          src={logoSrc}
          alt=""
          aria-hidden="true"
          decoding="async"
        />
      )}
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
