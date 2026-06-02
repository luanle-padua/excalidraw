import { Command, Crown, LayoutGrid, Sparkles, Zap } from "lucide-react";
import { useState } from "react";

import { useAtomValue } from "../../app-jotai";
import {
  DEMO_COMPANY,
  DEMO_DIVISION,
  DEMO_USERS,
} from "../../data/demoUsers";
import { setSession } from "../../data/session";
import { saveUserProfile, userProfileAtom } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { LangThemeSwitcher } from "./LangThemeSwitcher";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Derive a display name from the email local-part: "le.anh" → "Le Anh". */
const nameFromEmail = (email: string): string => {
  const local = email.split("@")[0] || email;
  return (
    local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
    email
  );
};

/**
 * Demo login — the first screen of the flow (app → login → project home).
 * Two-panel card: the sign-in form on the left, a brand hero on the right.
 * Email + password only (password is cosmetic in the demo — no backend
 * auth yet; Cloudflare Access SSO replaces this later with no data churn).
 */
export const LoginScreen = () => {
  const t = useT();
  const userProfile = useAtomValue(userProfileAtom);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const canSignIn = email.trim().length > 0 && password.length > 0;

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

  const signInAs = (name: string, mail: string, branch?: string) => {
    setSession({
      name,
      email: mail,
      company: branch ? DEMO_COMPANY : undefined,
      branch,
    });
    if (!userProfile) {
      saveUserProfile({
        username: name,
        company: branch ? DEMO_COMPANY : undefined,
      });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSignIn) {
      return;
    }
    const mail = email.trim();
    if (!EMAIL_RE.test(mail)) {
      setError(true);
      return;
    }
    signInAs(nameFromEmail(mail), mail);
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

          <form className="mcm-login__form" onSubmit={submit}>
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
                  setError(false);
                }}
              />
            </label>

            <label className="mcm-login__field">
              <span className="mcm-login__label">
                {t("login.passwordLabel")}
              </span>
              <input
                type="password"
                className="mcm-login__input"
                placeholder={t("login.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {error && (
              <p className="mcm-login__error">{t("login.emailInvalid")}</p>
            )}

            <button
              type="submit"
              className="mcm-login__submit"
              disabled={!canSignIn}
            >
              {t("login.signIn")}
            </button>
          </form>

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
                    onClick={() => signInAs(u.name, u.email, DEMO_DIVISION)}
                    title={`${u.title} · ${u.email}`}
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
