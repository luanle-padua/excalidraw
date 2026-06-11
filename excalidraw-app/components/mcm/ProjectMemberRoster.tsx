import { UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getDirectory, type DirectoryUser } from "../../data/invite";
import {
  addProjectMembers,
  listProjectMembers,
  removeProjectMember,
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
 *  identity resolved from the staff directory. The owner can add internal
 *  colleagues or remove members; owner rows are fixed. */
export const ProjectMemberRoster = ({
  projectId,
  isOwner,
}: {
  projectId: string;
  isOwner: boolean;
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
            tooltip: m.role === "owner" ? t("proj.owner") : null,
          };
        })}
        onRemove={isOwner ? remove : undefined}
        removeLabel={t("proj.removeMember")}
        emptyLabel={t("proj.noMembers")}
      />

      {isOwner && (
        <button
          type="button"
          className="mcm-btn mcm-roster__add"
          onClick={() => setPicking(true)}
        >
          <UserPlus size={15} /> {t("proj.addMember")}
        </button>
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
