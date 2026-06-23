import {
  ArrowLeft,
  CalendarClock,
  CircleSlash,
  EyeOff,
  FolderOpen,
  Package,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { listClients, type Client } from "../../data/clients";
import {
  getDirectory,
  listInvitees,
  listParticipants,
  type DirectoryUser,
  type MeetingInvitee,
  type MeetingParticipant,
} from "../../data/invite";
import {
  deletePackage,
  listMeetingPackages,
  listPackageRecipients,
  restoreRecipient,
  revokeRecipient,
  unpublishPackage,
  type MeetingPackageListItem,
  type PackageRecipient,
} from "../../data/packages";
import { deleteMeeting, getMeeting, updateMeeting } from "../../data/projects";
import { isInternalEmail, sessionAtom } from "../../data/session";
import { preferredLanguageAtom } from "../../data/translation";
import { useT } from "../../i18n/mcm";

import { ConfirmModal } from "./ConfirmModal";
import { MeetingPackageBuilder } from "./MeetingPackageBuilder";
import { MeetingPackageViewer } from "./MeetingPackageViewer";
import { statusBucket } from "./meetingColors";
import {
  canManageMeeting,
  isEditableMeetingStatus,
  meetingStatusLabel,
  normalizeMeetingStatus,
} from "./meetingStatus";
import { PeopleGrid, PersonChip, type GridPerson } from "./PeopleGrid";

type Detail = Awaited<ReturnType<typeof getMeeting>>;

const fmtMs = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString() : "—";

// 30-minute slots for the reschedule time dropdown (mirrors the schedule form).
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 ? 30 : 0;
  const value = `${String(h).padStart(2, "0")}:${m ? "30" : "00"}`;
  const label = new Date(2000, 0, 1, h, m).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return { value, label };
});

/** Meeting metadata at a glance — rendered INLINE inside the project-browser
 *  right column (replaces the meeting grid), not a floating drawer. A back
 *  button returns to the grid.
 *
 *  Phase 4.5: the ORGANIZER additionally gets the scheduling lifecycle
 *  controls here — reschedule (new date/time/duration) and cancel — while the
 *  meeting is still `scheduled`. Soft-gated client-side (the worker PATCH is
 *  not organizer-checked yet — dev-phase-notes.md). */
export const MeetingDetailPreview = ({
  roomId,
  onClose,
  onEdit,
  onChanged,
}: {
  roomId: string;
  onClose: () => void;
  onEdit?: () => void;
  /** Fired after a lifecycle change (reschedule/cancel) so the parent can
   *  refresh its cards + calendar. */
  onChanged?: () => void;
}) => {
  const t = useT();
  // Viewer's preferred language doubles as the date-formatting locale so the
  // hero's "Thứ Tư, 10 tháng 6…" line agrees with the calendar surface.
  const lang = useAtomValue(preferredLanguageAtom);
  const session = useAtomValue(sessionAtom);
  const [d, setD] = useState<Detail>(null);
  const [loading, setLoading] = useState(true);
  const [invitees, setInvitees] = useState<MeetingInvitee[]>([]);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [dir, setDir] = useState<DirectoryUser[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [rescheduling, setRescheduling] = useState(false);
  const [dateStr, setDateStr] = useState("");
  const [timeStr, setTimeStr] = useState("09:00");
  const [duration, setDuration] = useState("60");
  const [busy, setBusy] = useState(false);
  // AI recap clamp/expand — collapsed by default so a long recap doesn't
  // push the people sections below the fold.
  const [aiExpanded, setAiExpanded] = useState(false);
  // Meeting Package builder modal (curate a post-meeting deliverable).
  const [showPackage, setShowPackage] = useState(false);
  // Published packages the viewer can see for this meeting (recipient surface)
  // + the one currently opened in the viewer modal.
  const [packages, setPackages] = useState<MeetingPackageListItem[]>([]);
  const [viewPkgId, setViewPkgId] = useState<string | null>(null);
  // Package MANAGEMENT (curator): a pending confirm (unshare/delete) + the
  // package whose recipient panel is expanded.
  const [pkgConfirm, setPkgConfirm] = useState<{
    kind: "unshare" | "delete";
    pkg: MeetingPackageListItem;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setAiExpanded(false);
    // Reset the reschedule scratch state so a meeting WITHOUT a schedule
    // doesn't inherit the previous meeting's date when switching cards.
    setDateStr("");
    setTimeStr("09:00");
    setDuration("60");
    setRescheduling(false);
    const [m, iv, pp, directory, clientList, pkgs] = await Promise.all([
      getMeeting(roomId),
      listInvitees(roomId),
      listParticipants(roomId),
      getDirectory(),
      listClients(),
      listMeetingPackages(roomId),
    ]);
    setD(m);
    setInvitees(iv);
    setParticipants(pp);
    setDir(directory);
    setClients(clientList);
    setPackages(pkgs);
    setLoading(false);
    if (m?.scheduled_at) {
      const dt = new Date(m.scheduled_at);
      if (!Number.isNaN(dt.getTime())) {
        const pad = (n: number) => String(n).padStart(2, "0");
        setDateStr(
          `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
        );
        setTimeStr(
          `${pad(dt.getHours())}:${dt.getMinutes() >= 30 ? "30" : "00"}`,
        );
      }
    }
    if (m?.duration_min) {
      setDuration(String(m.duration_min));
    }
  }, [roomId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) {
        await refresh();
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const status = normalizeMeetingStatus(d?.status);
  // Organizer OR project authority (leader / head / deputy — server-computed
  // viewer_is_authority) manages the meeting; legacy rows without organizer_email
  // fall back to internal-allow. The worker enforces the same rule.
  const canManage = canManageMeeting(
    session?.email,
    d?.organizer_email ?? null,
    isInternalEmail(session?.email),
    !!d?.viewer_is_authority,
  );
  const showLifecycle = !!d && canManage && status === "scheduled";
  // Edit only for the organizer, and only while the meeting takes edits
  // (scheduled/live — finished is immutable, cancelled needs restore first).
  const showEdit =
    !!onEdit && !!d && canManage && isEditableMeetingStatus(d.status);
  // A mis-cancelled meeting isn't stuck forever: the organizer can restore it
  // to `scheduled` (the one transition the server allows out of cancelled).
  const showRestore = !!d && canManage && status === "cancelled";
  // Meeting Package: curate a shareable recap from a FINISHED meeting. Host /
  // project authority only (canManage), and only once the meeting is done.
  const showPackageBtn = !!d && canManage && status === "finished";
  // Recipient surface: published packages this viewer can see for a FINISHED
  // meeting. The server already audience-gated the list; we only filter to
  // published (an editor's list may also carry their own drafts).
  const sharedPackages =
    status === "finished"
      ? packages.filter((p) => p.status === "published")
      : [];
  // Curator management list: every package of this finished meeting (drafts +
  // published) the editor can manage. The server already returns drafts only to
  // the edit set, so when canManage is false this is naturally empty.
  const managePackages =
    canManage && status === "finished" ? packages : [];

  // Run the confirmed unshare/delete, then refresh the list.
  const runPkgConfirm = async () => {
    if (!pkgConfirm) {
      return;
    }
    const { kind, pkg } = pkgConfirm;
    const ok =
      kind === "unshare"
        ? await unpublishPackage(pkg.id)
        : await deletePackage(pkg.id);
    if (!ok) {
      window.alert(t("pkg.manageFailed"));
    }
    await refresh();
  };

  const saveReschedule = async () => {
    if (!dateStr || busy) {
      return;
    }
    setBusy(true);
    try {
      const ok = await updateMeeting(roomId, {
        scheduled_at: new Date(
          `${dateStr}T${timeStr || "09:00"}`,
        ).toISOString(),
        duration_min: duration ? parseInt(duration, 10) : undefined,
      });
      if (!ok) {
        window.alert(t("folder.saveFailed"));
        return;
      }
      setRescheduling(false);
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const cancelMeeting = async () => {
    if (busy || !window.confirm(t("folder.cancelConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      const ok = await updateMeeting(roomId, { status: "cancelled" });
      if (!ok) {
        window.alert(t("folder.saveFailed"));
      }
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const restoreMeeting = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ok = await updateMeeting(roomId, { status: "scheduled" });
      if (!ok) {
        window.alert(t("folder.saveFailed"));
      }
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  // Permanent disposal — only offered on a CANCELLED meeting (the worker
  // enforces the same rule + cascades blobs and every related row).
  const removeMeeting = async () => {
    if (busy || !window.confirm(t("folder.deleteConfirm"))) {
      return;
    }
    setBusy(true);
    try {
      const ok = await deleteMeeting(roomId);
      if (!ok) {
        window.alert(t("folder.saveFailed"));
        return;
      }
      onChanged?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ label, value }: { label: string; value?: string | null }) =>
    value ? (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;

  // Resolve an email to its richest known identity (a GridPerson): staff
  // directory first (name + chức vụ + division + account avatar), then the
  // shared client list (name + company), else the bare address.
  const personOf = (email: string): GridPerson => {
    const e = email.toLowerCase();
    const u = dir.find((x) => x.email === e);
    if (u) {
      return {
        email: e,
        name: u.name,
        title: u.title ?? null,
        group: u.division ?? null,
        kind: "internal",
        avatar: u.avatar ?? null,
      };
    }
    const cl = clients.find((x) => x.email?.toLowerCase() === e);
    if (cl) {
      return {
        email: e,
        name: cl.name,
        title: null,
        group: cl.company,
        kind: "guest",
      };
    }
    return {
      email: e,
      name: e.split("@")[0] || e,
      title: null,
      group: null,
      kind: isInternalEmail(e) ? "internal" : "guest",
    };
  };

  const activeInvitees = invitees.filter((iv) => iv.status !== "revoked");
  const organizerEmail = d?.organizer_email ?? null;

  // ----- Hero schedule line ------------------------------------------------
  // The KEY facts, human-readable: "Thứ Tư, 10 tháng 6, 2026" on top and
  // "14:00 – 15:00 · 60 phút" beneath (end time derived from the duration).
  // null = no parseable schedule → the hero shows a quiet "not scheduled".
  const when = (() => {
    if (!d?.scheduled_at) {
      return null;
    }
    const start = new Date(d.scheduled_at);
    if (Number.isNaN(start.getTime())) {
      // Legacy free-text dates: show them verbatim rather than dropping them.
      return { dateLine: d.scheduled_at, timeLine: null as string | null };
    }
    const fmtT = (x: Date) =>
      x.toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
    let timeLine = fmtT(start);
    if (d.duration_min) {
      const end = new Date(start.getTime() + d.duration_min * 60_000);
      timeLine = `${timeLine} – ${fmtT(end)} · ${d.duration_min} ${t(
        "folder.minutesShort",
      )}`;
    }
    return {
      dateLine: start.toLocaleDateString(lang, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
      timeLine,
    };
  })();

  return (
    <div className="mcm-folder__rpanel">
      <header className="mcm-folder__rpanel-head">
        <button
          type="button"
          className="mcm-folder__rpanel-back"
          onClick={onClose}
          aria-label={t("header.leave")}
        >
          <ArrowLeft size={16} />
        </button>
        <strong>{d?.title || t("admin.tabMeetings")}</strong>
        {showEdit && (
          <button
            type="button"
            className="mcm-folder__rpanel-act"
            onClick={onEdit}
            title={t("folder.editMeeting")}
            aria-label={t("folder.editMeeting")}
          >
            <Pencil size={15} />
          </button>
        )}
      </header>

      <div className="mcm-folder__rpanel-body">
        {loading && <p className="mcm-admin__note">{t("admin.loading")}</p>}
        {!loading && !d && (
          <p className="mcm-admin__note">{t("admin.empty")}</p>
        )}
        {!loading && d && (
          <div className="mcm-mdp">
            {/* ZONE 1 — HERO. The at-a-glance block (Apple Calendar event
                sheet): schedule as the headline fact + status pill, project
                beneath, organizer lifecycle actions attached. This is the
                panel's ONE accent moment — everything below stays quiet. */}
            <section className="mcm-mdp__hero">
              <div className="mcm-mdp__hero-row">
                <span className="mcm-mdp__hero-ico" aria-hidden="true">
                  <CalendarClock size={19} />
                </span>
                <div className="mcm-mdp__hero-when">
                  <strong
                    className={`mcm-mdp__hero-date${
                      when ? "" : " mcm-mdp__hero-date--none"
                    }`}
                  >
                    {when ? when.dateLine : t("folder.noSchedule")}
                  </strong>
                  {when?.timeLine && (
                    <span className="mcm-mdp__hero-time">{when.timeLine}</span>
                  )}
                </div>
                {d.status && (
                  <span
                    className={`mcm-pill mcm-pill--${statusBucket(
                      d.status,
                    )} mcm-mdp__hero-pill`}
                  >
                    {meetingStatusLabel(t, d.status)}
                  </span>
                )}
              </div>

              {d.project_name && (
                <div className="mcm-mdp__hero-proj">
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>
                    {d.project_name}
                    {d.project_stage ? ` · ${d.project_stage}` : ""}
                  </span>
                </div>
              )}

              {showLifecycle && (
                <div className="mcm-mdp__actions">
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                    onClick={() => setRescheduling((v) => !v)}
                    disabled={busy}
                  >
                    <CalendarClock size={14} /> {t("folder.reschedule")}
                  </button>
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--sm mcm-btn--danger"
                    onClick={() => void cancelMeeting()}
                    disabled={busy}
                  >
                    <CircleSlash size={14} /> {t("folder.cancelMeeting")}
                  </button>
                </div>
              )}

              {showRestore && (
                <div className="mcm-mdp__actions">
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                    onClick={() => void restoreMeeting()}
                    disabled={busy}
                  >
                    <RotateCcw size={14} /> {t("folder.restoreMeeting")}
                  </button>
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--sm mcm-btn--danger"
                    onClick={() => void removeMeeting()}
                    disabled={busy}
                  >
                    <Trash2 size={14} /> {t("folder.deleteMeeting")}
                  </button>
                </div>
              )}

              {showPackageBtn && (
                <div className="mcm-mdp__actions">
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--secondary mcm-btn--sm"
                    onClick={() => setShowPackage(true)}
                  >
                    <Package size={14} /> {t("pkg.create")}
                  </button>
                </div>
              )}

              {showLifecycle && rescheduling && (
                <div className="mcm-sched__row mcm-mdp__resched">
                  <label>
                    <span className="mcm-invite__label">
                      {t("folder.dateTime")}
                    </span>
                    <input
                      type="date"
                      value={dateStr}
                      onChange={(e) => setDateStr(e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="mcm-invite__label">&nbsp;</span>
                    <select
                      className="mcm-sched__time"
                      aria-label={t("folder.dateTime")}
                      value={timeStr}
                      onChange={(e) => setTimeStr(e.target.value)}
                    >
                      {TIME_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="mcm-invite__label">
                      {t("folder.durationMin")}
                    </span>
                    <input
                      type="number"
                      min={5}
                      step={5}
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="mcm-btn mcm-btn--primary mcm-btn--sm"
                    onClick={() => void saveReschedule()}
                    disabled={busy || !dateStr}
                  >
                    {t("folder.rescheduleSave")}
                  </button>
                </div>
              )}
            </section>

            {/* ZONE 1.5 — AI SUMMARY. The auto-recap written at End-for-all
                (quyết định 06-10 #4 — summary-first). Muted card, clamped to
                a few lines with an expand toggle; absent until the meeting
                finished with content to recap. */}
            {d.ai_summary && (
              <section className="mcm-mdp__zone mcm-mdp__ai">
                <h4 className="mcm-mdp__sec mcm-mdp__ai-head">
                  <Sparkles size={13} aria-hidden="true" />
                  {t("ai.summaryTitle")}
                  {d.ai_summary_at ? (
                    <span className="mcm-mdp__ai-at">
                      {fmtMs(d.ai_summary_at)}
                    </span>
                  ) : null}
                </h4>
                <div className="mcm-mdp__ai-card">
                  <p
                    className={`mcm-mdp__ai-text${
                      aiExpanded ? " mcm-mdp__ai-text--open" : ""
                    }`}
                  >
                    {d.ai_summary}
                  </p>
                  {(d.ai_summary.length > 220 ||
                    d.ai_summary.split("\n").length > 4) && (
                    <button
                      type="button"
                      className="mcm-mdp__ai-more"
                      onClick={() => setAiExpanded((v) => !v)}
                    >
                      {aiExpanded ? t("ai.showLess") : t("ai.showMore")}
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* ZONE 1.6 — SHARED RECAP / PACKAGE. The recipient entry point:
                once the host publishes a Package from this finished meeting,
                the audience discovers it here and opens the viewer (recap +
                download). Only published packages the viewer passes the
                server's audience gate for appear. */}
            {/* Curator management list (editors only): every package of this
                finished meeting with per-package manage actions — Unshare (if
                published), Delete (soft), and Manage recipients (list audience).
                Non-editors fall through to the read-only "Shared recap" list
                below. */}
            {managePackages.length > 0 && (
              <section className="mcm-mdp__zone">
                <h4 className="mcm-mdp__sec">
                  <Package size={13} aria-hidden="true" /> {t("pkg.sharedTitle")}
                  <span className="mcm-mdp__sec-n">
                    {managePackages.length}
                  </span>
                </h4>
                <ul className="mcm-mdp__pkgs">
                  {managePackages.map((p) => (
                    <PackageManageRow
                      key={p.id}
                      pkg={p}
                      t={t}
                      onOpen={() => setViewPkgId(p.id)}
                      onUnshare={() =>
                        setPkgConfirm({ kind: "unshare", pkg: p })
                      }
                      onDelete={() => setPkgConfirm({ kind: "delete", pkg: p })}
                    />
                  ))}
                </ul>
              </section>
            )}

            {!canManage && sharedPackages.length > 0 && (
              <section className="mcm-mdp__zone">
                <h4 className="mcm-mdp__sec">
                  <Package size={13} aria-hidden="true" /> {t("pkg.sharedTitle")}
                  <span className="mcm-mdp__sec-n">{sharedPackages.length}</span>
                </h4>
                <ul className="mcm-mdp__pkgs">
                  {sharedPackages.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="mcm-mdp__pkg"
                        onClick={() => setViewPkgId(p.id)}
                      >
                        <span className="mcm-mdp__pkg-ico" aria-hidden="true">
                          <Package size={16} />
                        </span>
                        <span className="mcm-mdp__pkg-text">
                          <span className="mcm-mdp__pkg-title">
                            {p.title || t("pkg.viewerTitle")}
                          </span>
                          <span className="mcm-mdp__pkg-meta">
                            {p.file_count
                              ? t("pkg.selectedCount", { count: p.file_count })
                              : t("pkg.noFiles")}
                            {p.published_at ? ` · ${fmtMs(p.published_at)}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ZONE 2 — PROPERTIES. Quiet Notion-style label/value grid;
                Row hides empty values so the grid never shows blanks.
                (Schedule, duration and project live in the hero now.) */}
            <section className="mcm-mdp__zone">
              <h4 className="mcm-mdp__sec">{t("admin.secMeta")}</h4>
              <dl className="mcm-mdp__props">
                <Row label={t("admin.mTopic")} value={d.topic} />
                <Row label={t("admin.mDescription")} value={d.description} />
                <Row label={t("admin.mType")} value={d.type} />
                <Row label={t("admin.mDiscipline")} value={d.discipline} />
                <Row label={t("admin.mPriority")} value={d.priority} />
                <Row
                  label={t("admin.mConfidentiality")}
                  value={d.confidentiality}
                />
                <Row
                  label={t("admin.colCreated")}
                  value={fmtMs(d.created_at)}
                />
              </dl>
            </section>

            {/* ZONE 3 — PEOPLE. Organizer chip → who was asked (internal vs
                clients in separate blocks, clustered by division/company;
                revoked stay visible struck as the audit trail) → who actually
                joined (join time in the tooltip). */}
            <section className="mcm-mdp__zone">
              <h4 className="mcm-mdp__sec">{t("folder.organizer")}</h4>
              <div className="mcm-pgrid__chips mcm-mdp__organizer">
                {organizerEmail ? (
                  <PersonChip person={personOf(organizerEmail)} />
                ) : (
                  <PersonChip
                    person={{
                      email: d.created_by ?? "",
                      name: d.created_by || t("participants.guest"),
                      kind: "internal",
                    }}
                  />
                )}
              </div>

              <h4 className="mcm-mdp__sec">
                {t("folder.invited")}
                <span className="mcm-mdp__sec-n">{activeInvitees.length}</span>
              </h4>
              <PeopleGrid
                people={invitees.map((iv) => ({
                  ...personOf(iv.email),
                  // The invite row's own kind wins (it's the access grant).
                  kind: iv.kind === "internal" ? "internal" : "guest",
                  revoked: iv.status === "revoked",
                  tooltip:
                    iv.role === "cohost"
                      ? t("invite.cohost")
                      : iv.status === "revoked"
                      ? t("invite.revoked")
                      : null,
                }))}
                emptyLabel={t("invite.empty")}
              />

              <h4 className="mcm-mdp__sec">
                {t("admin.secParticipants")}
                <span className="mcm-mdp__sec-n">{participants.length}</span>
              </h4>
              <PeopleGrid
                people={participants.map((pp) => {
                  const p = personOf(pp.user_email);
                  return {
                    ...p,
                    name: pp.name || p.name,
                    tooltip: `${t("admin.pJoined")} ${fmtMs(pp.joined_at)}`,
                  };
                })}
                emptyLabel={t("admin.noParticipants")}
              />
            </section>
          </div>
        )}
      </div>

      {showPackage && d && (
        <MeetingPackageBuilder
          roomId={roomId}
          roomKey={d.room_key}
          meetingTitle={d.title || ""}
          initialSummary={d.ai_summary}
          isConfidential={
            (d.confidentiality ?? "").toLowerCase() === "confidential"
          }
          onClose={() => {
            setShowPackage(false);
            // A just-published package should surface immediately.
            void refresh();
          }}
        />
      )}

      {viewPkgId && (
        <MeetingPackageViewer
          pkgId={viewPkgId}
          onClose={() => setViewPkgId(null)}
        />
      )}

      {pkgConfirm && (
        <ConfirmModal
          title={t(
            pkgConfirm.kind === "unshare"
              ? "pkg.unshareConfirmTitle"
              : "pkg.deleteConfirmTitle",
          )}
          message={t(
            pkgConfirm.kind === "unshare"
              ? "pkg.unshareConfirmMsg"
              : "pkg.deleteConfirmMsg",
          )}
          confirmLabel={t(
            pkgConfirm.kind === "unshare" ? "pkg.unshare" : "pkg.delete",
          )}
          danger={pkgConfirm.kind === "delete"}
          onConfirm={runPkgConfirm}
          onClose={() => setPkgConfirm(null)}
        />
      )}
    </div>
  );
};

// Per-package management row (curator view of a finished meeting's packages).
// Shows the title + status, an Open affordance (reuses the viewer), and the
// editor actions: Unshare (if published), Delete (soft), and an expandable
// Manage-recipients panel for audience_kind='list'. Recipients are loaded
// lazily on first expand; revoke/restore flip status in place ("revoke !=
// delete" — a revoked row stays visible as the audit trail).
const PackageManageRow = ({
  pkg,
  t,
  onOpen,
  onUnshare,
  onDelete,
}: {
  pkg: MeetingPackageListItem;
  t: ReturnType<typeof useT>;
  onOpen: () => void;
  onUnshare: () => void;
  onDelete: () => void;
}) => {
  const [showRecipients, setShowRecipients] = useState(false);
  const [recipients, setRecipients] = useState<PackageRecipient[] | null>(null);
  const [busy, setBusy] = useState(false);
  const isPublished = pkg.status === "published";
  const hasList = pkg.audience_kind === "list";

  const loadRecipients = useCallback(async () => {
    setRecipients(await listPackageRecipients(pkg.id));
  }, [pkg.id]);

  const toggleRecipients = async () => {
    const next = !showRecipients;
    setShowRecipients(next);
    if (next && recipients === null) {
      await loadRecipients();
    }
  };

  const flipRecipient = async (email: string, revoke: boolean) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ok = revoke
        ? await revokeRecipient(pkg.id, email)
        : await restoreRecipient(pkg.id, email);
      if (!ok) {
        window.alert(t("pkg.manageFailed"));
        return;
      }
      await loadRecipients();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="mcm-mdp__pkg-row">
      <div className="mcm-mdp__pkg-main">
        <button
          type="button"
          className="mcm-mdp__pkg"
          onClick={onOpen}
        >
          <span className="mcm-mdp__pkg-ico" aria-hidden="true">
            <Package size={16} />
          </span>
          <span className="mcm-mdp__pkg-text">
            <span className="mcm-mdp__pkg-title">
              {pkg.title || t("pkg.viewerTitle")}
              {!isPublished && (
                <span className="mcm-pill mcm-pill--neutral mcm-mdp__pkg-badge">
                  {t("pkg.statusDraftBadge")}
                </span>
              )}
            </span>
            <span className="mcm-mdp__pkg-meta">
              {pkg.file_count
                ? t("pkg.selectedCount", { count: pkg.file_count })
                : t("pkg.noFiles")}
              {pkg.published_at ? ` · ${fmtMs(pkg.published_at)}` : ""}
            </span>
          </span>
        </button>
      </div>
      <div className="mcm-mdp__pkg-acts">
        {hasList && (
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary mcm-btn--sm"
            onClick={() => void toggleRecipients()}
          >
            <Users size={14} /> {t("pkg.manageRecipients")}
          </button>
        )}
        {isPublished && (
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary mcm-btn--sm"
            onClick={onUnshare}
          >
            <EyeOff size={14} /> {t("pkg.unshare")}
          </button>
        )}
        <button
          type="button"
          className="mcm-btn mcm-btn--sm mcm-btn--danger"
          onClick={onDelete}
        >
          <Trash2 size={14} /> {t("pkg.delete")}
        </button>
      </div>

      {hasList && showRecipients && (
        <div className="mcm-mdp__pkg-recips">
          {recipients === null ? (
            <p className="mcm-admin__note">{t("admin.loading")}</p>
          ) : recipients.length === 0 ? (
            <p className="mcm-admin__note">{t("pkg.recipientsManageEmpty")}</p>
          ) : (
            <ul>
              {recipients.map((r) => {
                const revoked = r.status === "revoked";
                return (
                  <li key={r.email} className="mcm-mdp__pkg-recip">
                    <span
                      className={
                        revoked ? "mcm-mdp__pkg-recip-email--revoked" : ""
                      }
                    >
                      {r.email}
                      {revoked && (
                        <span className="mcm-pill mcm-pill--neutral mcm-mdp__pkg-badge">
                          {t("pkg.revoked")}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className={`mcm-btn mcm-btn--sm ${
                        revoked ? "mcm-btn--secondary" : "mcm-btn--danger"
                      }`}
                      disabled={busy}
                      onClick={() => void flipRecipient(r.email, !revoked)}
                    >
                      {revoked ? t("pkg.restore") : t("pkg.revoke")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
};

export default MeetingDetailPreview;
