import { Command, Crown, LayoutGrid, Sparkles, Zap } from "lucide-react";
import { useRef, useState } from "react";

import { DEMO_DIVISION, DEMO_USERS } from "../../data/demoUsers";
import { supabase } from "../../data/supabaseClient";
import { useT } from "../../i18n/mcm";

import { LangThemeSwitcher } from "./LangThemeSwitcher";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Internal-team demo accounts (the 5 seeded R&D users) share this initial
// password, so clicking a quick-login button signs in with one click.
const DEMO_PASSWORD = "MapMeet@2026";

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

  const [mode, setMode] = useState<"password" | "magic">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);

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

  // One-click login for the seeded internal team accounts.
  const signInDemo = (mail: string) => {
    setEmail(mail);
    void doSignIn(mail, DEMO_PASSWORD);
  };

  return (
    <div className="mcm-login" role="dialog" aria-modal="true">
      <div className="mcm-login__card">
        {/* Left: sign-in form */}
        <section className="mcm-login__form-pane">
          <div className="mcm-login__topbar">
            <LangThemeSwitcher />
          </div>

          <div className="mcm-login__brand">
            <span className="mcm-login__logo">MAP</span>
            <span className="mcm-login__brand-name">MAP CanvasMeet</span>
          </div>
          <p className="mcm-login__dev">{t("login.dev")}</p>

          <h1 className="mcm-login__title">{t("login.title")}</h1>
          <p className="mcm-login__subtitle">{t("login.subtitle")}</p>

          {magicSent ? (
            <p className="mcm-login__magic-sent">
              {t("login.magicSent", { email: email.trim() })}
            </p>
          ) : mode === "password" ? (
            <form className="mcm-login__form" onSubmit={signInPassword}>
              <label className="mcm-login__field">
                <span className="mcm-login__label">{t("login.emailLabel")}</span>
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
            </form>
          ) : (
            <form className="mcm-login__form" onSubmit={sendMagicLink}>
              <label className="mcm-login__field">
                <span className="mcm-login__label">{t("login.emailLabel")}</span>
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

          {!magicSent && (
            <div className="mcm-login__demo">
              <span className="mcm-login__demo-title">
                {t("login.demoTitle")} · {DEMO_DIVISION}
              </span>
              <ul className="mcm-login__demo-list">
                {DEMO_USERS.map((u) => (
                  <li key={u.email}>
                    <button
                      type="button"
                      className="mcm-login__demo-user"
                      onClick={() => signInDemo(u.email)}
                      title={`${u.title} · ${u.email}`}
                      disabled={loading}
                    >
                      <span className="mcm-login__demo-avatar">
                        {u.name.charAt(0)}
                      </span>
                      <span className="mcm-login__demo-info">
                        <span className="mcm-login__demo-name">
                          {u.name}
                          {u.isHost && (
                            <span className="mcm-login__demo-host">
                              <Crown size={11} /> {t("login.host")}
                            </span>
                          )}
                        </span>
                        <span className="mcm-login__demo-meta">{u.title}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mcm-login__help">{t("login.needHelp")}</p>
        </section>

        {/* Right: brand hero */}
        <aside className="mcm-login__hero" aria-hidden="true">
          <span className="mcm-login__hero-watermark">MAP</span>
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
    </div>
  );
};

export default LoginScreen;
