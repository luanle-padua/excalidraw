// DEV-ONLY — passwords in here are stripped from production builds ONLY
// because the sole importer is DevQuickLogin behind import.meta.env.DEV.
// Do not import from anywhere else.
//
// Demo accounts — real MAP people sourced from user.csv, grouped by
// DIVISION so cross-department flows are one click away (phòng ban A mời
// phòng ban B → partial project visibility, acting-host, v.v.). All share
// the demo password; admin has its own. Luan (lethanhluan) is the host/owner
// of the demo projects. (Demo only — replaced by SSO later.)

export type DemoUser = {
  name: string;
  email: string;
  title: string;
  /** Division the account belongs to — drives the quick-login grouping. */
  division: string;
  isHost?: boolean;
  /** back-office admin account (separate from meeting users — never joins). */
  isAdmin?: boolean;
  /** per-account password override (admin uses a different one). Defaults to
   *  the shared demo password in DevQuickLogin. */
  password?: string;
};

export const DEMO_DIVISION = "Architectural AI R&D Center";
export const DEMO_COMPANY = "MAP";

export const DEMO_USERS: DemoUser[] = [
  {
    name: "관리자",
    email: "admin@mapgroup.co.kr",
    title: "System Admin",
    division: "Admin",
    isAdmin: true,
    password: "MapAdmin@2026",
  },
  // ---- Architectural AI R&D Center (đội chính) ----
  {
    name: "유훈",
    email: "hyu@mapgroup.co.kr",
    title: "부사장",
    division: DEMO_DIVISION,
  },
  {
    name: "루안",
    email: "lethanhluan@mapgroup.co.kr",
    title: "팀장",
    division: DEMO_DIVISION,
    isHost: true,
  },
  {
    name: "장도진",
    email: "dojin0721@mapgroup.co.kr",
    title: "실장",
    division: DEMO_DIVISION,
  },
  {
    name: "전희진",
    email: "heejini1@mapgroup.co.kr",
    title: "부팀장",
    division: DEMO_DIVISION,
  },
  {
    name: "진효원",
    email: "jhw0512@mapgroup.co.kr",
    title: "사원",
    division: DEMO_DIVISION,
  },
  // ---- Phòng ban khác (test luồng cross-division: mời nhau họp, partial
  // project visibility, acting-host từ phòng khác…) ----
  {
    name: "강준우",
    email: "jjoony_0310@mapgroup.co.kr",
    title: "부팀장",
    division: "Architectural Design Div. 1",
  },
  {
    name: "권소연",
    email: "kwon3214@mapgroup.co.kr",
    title: "팀장",
    division: "Architectural Design Div. 2",
  },
  {
    name: "김동욱",
    email: "keirang@mapgroup.co.kr",
    title: "실장",
    division: "Architectural Design Div. 2",
  },
];
