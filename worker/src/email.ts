// MAP CanvasMeet — outbound email via Resend (https://resend.com).
//
// Dependency-free: we POST straight to the Resend REST API with `fetch`,
// no npm SDK. The caller passes `c.env` (so the sender is per-request, not a
// module-global) and we never throw — every failure comes back as
// `{ ok: false, error }` so a route can decide what to do.
//
// Config (see docs/specs/email-resend.md):
//   RESEND_API_KEY — SECRET, `wrangler secret put RESEND_API_KEY`
//   RESEND_FROM    — var in wrangler.jsonc, e.g. "Canvas M <onboarding@resend.dev>"

const RESEND_API = "https://api.resend.com/emails";

/** Just the bindings `sendEmail` needs — pass `c.env` (it's a superset). */
export type EmailEnv = {
  RESEND_API_KEY: string;
  RESEND_FROM: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type SendEmailResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

/**
 * Send a single transactional email through Resend.
 * Returns `{ ok: true, id }` on a 2xx, else `{ ok: false, error }`. Never throws.
 */
export async function sendEmail(
  env: EmailEnv,
  msg: EmailMessage,
): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY is not set" };
  }
  if (!env.RESEND_FROM) {
    return { ok: false, error: "RESEND_FROM is not set" };
  }

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });

    let payload: { id?: string; message?: string; name?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // Non-JSON body (rare); fall through to status-based error below.
    }

    if (res.ok) {
      return { ok: true, id: payload.id };
    }
    return {
      ok: false,
      error: payload.message ?? payload.name ?? `Resend HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

/** Escape user-supplied strings before interpolating into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type GuestInviteOpts = {
  meetingTitle?: string;
  link: string;
  /** If given (with `password`), shown as the login email in the credentials block. */
  email?: string;
  /** If given, the email also shows login credentials (email + this password). */
  password?: string;
  appName?: string;
};

/**
 * Compose a guest meeting-invite email (subject + html + text).
 * Plain inline-styled HTML, no external assets. Vietnamese primary copy.
 */
export function guestInviteEmail(opts: GuestInviteOpts): {
  subject: string;
  html: string;
  text: string;
} {
  const app = opts.appName ?? "MAP CanvasMeet";
  const title = opts.meetingTitle?.trim() || "cuộc họp";
  const link = opts.link;

  const subject = opts.meetingTitle
    ? `[${app}] Lời mời: ${opts.meetingTitle}`
    : `[${app}] Lời mời tham gia cuộc họp`;

  const loginEmail = opts.email?.trim() || "(email bạn nhận thư này)";

  const credBlockHtml = opts.password
    ? `
      <p style="margin:24px 0 8px;font-size:14px;color:#374151;">
        Thông tin đăng nhập của bạn:
      </p>
      <table style="border-collapse:collapse;font-size:14px;color:#111827;">
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Email</td>
          <td style="padding:4px 0;"><strong>${esc(loginEmail)}</strong></td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Mật khẩu</td>
          <td style="padding:4px 0;"><strong>${esc(opts.password)}</strong></td>
        </tr>
      </table>
      <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">
        Dùng email và mật khẩu trên để đăng nhập.
      </p>`
    : "";

  const credBlockText = opts.password
    ? `\nThông tin đăng nhập:\n  Email: ${loginEmail}\n  Mật khẩu: ${opts.password}\nDùng email + mật khẩu trên để đăng nhập.\n`
    : "";

  const html = `<!doctype html>
<html lang="vi">
  <body style="margin:0;padding:0;background:#f3f4f6;">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <div style="background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <h1 style="margin:0 0 4px;font-size:18px;color:#111827;">${esc(
          app,
        )}</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
          Bạn được mời tham gia ${esc(title)}.
        </p>
        <a href="${esc(link)}"
           style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:10px;">
          Vào phòng họp
        </a>
        <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;word-break:break-all;">
          Hoặc mở liên kết: <a href="${esc(link)}" style="color:#4f46e5;">${esc(
    link,
  )}</a>
        </p>
        ${credBlockHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 16px;" />
        <p style="margin:0;font-size:11px;color:#9ca3af;">
          Thư tự động từ ${esc(
            app,
          )}. Nếu bạn không mong đợi thư này, hãy bỏ qua.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text = `${app}

Bạn được mời tham gia ${title}.

Vào phòng họp: ${link}
${credBlockText}
— Thư tự động từ ${app}. Nếu bạn không mong đợi thư này, hãy bỏ qua.`;

  return { subject, html, text };
}
