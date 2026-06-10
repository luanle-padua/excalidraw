import { X } from "lucide-react";

import { resolveAvatarUrlWithDefault } from "../../data/userProfile";
import { useT } from "../../i18n/mcm";

import { personColor } from "./meetingColors";

/** One person as the meeting surfaces know them — resolved from the staff
 *  directory (internal) or the shared client list (guest). */
export type GridPerson = {
  email: string;
  name: string;
  /** Chức vụ (internal) / role line. */
  title?: string | null;
  /** Internal: division. Guest: company. Drives grouping + badge colour. */
  group?: string | null;
  kind: "internal" | "guest";
  /** "lib:NN.png" account avatar; falls back to the deterministic gallery. */
  avatar?: string | null;
  /** Revoked invitee — stays visible (audit) but struck + dimmed. */
  revoked?: boolean;
  /** Extra tooltip line (e.g. joined time for participants). */
  tooltip?: string | null;
};

/** Compact identity chip: real avatar + name (+ quiet chức vụ). The cluster
 *  colour comes from the GROUP (division/company), so a chip never has to
 *  spend text on it — full identity sits in the hover tooltip. */
export const PersonChip = ({
  person,
  onRemove,
  removeLabel,
}: {
  person: GridPerson;
  onRemove?: (email: string) => void;
  removeLabel?: string;
}) => (
  <span
    className={`mcm-pchip${person.revoked ? " mcm-pchip--revoked" : ""}`}
    style={{
      ["--pa" as string]: personColor(person.group || person.email),
    }}
    title={[person.email, person.group, person.tooltip]
      .filter(Boolean)
      .join(" · ")}
  >
    <img
      className="mcm-pchip__ava"
      src={resolveAvatarUrlWithDefault(person.avatar, person.email)}
      alt=""
      loading="lazy"
    />
    <span className="mcm-pchip__name">{person.name}</span>
    {person.title && <span className="mcm-pchip__title">{person.title}</span>}
    {onRemove && (
      <button
        type="button"
        className="mcm-pchip__remove"
        onClick={() => onRemove(person.email)}
        title={removeLabel}
        aria-label={removeLabel}
      >
        <X size={11} />
      </button>
    )}
  </span>
);

/** STRATEGIC people layout (anh's call: "tách internal member và client ra
 *  để dễ phân biệt"): internal staff and external clients are separate
 *  blocks, and inside each block people CLUSTER by division/company — one
 *  quiet colour-dotted label per cluster, then wrapping chips. Far denser
 *  than one-row-per-person, and team membership reads as colour + label
 *  instead of repeated text. */
export const PeopleGrid = ({
  people,
  onRemove,
  removeLabel,
  emptyLabel,
}: {
  people: GridPerson[];
  onRemove?: (email: string) => void;
  removeLabel?: string;
  emptyLabel?: string;
}) => {
  const t = useT();
  if (people.length === 0) {
    return emptyLabel ? (
      <div className="mcm-pgrid mcm-pgrid--empty">{emptyLabel}</div>
    ) : null;
  }

  const renderClusters = (list: GridPerson[]) => {
    // Stable cluster order: by group label, "ungrouped" last.
    const clusters = new Map<string, GridPerson[]>();
    for (const p of list) {
      const key = p.group?.trim() || "";
      const arr = clusters.get(key) ?? [];
      arr.push(p);
      clusters.set(key, arr);
    }
    return [...clusters.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([group, members]) => (
        <div key={group || "—"} className="mcm-pgrid__cluster">
          <span
            className="mcm-pgrid__cluster-label"
            style={{
              ["--pa" as string]: personColor(group || members[0]?.email),
            }}
          >
            <span className="mcm-pgrid__cluster-dot" aria-hidden="true" />
            {group || t("people.noGroup")}
            <span className="mcm-pgrid__cluster-n">{members.length}</span>
          </span>
          <span className="mcm-pgrid__chips">
            {members.map((p) => (
              <PersonChip
                key={p.email}
                person={p}
                onRemove={onRemove}
                removeLabel={removeLabel}
              />
            ))}
          </span>
        </div>
      ));
  };

  const internal = people.filter((p) => p.kind === "internal");
  const guests = people.filter((p) => p.kind === "guest");

  return (
    <div className="mcm-pgrid">
      {internal.length > 0 && (
        <div className="mcm-pgrid__block">
          <span className="mcm-pgrid__block-label">
            {t("people.internalCount", { count: internal.length })}
          </span>
          {renderClusters(internal)}
        </div>
      )}
      {guests.length > 0 && (
        <div className="mcm-pgrid__block mcm-pgrid__block--guest">
          <span className="mcm-pgrid__block-label">
            {t("people.guestCount", { count: guests.length })}
          </span>
          {renderClusters(guests)}
        </div>
      )}
    </div>
  );
};

export default PeopleGrid;
