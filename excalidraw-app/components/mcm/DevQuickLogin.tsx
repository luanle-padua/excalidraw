import { Crown, ShieldCheck } from "lucide-react";

import { DEMO_USERS } from "../../data/demoUsers";
import { useT } from "../../i18n/mcm";

// DEV-ONLY — the sole importer is LoginScreen via a `lazy()` that is guarded
// by `import.meta.env.DEV` (statically replaced by Vite), so this chunk and
// the demo passwords it pulls in never reach production builds.

// Internal-team demo accounts (the 5 seeded R&D users) share this initial
// password, so clicking a quick-login button signs in with one click.
const DEMO_PASSWORD = "MapMeet@2026";

/**
 * One-click quick-login grid for the seeded demo accounts, grouped by
 * division. Dev builds only — see the guard note above.
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
      {/* Grouped by DIVISION (a compact 2-col grid per group) so the
          cross-department test accounts read as separate teams. */}
      {[...new Set(DEMO_USERS.map((u) => u.division))].map((div) => (
        <div key={div} className="mcm-login__demo-group">
          <span className="mcm-login__demo-group-label">{div}</span>
          <ul className="mcm-login__demo-list">
            {DEMO_USERS.filter((u) => u.division === div).map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  className="mcm-login__demo-user"
                  onClick={() => onPick(u.email, u.password ?? DEMO_PASSWORD)}
                  title={`${u.title} · ${u.email}`}
                  disabled={disabled}
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
                      {u.isAdmin && (
                        <span className="mcm-login__demo-host">
                          <ShieldCheck size={11} /> Admin
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
      ))}
    </div>
  );
};

export default DevQuickLogin;
