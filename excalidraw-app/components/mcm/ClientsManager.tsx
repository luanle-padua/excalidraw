import { Briefcase, Mail, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  createClient,
  deleteClient,
  listClients,
  type Client,
} from "../../data/clients";
import { useT } from "../../i18n/mcm";

import "./ClientsManager.scss";

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString() : "—";

/** Full CRUD on the shared client list (DB-synced). Lists every `client` row,
 *  adds new ones (name + company + email + note), and deletes. Used as the
 *  Admin → Clients tab so admins monitor + manage the whole list in one place. */
export const ClientsManager = () => {
  const t = useT();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setClients(await listClients());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    if (!name.trim() || busy) {
      return;
    }
    setBusy(true);
    const created = await createClient({
      name: name.trim(),
      company: company.trim() || undefined,
      email: email.trim() || undefined,
    });
    setBusy(false);
    if (created) {
      setName("");
      setCompany("");
      setEmail("");
      void refresh();
    }
  };

  const remove = async (cli: Client) => {
    if (!window.confirm(t("clients.confirmDelete"))) {
      return;
    }
    setBusy(true);
    await deleteClient(cli.id);
    setBusy(false);
    void refresh();
  };

  return (
    <div className="mcm-tablecard mcm-clients">
      <div className="mcm-clients__form">
        <Briefcase size={16} />
        <input
          placeholder={t("clients.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <input
          placeholder={t("clients.company")}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <input
          type="email"
          placeholder={t("clients.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button
          type="button"
          className="mcm-btn mcm-btn--primary mcm-btn--sm"
          onClick={() => void add()}
          disabled={busy || !name.trim()}
        >
          <UserPlus size={15} /> {t("clients.add")}
        </button>
      </div>

      <div className="mcm-clients__toolbar">
        <span className="mcm-clients__count">
          {t("clients.count", { count: clients.length })}
        </span>
      </div>

      <table className="mcm-table">
        <thead>
          <tr>
            <th>{t("clients.colContact")}</th>
            <th>{t("clients.colCompany")}</th>
            <th>{t("clients.colAddedBy")}</th>
            <th>{t("clients.colAdded")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr className="mcm-table__norow">
              <td colSpan={5} className="mcm-table__empty">
                …
              </td>
            </tr>
          )}
          {!loading && clients.length === 0 && (
            <tr className="mcm-table__norow">
              <td colSpan={5} className="mcm-table__empty">
                {t("clients.empty")}
              </td>
            </tr>
          )}
          {!loading &&
            clients.map((cli) => (
              <tr key={cli.id}>
                <td>
                  <strong>{cli.name}</strong>
                  <span className="mcm-table__sub">
                    <Mail size={11} style={{ verticalAlign: "-1px" }} />{" "}
                    {cli.email || t("clients.noEmail")}
                  </span>
                </td>
                <td>{cli.company || "—"}</td>
                <td className="mcm-table__sub">{cli.created_by || "—"}</td>
                <td className="mcm-table__sub">{fmtDate(cli.created_at)}</td>
                <td className="mcm-table__actions">
                  <button
                    type="button"
                    className="mcm-icon-btn mcm-icon-btn--sm mcm-icon-btn--danger"
                    title={t("clients.confirmDelete")}
                    aria-label={t("clients.confirmDelete")}
                    onClick={() => void remove(cli)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
};

export default ClientsManager;
