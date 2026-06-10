import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = {};
for (const l of readFileSync(new URL("../worker/.dev.vars", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const W = "http://127.0.0.1:8787";
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const tok = async (e, p) => (await sb.auth.signInWithPassword({ email: e, password: p })).data.session.access_token;
const H = (t) => ({ Authorization: `Bearer ${t}` });
const T = await tok("lethanhluan@mapgroup.co.kr", "MapMeet@2026");

const mm = await fetch(W + "/v1/me/meetings", { headers: H(T) });
const mj = await mm.json();
console.log("GET /v1/me/meetings:", mm.status, "| count:", mj.meetings?.length, "| sample:", (mj.meetings||[]).slice(0,2).map(x=>`${x.title}[${x.status}]@${x.scheduled_at||'-'}`).join(" | "));

const put = await fetch(W + "/v1/notes", { method: "PUT", headers: { ...H(T), "content-type": "application/json" }, body: JSON.stringify({ scope: "day", ref: "2026-06-15", body: "test note ngày 15" }) });
console.log("PUT /v1/notes:", put.status);
const get = await (await fetch(W + "/v1/notes?scope=day&ref=2026-06-15", { headers: H(T) })).json();
console.log("GET /v1/notes:", JSON.stringify(get));
