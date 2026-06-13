import { Command, LayoutGrid, Sparkles, Zap } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { supabase } from "../../data/supabaseClient";
import { useT } from "../../i18n/mcm";

import { LangThemeSwitcher } from "./LangThemeSwitcher";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Cinematic intro: the Canvas M wordmark reveals centre-screen, holds, then
// dissolves to hand off to the login card. Total run is kept in sync with the
// `mcm-login__intro` CSS animations. Skipped entirely under reduced-motion.
const INTRO_MS = 2400;
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Pull `ID,KEY` out of whatever a client pasted — a full collab URL, a bare
// `#room=ID,KEY` fragment, or just `ID,KEY` (mirrors MeetingLobby's parser).
const parseRoomLink = (
  raw: string,
): { roomId: string; roomKey: string } | null => {
  const m = raw
    .trim()
    .match(/(?:#room=)?([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]{20,})/);
  return m ? { roomId: m[1], roomKey: m[2] } : null;
};

// Dev-only quick-login grid for the seeded demo accounts. The static
// `import.meta.env.DEV` guard lets Vite drop both this chunk and the
// demoUsers module (incl. passwords) from production builds.
const DevQuickLogin = import.meta.env.DEV
  ? lazy(() => import("./DevQuickLogin"))
  : null;

/**
 * Login — the front door of the app (app → login → project home). Backed by
 * Supabase Auth: internal staff sign in with email + password; external client
 * guests can request a one-time magic link (passwordless) instead. On success
 * the session syncs via `onAuthStateChange` (see data/session.ts) and this
 * screen unmounts. The Worker independently verifies the resulting JWT, so the
 * API stays protected regardless of the UI.
 */
export const LoginScreen = () => {
  const t = useT();
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<"password" | "magic" | "link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkAccepted, setLinkAccepted] = useState(false);
  // Play the cinematic intro on first mount (once per visit to the login),
  // unless the user prefers reduced motion — then jump straight to the card.
  const [intro, setIntro] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!intro) {
      return undefined;
    }
    const id = window.setTimeout(() => setIntro(false), INTRO_MS);
    return () => window.clearTimeout(id);
  }, [intro]);

  const features = [
    { Icon: Zap, title: t("login.feat1Title"), desc: t("login.feat1Desc") },
    {
      Icon: LayoutGrid,
      title: t("login.feat2Title"),
      desc: t("login.feat2Desc"),
    },
    {
      Icon: Sparkles,
      title: t("login.feat3Title"),
      desc: t("login.feat3Desc"),
    },
    { Icon: Command, title: t("login.feat4Title"), desc: t("login.feat4Desc") },
  ];

  const doSignIn = async (mail: string, pass: string) => {
    if (!EMAIL_RE.test(mail)) {
      setError(t("login.emailInvalid"));
      return;
    }
    if (!supabase) {
      setError(t("login.signInError"));
      return;
    }
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: mail,
      password: pass,
    });
    setLoading(false);
    if (err) {
      setError(t("login.signInError"));
    }
    // success → onAuthStateChange sets the session → this screen unmounts.
  };

  const signInPassword = (e: React.FormEvent) => {
    e.preventDefault();
    void doSignIn(email.trim(), password);
  };

  // Client with only a meeting link: stash the room in the URL hash so that,
  // once they sign in (password OR guest magic-link), MeetingLobby auto-joins
  // it. Login is still required for everyone — this only carries the intent.
  const submitLink = (e: React.FormEvent) => {
    e.preventDefault();
    const data = parseRoomLink(linkValue);
    if (!data) {
      setError(t("login.linkInvalid"));
      return;
    }
    setError(null);
    window.location.hash = `#room=${data.roomId},${data.roomKey}`;
    setLinkAccepted(true);
    setMode("password");
  };

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const mail = email.trim();
    if (!EMAIL_RE.test(mail)) {
      setError(t("login.emailInvalid"));
      return;
    }
    if (!supabase) {
      setError(t("login.signInError"));
      return;
    }
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: mail,
      // Return to wherever they were (preserves any #room= invite link).
      options: { emailRedirectTo: window.location.href },
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      setMagicSent(true);
    }
  };

  return (
    <div className="mcm-login" role="dialog" aria-modal="true">
      {/* Brand wordmark on the PAGE background, behind the whole card — the
          frosted glass panes reveal it from below, and it also shows in the
          dark margins around the card. */}
      <img
        src="/canvas-m.png"
        alt=""
        aria-hidden="true"
        decoding="async"
        className="mcm-login__watermark"
      />

      {/* Cinematic intro — the wordmark reveals centre-screen, then dissolves
          and hands off to the login card. */}
      {intro && (
        <div className="mcm-login__intro" aria-hidden="true">
          <img
            src="/canvas-m.png"
            alt=""
            decoding="async"
            className="mcm-login__intro-logo"
          />
        </div>
      )}

      {!intro && (
        <div className="mcm-login__card">
        {/* Left: sign-in form */}
        <section className="mcm-login__form-pane">
          <div className="mcm-login__topbar">
            <LangThemeSwitcher />
          </div>

          <div className="mcm-login__brand">
            <img
              src="/canvas-m.png"
              alt="Canvas M"
              decoding="async"
              className="mcm-login__logo-img"
            />
          </div>
          <p className="mcm-login__dev">{t("login.dev")}</p>

          <h1 className="mcm-login__title">{t("login.title")}</h1>
          <p className="mcm-login__subtitle">{t("login.subtitle")}</p>

          {linkAccepted && !magicSent && (
            <p className="mcm-login__magic-sent">{t("login.linkAccepted")}</p>
          )}

          {magicSent ? (
            <p className="mcm-login__magic-sent">
              {t("login.magicSent", { email: email.trim() })}
            </p>
          ) : mode === "link" ? (
            <form className="mcm-login__form" onSubmit={submitLink}>
              <label className="mcm-login__field">
                <span className="mcm-login__label">
                  {t("login.linkLabel")}
                </span>
                <input
                  type="text"
                  className={`mcm-login__input${
                    error ? " mcm-login__input--error" : ""
                  }`}
                  placeholder={t("login.linkPlaceholder")}
                  value={linkValue}
                  autoFocus
                  onChange={(e) => {
                    setLinkValue(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              {error && <p className="mcm-login__error">{error}</p>}

              <button
                type="submit"
                className="mcm-login__submit"
                disabled={!linkValue.trim()}
              >
                {t("login.linkContinue")}
              </button>

              <button
                type="button"
                className="mcm-login__guest-toggle"
                onClick={() => {
                  setMode("password");
                  setError(null);
                }}
              >
                {t("login.usePassword")}
              </button>
            </form>
          ) : mode === "password" ? (
            <form className="mcm-login__form" onSubmit={signInPassword}>
              <label className="mcm-login__field">
                <span className="mcm-login__label">
                  {t("login.emailLabel")}
                </span>
                <input
                  type="email"
                  className={`mcm-login__input${
                    error ? " mcm-login__input--error" : ""
                  }`}
                  placeholder={t("login.emailPlaceholder")}
                  value={email}
                  autoFocus
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              <label className="mcm-login__field">
                <span className="mcm-login__label">
                  {t("login.passwordLabel")}
                </span>
                <input
                  ref={passwordRef}
                  type="password"
                  className="mcm-login__input"
                  placeholder={t("login.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              {error && <p className="mcm-login__error">{error}</p>}

              <button
                type="submit"
                className="mcm-login__submit"
                disabled={loading || !email.trim() || !password}
              >
                {loading ? t("login.signingIn") : t("login.signIn")}
              </button>

              <button
                type="button"
                className="mcm-login__guest-toggle"
                onClick={() => {
                  setMode("magic");
                  setError(null);
                }}
              >
                {t("login.guestToggle")}
              </button>

              <button
                type="button"
                className="mcm-login__guest-toggle"
                onClick={() => {
                  setMode("link");
                  setError(null);
                }}
              >
                {t("login.linkToggle")}
              </button>
            </form>
          ) : (
            <form className="mcm-login__form" onSubmit={sendMagicLink}>
              <label className="mcm-login__field">
                <span className="mcm-login__label">
                  {t("login.emailLabel")}
                </span>
                <input
                  type="email"
                  className={`mcm-login__input${
                    error ? " mcm-login__input--error" : ""
                  }`}
                  placeholder={t("login.emailPlaceholder")}
                  value={email}
                  autoFocus
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              {error && <p className="mcm-login__error">{error}</p>}

              <button
                type="submit"
                className="mcm-login__submit"
                disabled={loading || !email.trim()}
              >
                {loading ? t("login.signingIn") : t("login.sendMagicLink")}
              </button>

              <button
                type="button"
                className="mcm-login__guest-toggle"
                onClick={() => {
                  setMode("password");
                  setError(null);
                }}
              >
                {t("login.usePassword")}
              </button>
            </form>
          )}

          {DevQuickLogin && !magicSent && mode !== "link" && (
            <Suspense fallback={null}>
              <DevQuickLogin
                onPick={(mail, pass) => {
                  setEmail(mail);
                  void doSignIn(mail, pass);
                }}
                disabled={loading}
              />
            </Suspense>
          )}

          <p className="mcm-login__help">{t("login.needHelp")}</p>
        </section>

        {/* Right: brand hero — translucent frosted glass over the card's
            watermark + the animated desk behind it. */}
        <aside className="mcm-login__hero" aria-hidden="true">
          <div className="mcm-login__hero-inner">
            <h2 className="mcm-login__hero-title">{t("login.heroTitle")}</h2>
            <p className="mcm-login__hero-sub">{t("login.heroSubtitle")}</p>
            <ul className="mcm-login__features">
              {features.map((f) => (
                <li key={f.title} className="mcm-login__feature">
                  <span className="mcm-login__feature-icon">
                    <f.Icon size={18} />
                  </span>
                  <div className="mcm-login__feature-text">
                    <strong>{f.title}</strong>
                    <span>{f.desc}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        </div>
      )}
    </div>
  );
};

export default LoginScreen;
