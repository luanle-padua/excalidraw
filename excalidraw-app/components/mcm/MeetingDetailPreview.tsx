import { ArrowLeft, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { getMeeting } from "../../data/projects";
import { useT } from "../../i18n/mcm";

type Detail = Awaited<ReturnType<typeof getMeeting>>;

const fmtIso = (s: string | null | undefined) => {
  if (!s) {
    return "—";
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};
const fmtMs = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString() : "—";

/** Meeting metadata at a glance — rendered INLINE inside the project-browser
 *  right column (replaces the meeting grid), not a floating drawer. A back
 *  button returns to the grid. */
export const MeetingDetailPreview = ({
  roomId,
  onClose,
  onEdit,
}: {
  roomId: string;
  onClose: () => void;
  onEdit?: () => void;
}) => {
  const t = useT();
  const [d, setD] = useState<Detail>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getMeeting(roomId).then((m) => {
      if (alive) {
        setD(m);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [roomId]);

  const Row = ({ label, value }: { label: string; value?: string | null }) =>
    value ? (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;

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
        {onEdit && (
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
        {!loading && !d && <p className="mcm-admin__note">{t("admin.empty")}</p>}
        {!loading && d && (
          <>
            {d.status && <span className="mcm-mdp__status">{d.status}</span>}

            <h4 className="mcm-admin__h4">{t("admin.secProject")}</h4>
            <dl className="mcm-mdp__dl">
              <Row label={t("admin.colProject")} value={d.project_name} />
              <Row label={t("admin.colHost")} value={d.created_by} />
            </dl>

            <h4 className="mcm-admin__h4">{t("admin.secMeta")}</h4>
            <dl className="mcm-mdp__dl">
              <Row label={t("admin.mTopic")} value={d.topic} />
              <Row label={t("admin.mDescription")} value={d.description} />
              <Row label={t("admin.mType")} value={d.type} />
              <Row label={t("admin.mDiscipline")} value={d.discipline} />
              <Row label={t("admin.mPriority")} value={d.priority} />
              <Row
                label={t("admin.mConfidentiality")}
                value={d.confidentiality}
              />
              <Row label={t("admin.mScheduled")} value={fmtIso(d.scheduled_at)} />
              <Row label={t("admin.colCreated")} value={fmtMs(d.created_at)} />
            </dl>
          </>
        )}
      </div>
    </div>
  );
};

export default MeetingDetailPreview;
