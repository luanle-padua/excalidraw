import { ShieldCheck } from "lucide-react";

import { DEMO_USERS } from "../../data/demoUsers";
import { useT } from "../../i18n/mcm";

// DEV-ONLY — the sole importer is LoginScreen via a `lazy()` that is guarded
// by `import.meta.env.DEV` (statically replaced by Vite), so this chunk and
// the demo passwords it pulls in never reach production builds.

// Internal-team demo accounts share this initial password, so clicking a
// quick-login button signs in with one click. Admin has its own (per-account
// `password` override in DEMO_USERS).
const DEMO_PASSWORD = "MapMeet@2026";

/**
 * One-click quick-login for the seeded demo accounts. Compact flat grid (all
 * accounts in a tight multi-column grid, one line each) so the login card
 * stays short — division / title / email ride the tooltip instead of taking
 * vertical space. Dev builds only — see the guard note above.
 */
export const DevQuickLogin = ({
  onPick,
  disabled,
}: {
  onPick: (email: string, password: string) => void;
  disabled: boolean;
}) => {
  const t = useT();

  return (
    <div className="mcm-login__demo">
      <span className="mcm-login__demo-title">{t("login.demoTitle")}</span>
      <ul className="mcm-login__demo-list">
        {DEMO_USERS.map((u) => (
          <li key={u.email}>
            <button
              type="button"
              className="mcm-login__demo-user"
              onClick={() => onPick(u.email, u.password ?? DEMO_PASSWORD)}
              title={`${u.name} · ${u.title} · ${u.division} · ${u.email}`}
              disabled={disabled}
            >
              <span
                className={`mcm-login__demo-avatar${
                  u.isAdmin ? " mcm-login__demo-avatar--admin" : ""
                }`}
              >
                {u.name.charAt(0)}
              </span>
              <span className="mcm-login__demo-name">{u.name}</span>
              {u.isAdmin && (
                <span
                  className="mcm-login__demo-badge mcm-login__demo-badge--admin"
                  title="Admin"
                  aria-label="Admin"
                >
                  <ShieldCheck size={11} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default DevQuickLogin;
