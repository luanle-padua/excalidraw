import { Crown, ShieldCheck, ShieldOff, UserPlus, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { getDirectory, type DirectoryUser } from "../../data/invite";
import {
  addProjectMembers,
  listProjectMembers,
  removeProjectMember,
  setMemberRole,
  setProjectLeader,
  type ProjectMember,
} from "../../data/projects";
import { isInternalEmail } from "../../data/session";
import { resolveAvatarUrlWithDefault } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { ConfirmModal } from "./ConfirmModal";
import { MemberPicker } from "./MemberPicker";

import "./ProjectMemberRoster.scss";

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
};

/** Roster for a project folder: who can see the whole folder. Rendered with
 *  the SAME PeopleGrid badges as the meeting forms (anh's call: "hiển thị
 *  dạng badge như ở thêm cuộc họp") — avatar chips clustered by division,
 *  identity resolved from the staff directory.
 *
 *  `canManage` (admin/owner/manager) gates Add + Remove — a plain participant
 *  sees the roster read-only. `isOwner` additionally gates the per-row
 *  promote/demote (only the project leader delegates managers); the worker
 *  enforces the same on every route. */
export const ProjectMemberRoster = ({
  projectId,
  canManage,
  canLead,
  canAssignLeader = false,
  divisionAdmins = [],
  extraAction,
}: {
  projectId: string;
  /** Admin / leader / co-operator / head — may add + remove members. */
  canManage: boolean;
  /** Leadership (admin / leader / head, NOT a co-operator) — may promote/demote
   *  co-operators. */
  canLead: boolean;
  /** Admin / leading-division head — may assign/replace the project leader. */
  canAssignLeader?: boolean;
  /** Lower-cased email of the project's division HEAD (head-only since 06-16 —
   *  no longer the deputy). The head is the "Division admin" power tier and is
   *  badged as such. This is the org-AUTHORITY axis ONLY — it never locks the
   *  assign-leader / make-co-operator buttons (anh Luân 06-16: chức vụ ≠ role;
   *  anyone, incl. a head or trưởng-phòng, can still be assigned a project role)
   *  and is shown separately from each member's 직급 title chip. */
  divisionAdmins?: string[];
  /** Optional button rendered next to "Add member" (e.g. "Add guest"). */
  extraAction?: ReactNode;
}) => {
  const t = useT();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [picking, setPicking] = useState(false);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  // Themed confirm dialog (replaces window.confirm for leader/remove actions).
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const nameOf = (email: string): string =>
    directory.find((x) => x.email === email)?.name ?? email.split("@")[0];

  const reload = useCallback(() => {
    void listProjectMembers(projectId).then(setMembers);
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Staff directory: resolves chip identity (name/title/division/avatar) and
  // feeds the add-member picker. Internal-only — project members never
  // include external clients by construction.
  useEffect(() => {
    void getDirectory().then((users) =>
      setDirectory(users.filter((u) => isInternalEmail(u.email))),
    );
  }, []);

  const ownerEmails = new Set(
    members.filter((m) => m.role === "owner").map((m) => m.email),
  );

  // The division HEAD (head-only since 06-16) is the supreme "Division admin"
  // power tier on any project of their department. This badges the AUTHORITY
  // axis — it does NOT lock any action button (see `actionable` below) and is
  // distinct from a member's 직급 title chip.
  const isDivAdmin = (email: string): boolean =>
    divisionAdmins.includes(email.toLowerCase());

  // Human label for a member's role badge/tooltip.
  const roleLabel = (email: string, role: string): string =>
    isDivAdmin(email)
      ? t("proj.roleDivisionAdmin")
      : role === "owner"
      ? t("proj.roleOwner")
      : role === "manager"
      ? t("proj.roleManager")
      : t("proj.roleParticipant");

  // Badge tint variant for a member.
  const roleVariant = (email: string, role: string): string =>
    isDivAdmin(email)
      ? "admin"
      : role === "owner"
      ? "leader"
      : role === "manager"
      ? "manager"
      : "participant";

  const remove = (email: string) => {
    // The owner chip keeps its X (PeopleGrid passes one handler to every
    // chip) but removing an owner (the leader) is a no-op — same rule the
    // worker enforces; the chip tooltip says "Trưởng dự án".
    if (ownerEmails.has(email)) {
      return;
    }
    setConfirm({
      title: t("proj.removeMember"),
      message: t("proj.removeMemberConfirm", { email: nameOf(email) }),
      confirmLabel: t("proj.removeMember"),
      danger: true,
      onConfirm: async () => {
        await removeProjectMember(projectId, email);
        reload();
      },
    });
  };

  // Leadership (owner/leader/head): toggle a participant ⇄ delegated manager.
  // The worker refuses to re-role an owner, so the list never offers it for one.
  const changeRole = async (email: string, role: "manager" | "member") => {
    const ok = await setMemberRole(projectId, email, role);
    if (!ok) {
      window.alert(t("proj.roleChangeFailed"));
      return;
    }
    reload();
  };

  // Head-only: hand the project leadership to a member. Separate from the
  // co-operator toggle — only the leading-division head (or admin) may do it.
  // Themed confirm (anh Luân 06-15: proper UI). On success the member becomes
  // "Trưởng dự án" everywhere (the worker syncs their role to owner).
  const makeLeader = (email: string) => {
    setConfirm({
      title: t("proj.makeLeader"),
      message: t("proj.makeLeaderConfirm", { email: nameOf(email) }),
      confirmLabel: t("proj.makeLeader"),
      onConfirm: async () => {
        if (!(await setProjectLeader(projectId, email))) {
          window.alert(t("proj.roleChangeFailed"));
          return;
        }
        reload();
      },
    });
  };

  // The promote/delegate list shows to the project LEADERSHIP (leader/head) —
  // they delegate co-operators; only the head assigns the leader.
  const canDelegate = canLead;

  const confirmAdd = async (emails: string[]) => {
    const existing = new Set(members.map((m) => m.email.toLowerCase()));
    const next = emails.filter((e) => !existing.has(e.toLowerCase()));
    if (next.length === 0) {
      return;
    }
    const ok = await addProjectMembers(projectId, next);
    if (!ok) {
      window.alert(t("proj.memberAddFailed"));
      return;
    }
    reload();
  };

  // ONE list, grouped by division — no more duplicate chip-grid + flat role
  // list (anh Luân 06-16). Each person is a full row: avatar · name · 직급 chip
  // · role badge · actions. Stable order: by division name, ungrouped last.
  const byDivision = new Map<string, ProjectMember[]>();
  for (const m of members) {
    const key =
      directory.find((x) => x.email === m.email)?.division?.trim() || "";
    const arr = byDivision.get(key) ?? [];
    arr.push(m);
    byDivision.set(key, arr);
  }
  const memberGroups = [...byDivision.entries()].sort(([a], [b]) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b),
  );

  return (
    <div className="mcm-roster">
      {members.length === 0 ? (
        <div className="mcm-roster__empty">{t("proj.noMembers")}</div>
      ) : (
        <div className="mcm-roster__groups">
          {memberGroups.map(([division, rows]) => (
            <div key={division || "—"} className="mcm-roster__group">
              <div className="mcm-roster__group-head">
                <h4 className="mcm-roster__group-title">
                  <span>{division || t("people.noGroup")}</span>
                </h4>
                <span className="mcm-roster__group-count">{rows.length}</span>
              </div>
              <ul className="mcm-roster__roles">
                {rows.map((m) => {
                  const u = directory.find((x) => x.email === m.email);
                  const isOwner = m.role === "owner";
                  const isManager = m.role === "manager";
                  // Org title (incl. Division admin) never locks actions — only
                  // the current leader (owner) is fixed (worker refuses to
                  // re-role an owner), so it's badge-only.
                  const actionable = !isOwner;
                  return (
                    <li key={m.email} className="mcm-roster__role-row">
                      <img
                        className="mcm-roster__avatar"
                        src={resolveAvatarUrlWithDefault(
                          u?.avatar ?? null,
                          m.email,
                        )}
                        alt=""
                        loading="lazy"
                      />
                      <span className="mcm-roster__role-name">
                        {u?.name ?? m.email.split("@")[0]}
                      </span>
                      {u?.title && (
                        <span
                          className="mcm-roster__title-chip"
                          title={t("proj.titleChip")}
                        >
                          {u.title}
                        </span>
                      )}
                      <span
                        className={`mcm-roster__badge mcm-roster__badge--${roleVariant(
                          m.email,
                          m.role,
                        )}`}
                      >
                        {roleLabel(m.email, m.role)}
                      </span>
                      {actionable && canAssignLeader && (
                        <button
                          type="button"
                          className="mcm-btn mcm-btn--sm mcm-roster__role-btn"
                          onClick={() => void makeLeader(m.email)}
                        >
                          <Crown size={13} /> {t("proj.makeLeader")}
                        </button>
                      )}
                      {actionable && canDelegate && (
                        <button
                          type="button"
                          className="mcm-btn mcm-btn--sm mcm-roster__role-btn"
                          onClick={() =>
                            void changeRole(
                              m.email,
                              isManager ? "member" : "manager",
                            )
                          }
                        >
                          {isManager ? (
                            <>
                              <ShieldOff size={13} /> {t("proj.removeManager")}
                            </>
                          ) : (
                            <>
                              <ShieldCheck size={13} /> {t("proj.makeManager")}
                            </>
                          )}
                        </button>
                      )}
                      {canManage && actionable && (
                        <button
                          type="button"
                          className="mcm-roster__role-remove"
                          onClick={() => remove(m.email)}
                          title={t("proj.removeMember")}
                          aria-label={t("proj.removeMember")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {(canManage || extraAction) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canManage && (
            <button
              type="button"
              className="mcm-btn mcm-roster__add"
              onClick={() => setPicking(true)}
            >
              <UserPlus size={15} /> {t("proj.addMember")}
            </button>
          )}
          {extraAction}
        </div>
      )}

      {picking && (
        <MemberPicker
          directory={directory}
          selectedEmails={new Set(members.map((m) => m.email))}
          onConfirm={confirmAdd}
          onClose={() => setPicking(false)}
        />
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
};

export default ProjectMemberRoster;
