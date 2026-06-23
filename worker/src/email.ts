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
  appName?: string;
};
// SECURITY (B4, 06-17): the invite email NEVER carries login credentials.
// A mistyped recipient must not receive a working password. Guests log in via
// the magic-link flow; the host shares any temp password out-of-band.

/**
 * Compose a guest meeting-invite email (subject + html + text).
 * Plain inline-styled HTML, no external assets. Vietnamese primary copy.
 */
export function guestInviteEmail(opts: GuestInviteOpts): {
  subject: string;
  html: string;
  text: string;
} {
  const app = opts.appName ?? "Canvas M";
  const title = opts.meetingTitle?.trim() || "cuộc họp";
  const link = opts.link;

  const subject = opts.meetingTitle
    ? `[${app}] Lời mời: ${opts.meetingTitle}`
    : `[${app}] Lời mời tham gia cuộc họp`;

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

— Thư tự động từ ${app}. Nếu bạn không mong đợi thư này, hãy bỏ qua.`;

  return { subject, html, text };
}

export type PackageShareOpts = {
  packageTitle?: string;
  link: string;
  appName?: string;
};

/**
 * Compose a "a recap package was shared with you" email (subject + html + text)
 * for an audience='list' package publish. Plain inline-styled HTML, no external
 * assets. Vietnamese primary copy, mirrors guestInviteEmail.
 */
export function packageShareEmail(opts: PackageShareOpts): {
  subject: string;
  html: string;
  text: string;
} {
  const app = opts.appName ?? "Canvas M";
  const title = opts.packageTitle?.trim() || "bản tổng kết cuộc họp";
  const link = opts.link;

  const subject = opts.packageTitle
    ? `[${app}] Đã chia sẻ: ${opts.packageTitle}`
    : `[${app}] Bản tổng kết cuộc họp được chia sẻ với bạn`;

  const html = `<!doctype html>
<html lang="vi">
  <body style="margin:0;padding:0;background:#f3f4f6;">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <div style="background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <h1 style="margin:0 0 4px;font-size:18px;color:#111827;">${esc(
          app,
        )}</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
          ${esc(title)} đã được chia sẻ với bạn.
        </p>
        <a href="${esc(link)}"
           style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:10px;">
          Xem bản tổng kết
        </a>
        <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;word-break:break-all;">
          Hoặc mở liên kết: <a href="${esc(link)}" style="color:#4f46e5;">${esc(
    link,
  )}</a>
        </p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 16px;" />
        <p style="margin:0;font-size:11px;color:#9ca3af;">
          Thư tự động từ ${esc(
            app,
          )}. Mở mục “Đã chia sẻ với tôi” sau khi đăng nhập để xem.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text = `${app}

${title} đã được chia sẻ với bạn.

Xem bản tổng kết: ${link}

— Thư tự động từ ${app}. Mở mục "Đã chia sẻ với tôi" sau khi đăng nhập để xem.`;

  return { subject, html, text };
}
