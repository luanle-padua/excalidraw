// Meeting Package builder.
//
// Opened from the meeting detail view (a FINISHED meeting, by host / a project
// authority). Lets the curator: edit a summary (seeded from the meeting's AI
// recap), tick which meeting files to include, pick an audience, then either
// save a draft, publish, or export an offline zip.
//
// Packaging (publish/export) runs client-side because we hold the room key:
// each chosen file is fetched + decrypted, then re-uploaded as PLAINTEXT into
// the package's server-readable R2 prefix. The raw meeting is left untouched.

import {
  FileText,
  Image as ImageIcon,
  Package,
  Box,
  X,
  Plus,
  Search,
  Briefcase,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getDirectory, type DirectoryUser } from "../../data/invite";
import {
  createPackage,
  decryptMeetingChat,
  decryptMeetingFile,
  defaultPackageName,
  exportMeetingBoardPng,
  exportPackageZip,
  listMeetingFiles,
  newAttachmentId,
  publishPackage,
  uploadPackageAttachment,
  uploadPackageBoard,
  uploadPackageFile,
  uploadPackageRecap,
  type MeetingFileRow,
  type PackageAudience,
  type RecapChatMessage,
} from "../../data/packages";
import { listProjectGuests, type ProjectGuest } from "../../data/projectGuests";
import { getMeeting } from "../../data/projects";
import { useT, type McmKey } from "../../i18n/mcm";

// A picked recipient for the audience='list' member picker. `kind` only drives
// the chip styling; the worker just needs the email, so internal members,
// project guests, and free-typed externals all collapse to the same recipient
// string on save.
type PickedRecipient = {
  email: string;
  name: string;
  kind: "internal" | "guest" | "external";
};

// Loose email shape check for the raw external-email fallback input.
const looksLikeEmail = (s: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Reasonable byte size formatter for the file rows.
const fmtSize = (n: number | null | undefined): string => {
  if (!n) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// Small per-kind glyph for the file picker rows. Mirrors MeetingLibrary's
// type buckets but keyed off the D1 `kind` column (the picker only has the
// index row, not the in-memory canvas file).
const KindIcon = ({ kind }: { kind: string | null }) => {
  if (kind === "image") {
    return <ImageIcon size={15} aria-hidden="true" />;
  }
  if (kind === "ifc" || kind === "glb") {
    return <Box size={15} aria-hidden="true" />;
  }
  return <FileText size={15} aria-hidden="true" />;
};

// HTML-escape for the recap render.
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Render the recap.html stored alongside the package. Self-contained (inline
// styles, inline data-URL board image) so it opens standalone — online in the
// no-network sandboxed viewer iframe, or straight from the offline zip.
//
// Order: the board IMAGE (what the meeting visually WAS) → the editable
// summary → the chat conversation → the file list. All user text is escaped.
const renderRecapHtml = (args: {
  title: string;
  summary: string;
  files: MeetingFileRow[];
  meetingId: string;
  /** Board PNG as a data URL (omitted on export/decrypt failure). */
  boardDataUrl: string | null;
  chat: RecapChatMessage[];
  /** Localised section headings, resolved once at build time. */
  labels: {
    board: string;
    summary: string;
    chat: string;
    files: string;
    meeting: string;
  };
}): string => {
  const fileLis = args.files
    .map(
      (f) => `<li>${esc(f.name || f.id)} <span>${fmtSize(f.size)}</span></li>`,
    )
    .join("\n");
  const boardSection = args.boardDataUrl
    ? `<section class="board"><h2>${esc(args.labels.board)}</h2>
  <img alt="${esc(args.labels.board)}" src="${args.boardDataUrl}" /></section>`
    : "";
  // Chat is rendered as a compact, scrollable "notepad" log (one line per
  // message) — NOT one bordered bubble per message — so a long conversation
  // (hundreds/thousands of lines) stays a tidy, bounded block instead of an
  // endless wall of cards.
  const chatSection = args.chat.length
    ? `<section><h2>${esc(args.labels.chat)} <span class="count">(${
        args.chat.length
      })</span></h2>
  <div class="chatlog">${args.chat
    .map(
      (m) =>
        `<div class="cl"><b>${esc(m.username || "—")}:</b> ${esc(m.text)}</div>`,
    )
    .join("")}</div></section>`
    : "";
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(args.title)}</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; color: #1d1d1f;
    max-width: 820px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 12px; }
  .board img { width: 100%; height: auto; border: 1px solid #e5e5ea;
    border-radius: 12px; background: #121212; display: block; }
  .summary { white-space: pre-wrap; margin: 24px 0; }
  h2 .count { color: #8e8e93; font-weight: 400; font-size: 14px; }
  .chatlog { border: 1px solid #e5e5ea; border-radius: 10px; background: #f7f7fa;
    padding: 10px 14px; max-height: 420px; overflow-y: auto;
    font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .chatlog .cl { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
  .chatlog .cl b { color: #1d1d1f; font-weight: 600; }
  ul { list-style: none; padding: 0; }
  li { padding: 8px 12px; border: 1px solid #e5e5ea; border-radius: 10px;
    margin-bottom: 6px; display: flex; justify-content: space-between; }
  li span { color: #8e8e93; font-size: 13px; }
  footer { margin-top: 40px; color: #8e8e93; font-size: 13px; }
</style>
</head>
<body>
  <h1>${esc(args.title)}</h1>
  ${boardSection}
  ${
    args.summary
      ? `<h2>${esc(args.labels.summary)}</h2><div class="summary">${esc(
          args.summary,
        )}</div>`
      : ""
  }
  ${chatSection}
  ${
    args.files.length
      ? `<h2>${esc(args.labels.files)}</h2><ul>${fileLis}</ul>`
      : ""
  }
  <footer>${esc(args.labels.meeting)}: ${esc(args.meetingId)}</footer>
</body>
</html>`;
};

// A package-OWNED attachment the curator adds from their computer (e.g. a biên
// bản PDF) — separate from the meeting's own files. Held in component state
// with a stable `attach-…` id and the raw File; the bytes are only uploaded on
// save (publish/export), so removing one before save leaves NO orphan
// rows/blobs server-side.
type Attachment = { id: string; file: File };

const downloadBlob = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const MeetingPackageBuilder = ({
  roomId,
  roomKey,
  meetingTitle,
  initialSummary,
  isConfidential,
  onClose,
}: {
  roomId: string;
  /** Room key for decrypting the chosen files client-side. May be null if the
   *  caller wasn't handed it (then file packaging is skipped, summary-only). */
  roomKey: string | null;
  meetingTitle: string;
  initialSummary: string | null;
  isConfidential: boolean;
  onClose: () => void;
}) => {
  const t = useT();
  const [title, setTitle] = useState("");
  // Whether the curator has hand-edited the title — once they have, we stop
  // overwriting it with the (async-resolved) default name.
  const titleTouched = useRef(false);
  const [summary, setSummary] = useState(initialSummary ?? "");
  const [audience, setAudience] = useState<PackageAudience>("meeting");
  // audience='list' recipients are now PICKED (members / project guests / a
  // free-typed external email) into chips; their emails feed `createPackage`.
  const [picked, setPicked] = useState<Map<string, PickedRecipient>>(new Map());
  // Internal staff directory + this project's issued guests for the picker —
  // the SAME data sources the Invite flow uses (getDirectory / listProjectGuests).
  const [dir, setDir] = useState<DirectoryUser[]>([]);
  const [guests, setGuests] = useState<ProjectGuest[]>([]);
  const [peopleQ, setPeopleQ] = useState("");
  // Free-typed external email fallback (the picker only covers internal staff +
  // issued project guests).
  const [extraEmail, setExtraEmail] = useState("");
  const [files, setFiles] = useState<MeetingFileRow[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Extra local files the curator attaches on top of the meeting's own files.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listMeetingFiles(roomId);
      if (!alive) {
        return;
      }
      setFiles(list);
      // Default: pre-select everything (the curator unticks what they don't
      // want — most packages share the bulk of the materials).
      setSelected(new Set(list.map((f) => f.id)));
      setFilesLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Resolve a GOOD default title from the meeting's context (project + title +
  // date), using getMeeting — the same read-only source the rest of the meeting
  // surfaces use. We don't get project/date as props (the builder is opened with
  // just the title), so we fetch them here and also pre-fill from `meetingTitle`
  // synchronously so the field is never empty while the fetch is in flight.
  // The default is only applied while the curator hasn't edited the title.
  useEffect(() => {
    let alive = true;
    // Seed immediately with what we already have (title + today), so the field
    // shows a sensible default before the project/date resolve.
    if (!titleTouched.current) {
      setTitle(
        defaultPackageName({
          meetingTitle,
          recapWord: t("pkg.recapWord"),
          meetingDate: null,
        }),
      );
    }
    void (async () => {
      const m = await getMeeting(roomId);
      if (!alive || titleTouched.current) {
        return;
      }
      setTitle(
        defaultPackageName({
          projectName: m?.project_name ?? null,
          meetingTitle: m?.title || meetingTitle,
          recapWord: t("pkg.recapWord"),
          // Prefer the meeting's scheduled date; fall back to when it was
          // created; defaultPackageName falls back to today if both are absent.
          meetingDate: m?.scheduled_at ?? m?.created_at ?? null,
        }),
      );
    })();
    return () => {
      alive = false;
    };
    // meetingTitle is stable for the lifetime of the modal; t is stable per
    // language. roomId identifies the meeting to fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Load the picker's people sources once (internal directory + this project's
  // issued guests) — reusing the Invite flow's data fns, not a new endpoint.
  useEffect(() => {
    let alive = true;
    void getDirectory().then((users) => {
      if (alive) {
        setDir(users);
      }
    });
    void (async () => {
      const m = await getMeeting(roomId);
      if (alive && m?.project_id) {
        setGuests(await listProjectGuests(m.project_id));
      }
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  // A confidential meeting can never target the whole project.
  const projectBlocked = isConfidential;
  useEffect(() => {
    if (projectBlocked && audience === "project") {
      setAudience("meeting");
    }
  }, [projectBlocked, audience]);

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected],
  );

  // The recipient emails flowing into createPackage/updatePackage — exactly the
  // same data contract as before (a string[] of emails), now SOURCED from the
  // picked chips instead of a raw textarea. De-duped + lower-cased.
  const parsedRecipients = useMemo(
    () => [...new Set([...picked.values()].map((p) => p.email))],
    [picked],
  );

  // Add / remove a picked recipient (keyed by lower-cased email).
  const addPicked = (p: PickedRecipient) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.set(p.email, p);
      return next;
    });
  const removePicked = (email: string) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(email);
      return next;
    });

  // Friendly guest display name (representative + company), mirroring InvitePanel.
  const guestName = (g: ProjectGuest) =>
    g.company ? `${g.label ?? g.login} · ${g.company}` : g.label ?? g.login;

  // Internal staff matching the search and not already picked.
  const dirMatches = useMemo(() => {
    const needle = peopleQ.trim().toLowerCase();
    return dir
      .filter((u) => !picked.has(u.email.toLowerCase()))
      .filter(
        (u) =>
          !needle ||
          u.name.toLowerCase().includes(needle) ||
          u.email.toLowerCase().includes(needle) ||
          (u.division ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [dir, peopleQ, picked]);

  // Active project guests matching the search and not already picked. Guests are
  // addressed by their synthetic `login` identity (same as the invite flow).
  const guestMatches = useMemo(() => {
    const needle = peopleQ.trim().toLowerCase();
    return guests
      .filter(
        (g) => g.status === "active" && !picked.has(g.login.toLowerCase()),
      )
      .filter(
        (g) =>
          !needle ||
          (g.label ?? "").toLowerCase().includes(needle) ||
          (g.company ?? "").toLowerCase().includes(needle) ||
          (g.real_email ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [guests, peopleQ, picked]);

  // Add the free-typed external email (fallback for addresses the picker can't
  // cover). No-op on a malformed / already-picked address.
  const addExtraEmail = () => {
    const email = extraEmail.trim().toLowerCase();
    if (!looksLikeEmail(email) || picked.has(email)) {
      return;
    }
    addPicked({ email, name: email, kind: "external" });
    setExtraEmail("");
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Pick local files to attach. Appended (not replaced) so repeated picks
  // accumulate; the same File can be picked twice (distinct ids) — harmless.
  const onAddFiles = (picked: FileList | null) => {
    if (!picked || !picked.length) {
      return;
    }
    const next: Attachment[] = [];
    for (const file of Array.from(picked)) {
      next.push({ id: newAttachmentId(), file });
    }
    setAttachments((prev) => [...prev, ...next]);
    // Reset the input so re-picking the SAME file fires onChange again.
    if (attachInputRef.current) {
      attachInputRef.current.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Create-or-reuse a draft, upload the chosen (decrypted) files + recap, and
  // return the package id. Shared by Publish and Export. Returns null on a
  // hard failure (caller surfaces the error).
  const buildPackage = async (): Promise<string | null> => {
    const fileIds = selectedFiles.map((f) => f.id);
    const pkgId = await createPackage(roomId, {
      title: title.trim(),
      summary_text: summary,
      audience_kind: audience,
      file_ids: fileIds,
      recipients: audience === "list" ? parsedRecipients : undefined,
    });
    if (!pkgId) {
      return null;
    }
    // Decrypt + upload each chosen file as a plaintext package copy.
    if (roomKey) {
      setPhase(t("pkg.packaging"));
      for (const f of selectedFiles) {
        const dec = await decryptMeetingFile(roomId, roomKey, f.id);
        if (dec) {
          await uploadPackageFile(
            pkgId,
            f.id,
            // ArrayBuffer copy of the decrypted bytes.
            dec.bytes.buffer.slice(
              dec.bytes.byteOffset,
              dec.bytes.byteOffset + dec.bytes.byteLength,
            ) as ArrayBuffer,
            dec.mimeType,
          );
        }
      }
    }

    // Upload the curator's extra local attachments as package-owned plaintext
    // files. Each gets its stable `attach-…` id; the server creates the backing
    // `file` row + meeting_package_file link, so they flow into the recap list,
    // export zip, and viewer automatically (same JOIN as meeting files). Only
    // uploaded HERE (on save), so an attachment removed before save never
    // touches the server.
    if (attachments.length) {
      setPhase(t("pkg.attachUploading"));
      for (const a of attachments) {
        await uploadPackageAttachment(
          pkgId,
          a.id,
          await a.file.arrayBuffer(),
          a.file.type || "application/octet-stream",
          a.file.name,
        );
      }
    }

    // Capture what the meeting visually WAS: export the decrypted board to a
    // PNG, and pull the chat conversation. Both are fail-soft — a failure here
    // just omits that recap section, never blocks publishing/exporting.
    setPhase(t("pkg.renderingBoard"));
    const board = await exportMeetingBoardPng(roomId, roomKey);
    if (board) {
      // Also store the board as a standalone package asset (offline zip).
      await uploadPackageBoard(pkgId, board.bytes);
    }
    const chat = await decryptMeetingChat(roomId, roomKey);

    // Recap file list = chosen meeting files + the curator's added attachments
    // (shaped as MeetingFileRow so they render identically in the list).
    const recapFiles: MeetingFileRow[] = [
      ...selectedFiles,
      ...attachments.map((a) => ({
        id: a.id,
        kind: "doc",
        name: a.file.name,
        size: a.file.size,
      })),
    ];

    const label = (key: McmKey): string => t(key);
    await uploadPackageRecap(
      pkgId,
      renderRecapHtml({
        title: title.trim() || meetingTitle,
        summary,
        files: recapFiles,
        meetingId: roomId,
        boardDataUrl: board?.dataUrl ?? null,
        chat,
        labels: {
          board: label("pkg.recapBoard"),
          summary: label("pkg.recapSummary"),
          chat: label("pkg.recapChat"),
          files: label("pkg.recapFiles"),
          meeting: label("pkg.recapMeeting"),
        },
      }),
    );
    return pkgId;
  };

  const onSaveDraft = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await createPackage(roomId, {
        title: title.trim(),
        summary_text: summary,
        audience_kind: audience,
        file_ids: selectedFiles.map((f) => f.id),
        recipients: audience === "list" ? parsedRecipients : undefined,
      });
      if (!pkgId) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      window.alert(t("pkg.draftSaved"));
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const onPublish = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await buildPackage();
      if (!pkgId || !(await publishPackage(pkgId))) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      window.alert(t("pkg.published"));
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const onExport = async () => {
    if (!title.trim()) {
      window.alert(t("pkg.needTitle"));
      return;
    }
    setBusy(true);
    try {
      const pkgId = await buildPackage();
      if (!pkgId) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      const blob = await exportPackageZip(pkgId);
      if (!blob) {
        window.alert(t("pkg.saveFailed"));
        return;
      }
      downloadBlob(`${title.trim() || "package"}.zip`, blob);
      onClose();
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  const AUDIENCES: { value: PackageAudience; label: string; hint: string }[] = [
    {
      value: "meeting",
      label: t("pkg.audienceMeeting"),
      hint: t("pkg.audienceMeetingHint"),
    },
    {
      value: "project",
      label: t("pkg.audienceProject"),
      hint: t("pkg.audienceProjectHint"),
    },
    {
      value: "list",
      label: t("pkg.audienceList"),
      hint: t("pkg.audienceListHint"),
    },
  ];

  // Portal to <body>: the meeting detail view lives inside the Glass Desk
  // dashboard, whose backdrop-filter/transform ancestors trap `position:
  // fixed` — without the portal the backdrop renders BEHIND the calendar
  // instead of over the whole viewport.
  return createPortal(
    <div
      className="mcm-log-modal-backdrop mcm-pkg-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("pkg.builderTitle")}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="mcm-log-modal mcm-pkg-modal">
        <div className="mcm-log-modal__header">
          <div className="mcm-log-modal__head-text">
            <h2 className="mcm-log-modal__title">
              <Package size={18} aria-hidden="true" /> {t("pkg.builderTitle")}
            </h2>
            <span className="mcm-log-modal__meta">
              {t("pkg.builderSubtitle")}
            </span>
          </div>
        </div>

        <div className="mcm-pkg-modal__body">
          <label className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.titleLabel")}</span>
            <input
              type="text"
              value={title}
              placeholder={t("pkg.titlePlaceholder")}
              onChange={(e) => {
                titleTouched.current = true;
                setTitle(e.target.value);
              }}
              disabled={busy}
            />
          </label>

          <label className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.summaryLabel")}</span>
            <textarea
              className="mcm-pkg-summary"
              rows={6}
              value={summary}
              placeholder={t("pkg.summaryPlaceholder")}
              onChange={(e) => setSummary(e.target.value)}
              disabled={busy}
            />
          </label>

          <div className="mcm-pkg-field">
            <span className="mcm-invite__label">
              {t("pkg.filesLabel")}
              {" · "}
              {t("pkg.selectedCount", { count: selected.size })}
            </span>
            {filesLoading ? (
              <p className="mcm-pkg-empty">{t("pkg.filesLoading")}</p>
            ) : files.length === 0 ? (
              <p className="mcm-pkg-empty">{t("pkg.filesEmpty")}</p>
            ) : (
              <ul className="mcm-pkg-files">
                {files.map((f) => (
                  <li key={f.id} className="mcm-pkg-file">
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(f.id)}
                        onChange={() => toggle(f.id)}
                        disabled={busy}
                      />
                      <KindIcon kind={f.kind} />
                      <span className="mcm-pkg-file__name">
                        {f.name || f.id}
                      </span>
                      <span className="mcm-pkg-file__size">
                        {fmtSize(f.size)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.attachLabel")}</span>
            <span className="mcm-pkg-attach__hint">{t("pkg.attachHint")}</span>
            <input
              ref={attachInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => onAddFiles(e.target.files)}
              disabled={busy}
            />
            <button
              type="button"
              className="mcm-btn mcm-btn--secondary mcm-pkg-attach__add"
              onClick={() => attachInputRef.current?.click()}
              disabled={busy}
            >
              <Plus size={15} aria-hidden="true" /> {t("pkg.attachAdd")}
            </button>
            {attachments.length > 0 && (
              <ul className="mcm-pkg-files mcm-pkg-attach__list">
                {attachments.map((a) => (
                  <li key={a.id} className="mcm-pkg-file mcm-pkg-attach__item">
                    <FileText size={15} aria-hidden="true" />
                    <span className="mcm-pkg-file__name">{a.file.name}</span>
                    <span className="mcm-pkg-file__size">
                      {fmtSize(a.file.size)}
                    </span>
                    <button
                      type="button"
                      className="mcm-pkg-attach__remove"
                      aria-label={t("pkg.attachRemove")}
                      title={t("pkg.attachRemove")}
                      onClick={() => removeAttachment(a.id)}
                      disabled={busy}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mcm-pkg-field">
            <span className="mcm-invite__label">{t("pkg.audienceLabel")}</span>
            <div className="mcm-pkg-audience">
              {AUDIENCES.map((a) => {
                const disabled =
                  busy || (a.value === "project" && projectBlocked);
                return (
                  <label
                    key={a.value}
                    className={`mcm-pkg-aud${
                      audience === a.value ? " mcm-pkg-aud--on" : ""
                    }${disabled ? " mcm-pkg-aud--disabled" : ""}`}
                  >
                    <input
                      type="radio"
                      name="pkg-audience"
                      checked={audience === a.value}
                      onChange={() => setAudience(a.value)}
                      disabled={disabled}
                    />
                    <span className="mcm-pkg-aud__label">{a.label}</span>
                    <span className="mcm-pkg-aud__hint">{a.hint}</span>
                  </label>
                );
              })}
            </div>
            {projectBlocked && (
              <p className="mcm-pkg-warn">{t("pkg.confidentialBlocked")}</p>
            )}
          </div>

          {audience === "list" && (
            <div className="mcm-pkg-field mcm-pkg-recips">
              <span className="mcm-invite__label">
                {t("pkg.recipientsLabel")}
                {picked.size > 0 ? ` · ${picked.size}` : ""}
              </span>

              {/* Selected recipients as removable chips. */}
              {picked.size > 0 && (
                <div className="mcm-invite__chips mcm-pkg-recips__chips">
                  {[...picked.values()].map((p) => (
                    <span
                      key={p.email}
                      className={`mcm-invite__chip${
                        p.kind === "guest" ? " --guest" : ""
                      }`}
                    >
                      {p.name}
                      <button
                        type="button"
                        onClick={() => removePicked(p.email)}
                        aria-label={t("pkg.recipientRemove")}
                        disabled={busy}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* One search box drives both the internal-member and project-guest
                  result lists (reusing the Invite flow's data sources). */}
              <div className="mcm-invite__search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={peopleQ}
                  onChange={(e) => setPeopleQ(e.target.value)}
                  placeholder={t("pkg.recipientSearch")}
                  disabled={busy}
                />
              </div>

              <span className="mcm-invite__label">
                {t("pkg.recipientInternal")}
              </span>
              <ul className="mcm-invite__list mcm-pkg-recips__list">
                {dirMatches.map((u) => (
                  <li key={u.email}>
                    <button
                      type="button"
                      onClick={() =>
                        addPicked({
                          email: u.email.toLowerCase(),
                          name: u.name,
                          kind: "internal",
                        })
                      }
                      disabled={busy}
                    >
                      <strong>{u.name}</strong>
                      <span>
                        {[u.title, u.division].filter(Boolean).join(" · ") ||
                          u.email}
                      </span>
                    </button>
                  </li>
                ))}
                {dirMatches.length === 0 && (
                  <li className="mcm-invite__empty">{t("invite.empty")}</li>
                )}
              </ul>

              {guests.length > 0 && (
                <>
                  <span className="mcm-invite__label">
                    <Briefcase size={13} style={{ verticalAlign: "-2px" }} />{" "}
                    {t("pkg.recipientGuests")}
                  </span>
                  <ul className="mcm-invite__list mcm-pkg-recips__list">
                    {guestMatches.map((g) => (
                      <li key={g.id}>
                        <button
                          type="button"
                          onClick={() =>
                            addPicked({
                              email: g.login.toLowerCase(),
                              name: guestName(g),
                              kind: "guest",
                            })
                          }
                          disabled={busy}
                        >
                          <strong>{g.label ?? g.login}</strong>
                          <span>
                            {[g.company, g.real_email]
                              .filter(Boolean)
                              .join(" · ") || g.login}
                          </span>
                        </button>
                      </li>
                    ))}
                    {guestMatches.length === 0 && (
                      <li className="mcm-invite__empty">
                        {t("projGuest.pickEmpty")}
                      </li>
                    )}
                  </ul>
                </>
              )}

              {/* Fallback: type a raw external email the picker can't cover. */}
              <span className="mcm-invite__label">
                {t("pkg.recipientExternal")}
              </span>
              <div className="mcm-pkg-recips__extra">
                <input
                  type="email"
                  value={extraEmail}
                  placeholder={t("pkg.recipientsPlaceholder")}
                  onChange={(e) => setExtraEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addExtraEmail();
                    }
                  }}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="mcm-btn mcm-btn--secondary"
                  onClick={addExtraEmail}
                  disabled={busy || !looksLikeEmail(extraEmail.trim())}
                >
                  <Plus size={15} aria-hidden="true" /> {t("pkg.recipientAdd")}
                </button>
              </div>
            </div>
          )}

          {phase && <p className="mcm-pkg-phase">{phase}</p>}
        </div>

        <div className="mcm-log-modal__footer mcm-pkg-modal__footer">
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {t("pkg.cancel")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={() => void onSaveDraft()}
            disabled={busy}
          >
            {t("pkg.saveDraft")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--secondary"
            onClick={() => void onExport()}
            disabled={busy}
          >
            {t("pkg.exportZip")}
          </button>
          <button
            type="button"
            className="mcm-btn mcm-btn--primary"
            onClick={() => void onPublish()}
            disabled={busy}
          >
            {t("pkg.publish")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
