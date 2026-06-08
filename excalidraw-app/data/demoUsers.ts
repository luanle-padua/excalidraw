// Demo accounts — the real "Architectural AI R&D Center" team (MAP),
// sourced from user.csv. Used for one-click demo login so the flow shows
// real names/emails. Luan (lethanhluan) is the host/owner of demo projects.
// (Demo only — no real auth; replaced by Cloudflare Access SSO later.)

export type DemoUser = {
  name: string;
  email: string;
  title: string;
  isHost?: boolean;
  /** back-office admin account (separate from meeting users — never joins). */
  isAdmin?: boolean;
  /** per-account password override (admin uses a different one). Defaults to
   *  the shared demo password in LoginScreen. */
  password?: string;
};

export const DEMO_DIVISION = "Architectural AI R&D Center";
export const DEMO_COMPANY = "MAP";

export const DEMO_USERS: DemoUser[] = [
  {
    name: "관리자",
    email: "admin@mapgroup.co.kr",
    title: "System Admin",
    isAdmin: true,
    password: "MapAdmin@2026",
  },
  { name: "유훈", email: "hyu@mapgroup.co.kr", title: "부사장" },
  {
    name: "루안",
    email: "lethanhluan@mapgroup.co.kr",
    title: "팀장",
    isHost: true,
  },
  { name: "장도진", email: "dojin0721@mapgroup.co.kr", title: "실장" },
  {
    name: "전희진",
    email: "heejini1@mapgroup.co.kr",
    title: "부팀장",
  },
  { name: "진효원", email: "jhw0512@mapgroup.co.kr", title: "사원" },
];
