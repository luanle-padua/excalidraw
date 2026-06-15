import { ShieldCheck, ShieldOff, UserPlus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { getDirectory, type DirectoryUser } from "../../data/invite";
import {
  addProjectMembers,
  listProjectMembers,
  removeProjectMember,
  setMemberRole,
  type ProjectMember,
} from "../../data/projects";
import { isInternalEmail } from "../../data/session";
import { useT } from "../../i18n/mcm";

import { MemberPicker } from "./MemberPicker";
import { PeopleGrid } from "./PeopleGrid";

import "./ProjectMemberRoster.scss";

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
  isOwner,
  extraAction,
}: {
  projectId: string;
  /** Admin / owner / manager — may add + remove members. */
  canManage: boolean;
  /** Owner (leader) / admin — may promote/demote delegated managers. */
  isOwner: boolean;
  /** Optional button rendered next to "Add member" (e.g. "Add guest"). */
  extraAction?: ReactNode;
}) => {
  const t = useT();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [picking, setPicking] = useState(false);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);

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

  // Human label for a member's role badge/tooltip.
  const roleLabel = (role: string): string =>
    role === "owner"
      ? t("proj.roleOwner")
      : role === "manager"
      ? t("proj.roleManager")
      : t("proj.roleParticipant");

  const remove = async (email: string) => {
    // The owner chip keeps its X (PeopleGrid passes one handler to every
    // chip) but removing an owner is a no-op — same rule the worker
    // enforces; the chip tooltip says "Chủ dự án".
    if (ownerEmails.has(email)) {
      return;
    }
    if (!window.confirm(t("proj.removeMemberConfirm", { email }))) {
      return;
    }
    await removeProjectMember(projectId, email);
    reload();
  };

  // Owner-only: toggle a participant ⇄ delegated manager. The worker refuses
  // to re-role an owner, so the management list below never offers it for one.
  const changeRole = async (email: string, role: "manager" | "member") => {
    const ok = await setMemberRole(projectId, email, role);
    if (!ok) {
      window.alert(t("proj.roleChangeFailed"));
      return;
    }
    reload();
  };

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

  // Only non-owner members can be promoted/demoted; surfaced to the owner as a
  // compact action list under the grid (the grid itself stays identity-only).
  const manageable = members.filter((m) => m.role !== "owner");

  return (
    <div className="mcm-roster">
      <PeopleGrid
        people={members.map((m) => {
          const u = directory.find((x) => x.email === m.email);
          return {
            email: m.email,
            name: u?.name ?? m.email.split("@")[0],
            title: u?.title ?? null,
            group: u?.division ?? null,
            kind: "internal" as const,
            avatar: u?.avatar ?? null,
            // Badge/tooltip reflects the management tier (Leader/Manager/
            // Participant), not just ownership.
            tooltip: roleLabel(m.role),
          };
        })}
        onRemove={canManage ? remove : undefined}
        removeLabel={t("proj.removeMember")}
        emptyLabel={t("proj.noMembers")}
      />

      {/* Owner-only delegation list: per-row badge + make/remove manager. */}
      {isOwner && manageable.length > 0 && (
        <ul className="mcm-roster__roles">
          {manageable.map((m) => {
            const u = directory.find((x) => x.email === m.email);
            const isManager = m.role === "manager";
            return (
              <li key={m.email} className="mcm-roster__role-row">
                <span className="mcm-roster__role-name">
                  {u?.name ?? m.email.split("@")[0]}
                </span>
                <span
                  className={`mcm-roster__badge mcm-roster__badge--${
                    isManager ? "manager" : "participant"
                  }`}
                >
                  {roleLabel(m.role)}
                </span>
                <button
                  type="button"
                  className="mcm-btn mcm-btn--sm mcm-roster__role-btn"
                  onClick={() =>
                    void changeRole(m.email, isManager ? "member" : "manager")
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
              </li>
            );
          })}
        </ul>
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
    </div>
  );
};

export default ProjectMemberRoster;
