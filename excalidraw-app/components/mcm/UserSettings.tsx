// User Settings — a tabbed, Glass-Desk modal that gathers everything the
// signed-in user can change about THEIR OWN account/session in one place
// (the meeting-header ⚙ and the dashboard account menu both open it).
//
// Six tabs:
//   1. Profile      — name + company + avatar (the SHARED ProfileEditor from
//                     UserProfileModal; identical gallery/upload/save path).
//   2. Account/Org  — email · 직급/title · division · role, READ-ONLY from the
//                     org system of record via `GET /v1/me` (no directory fan-out).
//   3. Security     — change password (verify-old-first) + Sign out. HIDDEN for
//                     guests (magic-link logins have no password).
//   4. Preferences  — every per-device/session pref atom in one column.
//   5. My Data      — read-only lists: meetings, invitations, files (`/v1/me/*`).
//   6. Privacy      — STT mic-consent toggle + a plain-language data note.
//
// Identity NEVER comes from this modal: the org fields are read-only (the org
// team owns them); only the profile display name/avatar + the local pref atoms
// are writable here. Each control calls the SAME `setX()` the rest of the app
// uses, so a change here is indistinguishable from changing it inline.

import { THEME } from "@excalidraw/excalidraw";
import {
  CircleUserRound,
  Database,
  LogOut,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAtom, useAtomValue } from "../../app-jotai";
import { useAppLangCode } from "../../app-language/language-state";
import { audioRoomInstanceAtom } from "../../audio/audioState";
import {
  BLUR_STRENGTHS,
  VIDEO_BG_IMAGE_PRESETS,
  isVideoBgSupported,
  setVideoBgPref,
  videoBgAtom,
  type BlurLevel,
  type VideoBg,
} from "../../audio/videoBg";
import {
  allowedTiers,
  setVideoQualityPref,
  videoQualityAtom,
  videoQualityCapAtom,
  type QualityLevel,
} from "../../audio/videoQuality";
import { getMyMeetingsChecked, type CalMeeting } from "../../data/calendar";
import { fetchWithAuth } from "../../data/fetchWithAuth";
import {
  getMyInvitationsChecked,
  type MyInvitation,
} from "../../data/invite";
import { sessionAtom, signOut } from "../../data/session";
import { supabase } from "../../data/supabaseClient";
import {
  captionDockEnabledAtom,
  captionFontScaleAtom,
  captionLineCountAtom,
  CAPTION_FONT_SCALES,
  CAPTION_LINE_COUNTS,
  setCaptionDockEnabled,
  setCaptionFontScale,
  setCaptionLineCount,
  type CaptionFontScale,
  type CaptionLineCount,
} from "../../data/captionState";
import {
  setTranslationEnabled,
  translationEnabledAtom,
} from "../../data/translation";
import {
  setSttEnabled,
  setSttPanelStyle,
  setSttSpokenLanguage,
  setSttTranslateEnabled,
  SPOKEN_LANGUAGES,
  sttEnabledAtom,
  sttPanelStyleAtom,
  sttSpokenLanguageAtom,
  sttTranslateEnabledAtom,
  type STTPanelStyle,
} from "../../data/transcription";
import { listMyFilesChecked, type UserFile } from "../../data/userFiles";
import { useT } from "../../i18n/mcm";
import { appThemeAtom } from "../../useHandleAppTheme";

import { ProfileEditor } from "./UserProfileModal";

import type { STTLang } from "../../data/transcription";

import "./UserSettings.scss";

const STORAGE_URL =
  import.meta.env.VITE_DEV_TUNNEL === "true"
    ? ""
    : (import.meta.env.VITE_APP_STORAGE_URL || "").replace(/\/$/, "");

// The org system of record (read-only here). The org team owns `GET /v1/me`;
// we only RENDER these fields — never write them back from this modal.
type MeProfile = {
  email: string;
  name?: string;
  title?: string;
  division?: string;
  role?: string;
  company?: string;
  avatar?: string;
  isAdmin?: boolean;
  isGuest?: boolean;
};

type Tab =
  | "profile"
  | "account"
  | "security"
  | "preferences"
  | "data"
  | "privacy";

// MCM language ↔ Excalidraw lang-code mapping. Picking a UI language here goes
// through useAppLangCode (the single source of truth — it retitles Excalidraw's
// own menus AND drives preferredLanguageAtom / chat translation).
const UI_LANGS: { mcm: "vi" | "en" | "ko"; code: string; label: string }[] = [
  { mcm: "vi", code: "vi-VN", label: "Tiếng Việt" },
  { mcm: "en", code: "en", label: "English" },
  { mcm: "ko", code: "ko-KR", label: "한국어" },
];

// Native labels for the STT spoken-language picker. STT supports a narrower set
// (SPOKEN_LANGUAGES = en/ko/vi) than the chat translation languages.
const SPOKEN_LABELS: Record<string, string> = {
  en: "English",
  ko: "한국어",
  vi: "Tiếng Việt",
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the profile name on first open (mirrors UserProfileModal). */
  defaultUsername?: string;
};

export const UserSettings = ({ open, onClose, defaultUsername }: Props) => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [tab, setTab] = useState<Tab>("profile");
  // Bumped each open so the embedded ProfileEditor re-seeds from the stored
  // profile (same contract as UserProfileModal).
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    if (open) {
      setOpenCount((n) => n + 1);
      setTab("profile");
    }
  }, [open]);

  // Esc closes the whole modal (matches UserProfileModal).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Guests log in via magic-link (no password), so the Security tab is hidden.
  const isGuest = Boolean(session?.isGuest);

  const tabs = useMemo(
    () =>
      (
        [
          { id: "profile", icon: UserRound, label: t("settings.tabProfile") },
          {
            id: "account",
            icon: CircleUserRound,
            label: t("settings.tabAccount"),
          },
          // Security only for password logins.
          ...(isGuest
            ? []
            : [
                {
                  id: "security",
                  icon: ShieldCheck,
                  label: t("settings.tabSecurity"),
                },
              ]),
          {
            id: "preferences",
            icon: Settings2,
            label: t("settings.tabPreferences"),
          },
          { id: "data", icon: Database, label: t("settings.tabData") },
          {
            id: "privacy",
            icon: ShieldQuestion,
            label: t("settings.tabPrivacy"),
          },
        ] as { id: Tab; icon: typeof UserRound; label: string }[]
      ),
    [isGuest, t],
  );

  if (!open) {
    return null;
  }

  return (
    <div
      className="mcm-settings"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="mcm-settings__card" role="document">
        <header className="mcm-settings__header">
          <h2 className="mcm-settings__title">{t("settings.title")}</h2>
          <button
            type="button"
            className="mcm-settings__close"
            onClick={onClose}
            aria-label={t("settings.close")}
            title={t("settings.close")}
          >
            <X size={18} />
          </button>
        </header>

        <div className="mcm-settings__main">
          <nav className="mcm-settings__tabs" aria-label={t("settings.title")}>
            {tabs.map((tb) => {
              const Icon = tb.icon;
              return (
                <button
                  key={tb.id}
                  type="button"
                  className={`mcm-settings__tab${
                    tab === tb.id ? " --active" : ""
                  }`}
                  onClick={() => setTab(tb.id)}
                  aria-current={tab === tb.id ? "page" : undefined}
                >
                  <Icon size={16} aria-hidden />
                  <span>{tb.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="mcm-settings__body">
            {tab === "profile" && (
              // The SHARED editor — same gallery/upload/save the standalone
              // profile modal uses. No Cancel button: the header X is the close.
              <div className="mcm-settings__profile">
                <ProfileEditor
                  defaultUsername={defaultUsername}
                  resetKey={openCount}
                />
              </div>
            )}
            {tab === "account" && <AccountTab />}
            {tab === "security" && !isGuest && <SecurityTab />}
            {tab === "preferences" && <PreferencesTab />}
            {tab === "data" && <MyDataTab />}
            {tab === "privacy" && <PrivacyTab />}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Account / Org — READ-ONLY identity from the org system of record.
// ---------------------------------------------------------------------------

const AccountTab = () => {
  const t = useT();
  const session = useAtomValue(sessionAtom);
  const [me, setMe] = useState<MeProfile | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  // Authoritative org fields come from `GET /v1/me` (the org team owns it).
  // We deliberately DON'T fan out the full /v1/directory here — that's a heavy
  // org-wide read just to find one's own row. Session is the instant fallback.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void fetchWithAuth(`${STORAGE_URL}/v1/me`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(String(res.status));
        }
        return (await res.json()) as MeProfile;
      })
      .then((data) => {
        if (!cancelled) {
          setMe(data);
          setState("ok");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fall back to the verified session so the panel shows SOMETHING even if
  // /v1/me is unreachable (the session is already trusted — it's the JWT).
  const email = me?.email ?? session?.email ?? "—";
  const title = me?.title ?? "—";
  const division = me?.division ?? session?.branch ?? "—";
  const role = me?.role ?? session?.role ?? t("settings.roleStaff");
  const company = me?.company ?? session?.company ?? "—";

  const rows: { label: string; value: string }[] = [
    { label: t("settings.email"), value: email },
    { label: t("settings.titleField"), value: title },
    { label: t("settings.division"), value: division },
    { label: t("settings.role"), value: role },
    { label: t("settings.company"), value: company },
  ];

  return (
    <div className="mcm-settings__section">
      <p className="mcm-settings__note">{t("settings.accountNote")}</p>
      {state === "error" && (
        <div className="mcm-settings__banner">{t("settings.accountError")}</div>
      )}
      <dl className="mcm-settings__dl">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Security — change password (verify-old-first) + Sign out.
// ---------------------------------------------------------------------------

const SecurityTab = () => {
  const t = useT();
  const session = useAtomValue(sessionAtom);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleChange = async () => {
    setError(null);
    setDone(false);
    if (!session?.email || !supabase) {
      setError(t("settings.pwUnavailable"));
      return;
    }
    if (next.length < 8) {
      setError(t("settings.pwTooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("settings.pwMismatch"));
      return;
    }
    setBusy(true);
    try {
      // VERIFY the CURRENT password first. Supabase's updateUser does NOT
      // re-check the old password (it trusts the existing session), so without
      // this an attacker on an unlocked, already-signed-in browser could change
      // the password. signInWithPassword re-authenticates against the current
      // credential — a wrong "current" fails here before we ever touch updateUser.
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: session.email,
        password: current,
      });
      if (signInErr) {
        setError(t("settings.pwWrongCurrent"));
        return;
      }
      const { error: updErr } = await supabase.auth.updateUser({
        password: next,
      });
      if (updErr) {
        // Most common: Supabase rejects a password equal to the current one,
        // or one that fails the project's strength policy.
        setError(updErr.message || t("settings.pwUpdateFailed"));
        return;
      }
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      setError(t("settings.pwUpdateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    current.length > 0 && next.length > 0 && confirm.length > 0 && !busy;

  return (
    <div className="mcm-settings__section">
      <h3 className="mcm-settings__h3">{t("settings.changePassword")}</h3>
      <p className="mcm-settings__note">{t("settings.changePasswordNote")}</p>

      <label className="mcm-settings__field">
        <span>{t("settings.currentPassword")}</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label className="mcm-settings__field">
        <span>{t("settings.newPassword")}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label className="mcm-settings__field">
        <span>{t("settings.confirmPassword")}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>

      {error && <div className="mcm-settings__banner --err">{error}</div>}
      {done && <div className="mcm-settings__banner --ok">{t("settings.pwChanged")}</div>}

      <button
        type="button"
        className="mcm-settings__btn mcm-settings__btn--primary"
        onClick={() => void handleChange()}
        disabled={!canSubmit}
      >
        {busy ? t("settings.pwSaving") : t("settings.savePassword")}
      </button>

      <div className="mcm-settings__danger">
        <button
          type="button"
          className="mcm-settings__btn mcm-settings__btn--danger"
          onClick={() => void signOut()}
        >
          <LogOut size={15} aria-hidden />
          {t("settings.signOut")}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Preferences — every per-device/session pref atom in one column.
// ---------------------------------------------------------------------------

/** A labelled row with a control on the right — the workhorse pref layout. */
const PrefRow = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <div className="mcm-settings__pref">
    <div className="mcm-settings__pref-text">
      <span className="mcm-settings__pref-label">{label}</span>
      {hint && <span className="mcm-settings__pref-hint">{hint}</span>}
    </div>
    <div className="mcm-settings__pref-ctl">{children}</div>
  </div>
);

/** A small iOS-style on/off switch driven by an atom + its setter. */
const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={`mcm-settings__switch${checked ? " --on" : ""}`}
    onClick={() => onChange(!checked)}
  >
    <span className="mcm-settings__switch-knob" />
  </button>
);

/** A segmented pill control (used for the small enum prefs). */
const Segmented = <V extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: V;
  options: { v: V; label: string }[];
  onChange: (v: V) => void;
  ariaLabel: string;
}) => (
  <div className="mcm-settings__seg" role="group" aria-label={ariaLabel}>
    {options.map((o) => (
      <button
        key={String(o.v)}
        type="button"
        className={`mcm-settings__seg-btn${value === o.v ? " --active" : ""}`}
        aria-pressed={value === o.v}
        onClick={() => onChange(o.v)}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const PreferencesTab = () => {
  const t = useT();
  // Each control reads the atom (live value) AND calls the matching `setX()`
  // persistor — the SAME pair the inline controls use, so a change here behaves
  // identically. The atom setter gives instant UI; setX() writes localStorage.
  const [langCode, setLangCode] = useAppLangCode();
  const [appTheme, setAppTheme] = useAtom(appThemeAtom);
  const [translationEnabled, setTranslationAtom] = useAtom(
    translationEnabledAtom,
  );
  const [sttTranslate, setSttTranslateAtom] = useAtom(sttTranslateEnabledAtom);
  const [sttEnabled, setSttEnabledAtom] = useAtom(sttEnabledAtom);
  const [spokenLang, setSpokenLangAtom] = useAtom(sttSpokenLanguageAtom);
  const [panelStyle, setPanelStyleAtom] = useAtom(sttPanelStyleAtom);
  const [captionDock, setCaptionDockAtom] = useAtom(captionDockEnabledAtom);
  const [captionLines, setCaptionLinesAtom] = useAtom(captionLineCountAtom);
  const [captionFont, setCaptionFontAtom] = useAtom(captionFontScaleAtom);

  // Virtual-background (blur / company scene) preference. Persisted per-browser
  // via setVideoBgPref; the picker reflects the live atom value. Read the live
  // call object (the SAME global atom MeetingCallControls used) so a change here
  // applies immediately when the user is already in a meeting with the camera on.
  const videoBg = useAtomValue(videoBgAtom);
  const audioRoom = useAtomValue(audioRoomInstanceAtom);

  // Video-quality ceiling: the user's own pick + the org-wide admin cap (read
  // from GET /v1/config at login). The picker greys out tiers above the cap and
  // re-applies live if the user is already in a call (mirrors applyVideoBg).
  const [videoQuality, setVideoQualityAtom] = useAtom(videoQualityAtom);
  const videoQualityCap = useAtomValue(videoQualityCapAtom);
  const allowedQualityTiers = allowedTiers(videoQualityCap);
  // Daily's background processors are DESKTOP-ONLY (no-op on iPad / phone web).
  // Probe once on mount — it can't change for the life of the page — so the
  // subsection can render disabled + explained on mobile rather than silently
  // no-op. State (not a bare call) so the value is stable across re-renders.
  const [bgSupported] = useState(isVideoBgSupported);

  // Pick a virtual background: persist it (so it survives reload AND re-applies
  // the next time the camera turns on — videoBg.ts owns the auto-apply) and, if
  // a live call object exists, push it now so an already-on camera updates
  // instantly. Fire-and-forget: a processor failure must never break the picker.
  const applyVideoBg = (bg: VideoBg) => {
    setVideoBgPref(bg);
    void audioRoom?.setVideoBackground(bg).catch(() => undefined);
  };

  // Pick a video-quality ceiling: persist it (survives reload + re-applies on
  // the next camera-on — videoQuality.ts owns the clamp-against-cap) and, if a
  // live call exists, push it now so an already-on camera re-encodes instantly.
  // setVideoQuality is owned by DailyAudio (parallel to setVideoBackground); we
  // feature-detect it so this UI typechecks and no-ops cleanly until DailyAudio
  // ships the method — the persisted pref still applies on the next camera cycle.
  const applyVideoQuality = (level: QualityLevel) => {
    setVideoQualityPref(level);
    setVideoQualityAtom(level);
    const room = audioRoom as
      | { setVideoQuality?: (l: QualityLevel) => Promise<unknown> }
      | null;
    void room?.setVideoQuality?.(level)?.catch(() => undefined);
  };

  // The UI-language <select> mirrors the live MCM language: map the current
  // Excalidraw lang code to its UI_LANG row (vi-VN/ko-KR → vi/ko, else en).
  const currentLangCode =
    UI_LANGS.find((l) => l.code === langCode)?.code ??
    (langCode.startsWith("vi")
      ? "vi-VN"
      : langCode.startsWith("ko")
        ? "ko-KR"
        : "en");

  return (
    <div className="mcm-settings__section">
      {/* --- Appearance --- */}
      <h3 className="mcm-settings__h3">{t("settings.prefAppearance")}</h3>

      <PrefRow label={t("settings.uiLanguage")} hint={t("settings.uiLanguageHint")}>
        <select
          className="mcm-settings__select"
          value={currentLangCode}
          onChange={(e) => setLangCode(e.target.value)}
          aria-label={t("settings.uiLanguage")}
        >
          {UI_LANGS.map((l) => (
            <option key={l.mcm} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </PrefRow>

      <PrefRow label={t("settings.theme")}>
        <Segmented
          ariaLabel={t("settings.theme")}
          value={appTheme}
          options={[
            { v: THEME.LIGHT, label: t("settings.themeLight") },
            { v: THEME.DARK, label: t("settings.themeDark") },
            { v: "system", label: t("settings.themeSystem") },
          ]}
          onChange={(v) => setAppTheme(v)}
        />
      </PrefRow>

      {/* --- Translation --- */}
      <h3 className="mcm-settings__h3">{t("settings.prefTranslation")}</h3>

      <PrefRow
        label={t("settings.chatTranslate")}
        hint={t("settings.chatTranslateHint")}
      >
        <Toggle
          checked={translationEnabled}
          label={t("settings.chatTranslate")}
          onChange={(v) => {
            setTranslationAtom(v);
            setTranslationEnabled(v);
          }}
        />
      </PrefRow>

      {/* --- Speech-to-text --- */}
      <h3 className="mcm-settings__h3">{t("settings.prefStt")}</h3>

      <PrefRow
        label={t("settings.micStt")}
        hint={t("settings.micSttHint")}
      >
        <Toggle
          checked={sttEnabled}
          label={t("settings.micStt")}
          onChange={(v) => {
            setSttEnabledAtom(v);
            setSttEnabled(v);
          }}
        />
      </PrefRow>

      <PrefRow label={t("settings.spokenLanguage")} hint={t("settings.spokenLanguageHint")}>
        <select
          className="mcm-settings__select"
          value={spokenLang}
          onChange={(e) => {
            const lang = e.target.value as STTLang;
            setSpokenLangAtom(lang);
            setSttSpokenLanguage(lang);
          }}
          aria-label={t("settings.spokenLanguage")}
        >
          {SPOKEN_LANGUAGES.map((lng) => (
            <option key={lng} value={lng}>
              {SPOKEN_LABELS[lng] ?? lng}
            </option>
          ))}
        </select>
      </PrefRow>

      <PrefRow
        label={t("settings.sttTranslate")}
        hint={t("settings.sttTranslateHint")}
      >
        <Toggle
          checked={sttTranslate}
          label={t("settings.sttTranslate")}
          onChange={(v) => {
            setSttTranslateAtom(v);
            setSttTranslateEnabled(v);
          }}
        />
      </PrefRow>

      <PrefRow label={t("settings.panelStyle")}>
        <Segmented
          ariaLabel={t("settings.panelStyle")}
          value={panelStyle}
          options={[
            { v: "full" as STTPanelStyle, label: t("settings.panelFull") },
            { v: "compact" as STTPanelStyle, label: t("settings.panelCompact") },
          ]}
          onChange={(v) => {
            setPanelStyleAtom(v);
            setSttPanelStyle(v);
          }}
        />
      </PrefRow>

      {/* --- Captions --- */}
      <h3 className="mcm-settings__h3">{t("settings.prefCaptions")}</h3>

      <PrefRow
        label={t("settings.captionDock")}
        hint={t("settings.captionDockHint")}
      >
        <Toggle
          checked={captionDock}
          label={t("settings.captionDock")}
          onChange={(v) => {
            setCaptionDockAtom(v);
            setCaptionDockEnabled(v);
          }}
        />
      </PrefRow>

      <PrefRow label={t("settings.captionLines")}>
        <Segmented
          ariaLabel={t("settings.captionLines")}
          value={captionLines}
          options={CAPTION_LINE_COUNTS.map((n) => ({ v: n, label: String(n) }))}
          onChange={(v) => {
            setCaptionLinesAtom(v as CaptionLineCount);
            setCaptionLineCount(v as CaptionLineCount);
          }}
        />
      </PrefRow>

      <PrefRow label={t("settings.captionFont")}>
        <Segmented
          ariaLabel={t("settings.captionFont")}
          value={captionFont}
          options={CAPTION_FONT_SCALES.map((s) => ({
            v: s,
            label: t(`settings.font_${s}` as never),
          }))}
          onChange={(v) => {
            setCaptionFontAtom(v as CaptionFontScale);
            setCaptionFontScale(v as CaptionFontScale);
          }}
        />
      </PrefRow>

      {/* --- Camera background ---
          Virtual background for the outgoing camera feed (moved here from the
          call controls so the bar stays compact). Desktop-only: on iPad/phone
          web Daily's processor is unsupported, so the whole picker renders
          disabled with an explaining note rather than silently no-op. */}
      <h3 className="mcm-settings__h3">{t("videoBg.title")}</h3>

      {!bgSupported && (
        <p className="mcm-settings__note">{t("videoBg.desktopOnlyTitle")}</p>
      )}

      <div
        className={`mcm-settings__bg${bgSupported ? "" : " --disabled"}`}
        aria-disabled={!bgSupported}
      >
        {/* None / Blur(light·medium·strong) / 3 image presets — one flat radio
            group so only a single choice is ever active. */}
        <div className="mcm-settings__bg-row" role="radiogroup" aria-label={t("videoBg.title")}>
          <button
            type="button"
            role="radio"
            aria-checked={videoBg.kind === "none"}
            disabled={!bgSupported}
            className={`mcm-settings__bg-chip${
              videoBg.kind === "none" ? " --active" : ""
            }`}
            onClick={() => applyVideoBg({ kind: "none" })}
          >
            {t("videoBg.none")}
          </button>

          {(Object.keys(BLUR_STRENGTHS) as BlurLevel[]).map((level) => {
            const active = videoBg.kind === "blur" && videoBg.level === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!bgSupported}
                className={`mcm-settings__bg-chip${active ? " --active" : ""}`}
                onClick={() => applyVideoBg({ kind: "blur", level })}
              >
                {t("videoBg.blur")} · {t(`videoBg.blur_${level}`)}
              </button>
            );
          })}
        </div>

        <div className="mcm-settings__bg-grid" role="radiogroup" aria-label={t("videoBg.images")}>
          {VIDEO_BG_IMAGE_PRESETS.map((preset) => {
            const active =
              videoBg.kind === "image" && videoBg.src === preset.src;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!bgSupported}
                className={`mcm-settings__bg-thumb${active ? " --active" : ""}`}
                style={{ backgroundImage: `url("${preset.src}")` }}
                onClick={() => applyVideoBg({ kind: "image", src: preset.src })}
                title={t(preset.labelKey)}
                aria-label={t(preset.labelKey)}
              />
            );
          })}
        </div>
      </div>

      {/* --- Video quality ---
          The user's own ceiling for the OUTGOING camera (Daily ABR still floats
          below it on a weak uplink). "Auto" rides the admin cap; the explicit
          tiers are disabled past the cap so a user can never exceed the org
          limit — the same clamp videoQuality.ts enforces when applying. */}
      <h3 className="mcm-settings__h3">{t("videoQuality.title")}</h3>

      <PrefRow label={t("videoQuality.title")} hint={t("videoQuality.hint")}>
        <div
          className="mcm-settings__seg"
          role="group"
          aria-label={t("videoQuality.title")}
        >
          {(["auto", "low", "medium", "high"] as const).map((level) => {
            // "auto" is always selectable (it just rides whatever the cap is);
            // concrete tiers are disabled when they sit above the admin cap.
            const blocked =
              level !== "auto" && !allowedQualityTiers.includes(level);
            return (
              <button
                key={level}
                type="button"
                className={`mcm-settings__seg-btn${
                  videoQuality === level ? " --active" : ""
                }`}
                aria-pressed={videoQuality === level}
                disabled={blocked}
                // The shared seg-btn style has no :disabled rule and this file's
                // SCSS is out of scope here — grey blocked tiers inline so the
                // admin cap is visibly (not just functionally) enforced.
                style={
                  blocked
                    ? { opacity: 0.4, cursor: "not-allowed" }
                    : undefined
                }
                onClick={() => applyVideoQuality(level)}
              >
                {t(`videoQuality.${level}`)}
              </button>
            );
          })}
        </div>
      </PrefRow>

      {/* Tell the user WHY the high tiers are greyed out (only when the admin
          has actually lowered the cap below "high"). */}
      {videoQualityCap !== "high" && (
        <p className="mcm-settings__note">
          {t("videoQuality.adminCap", {
            level: t(`videoQuality.${videoQualityCap}`),
          })}
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// My Data — read-only lists from /v1/me/* (meetings, invitations, files).
// ---------------------------------------------------------------------------

const MyDataTab = () => {
  const t = useT();
  const [meetings, setMeetings] = useState<CalMeeting[] | null>(null);
  const [invites, setInvites] = useState<MyInvitation[] | null>(null);
  const [files, setFiles] = useState<UserFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // All three are read-only, owner-scoped lists. We tolerate failures
    // independently — a 403 on /files (e.g. for a guest) shouldn't blank the
    // meetings list.
    void getMyMeetingsChecked().then((r) => {
      if (!cancelled) {
        setMeetings(r.ok ? r.items : []);
      }
    });
    void getMyInvitationsChecked().then((r) => {
      if (!cancelled) {
        setInvites(r.ok ? r.items : []);
      }
    });
    void listMyFilesChecked().then((r) => {
      if (!cancelled) {
        setFiles(r.ok ? r.items : []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fmtDate = (iso: string | null | undefined): string =>
    iso ? new Date(iso).toLocaleString() : "—";
  const fmtMs = (ms: number | null | undefined): string =>
    ms ? new Date(ms).toLocaleDateString() : "—";

  return (
    <div className="mcm-settings__section">
      <h3 className="mcm-settings__h3">{t("settings.myMeetings")}</h3>
      {meetings === null ? (
        <p className="mcm-settings__note">{t("settings.loading")}</p>
      ) : meetings.length === 0 ? (
        <p className="mcm-settings__note">{t("settings.noMeetings")}</p>
      ) : (
        <ul className="mcm-settings__list">
          {meetings.map((m) => (
            <li key={m.id} className="mcm-settings__list-row">
              <span className="mcm-settings__list-main">
                {m.title || t("settings.untitled")}
              </span>
              <span className="mcm-settings__list-sub">
                {m.project_name ? `${m.project_name} · ` : ""}
                {fmtDate(m.scheduled_at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mcm-settings__h3">{t("settings.myInvites")}</h3>
      {invites === null ? (
        <p className="mcm-settings__note">{t("settings.loading")}</p>
      ) : invites.length === 0 ? (
        <p className="mcm-settings__note">{t("settings.noInvites")}</p>
      ) : (
        <ul className="mcm-settings__list">
          {invites.map((iv) => (
            <li key={iv.id} className="mcm-settings__list-row">
              <span className="mcm-settings__list-main">
                {iv.title || t("settings.untitled")}
              </span>
              <span className="mcm-settings__list-sub">
                {iv.status ? `${iv.status} · ` : ""}
                {fmtDate(iv.scheduled_at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mcm-settings__h3">{t("settings.myFiles")}</h3>
      {files === null ? (
        <p className="mcm-settings__note">{t("settings.loading")}</p>
      ) : files.length === 0 ? (
        <p className="mcm-settings__note">{t("settings.noFiles")}</p>
      ) : (
        <ul className="mcm-settings__list">
          {files.map((f) => (
            <li key={f.id} className="mcm-settings__list-row">
              <span className="mcm-settings__list-main">{f.name}</span>
              <span className="mcm-settings__list-sub">
                {f.kind.toUpperCase()} · {fmtMs(f.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Privacy — STT mic-consent toggle + a plain-language data note.
// ---------------------------------------------------------------------------

const PrivacyTab = () => {
  const t = useT();
  const [sttEnabled, setSttEnabledAtomLocal] = useAtom(sttEnabledAtom);

  return (
    <div className="mcm-settings__section">
      <h3 className="mcm-settings__h3">{t("settings.micConsent")}</h3>
      <PrefRow
        label={t("settings.micConsentLabel")}
        hint={t("settings.micConsentHint")}
      >
        <Toggle
          checked={sttEnabled}
          label={t("settings.micConsentLabel")}
          onChange={(v) => {
            setSttEnabledAtomLocal(v);
            setSttEnabled(v);
          }}
        />
      </PrefRow>

      <h3 className="mcm-settings__h3">{t("settings.dataNoteTitle")}</h3>
      <p className="mcm-settings__note mcm-settings__note--block">
        {t("settings.dataNoteBody")}
      </p>
    </div>
  );
};

export default UserSettings;
