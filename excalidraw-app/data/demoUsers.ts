// Demo accounts — the real "Architectural AI R&D Center" team (MAP),
// sourced from user.csv. Used for one-click demo login so the flow shows
// real names/emails. Luan (lethanhluan) is the host/owner of demo projects.
// (Demo only — no real auth; replaced by Cloudflare Access SSO later.)

export type DemoUser = {
  name: string;
  email: string;
  title: string;
  isHost?: boolean;
};

export const DEMO_DIVISION = "Architectural AI R&D Center";
export const DEMO_COMPANY = "MAP";

export const DEMO_USERS: DemoUser[] = [
  { name: "Yu Hun", email: "hyu@mapgroup.co.kr", title: "Vice President" },
  {
    name: "Luan",
    email: "lethanhluan@mapgroup.co.kr",
    title: "Team Lead",
    isHost: true,
  },
  { name: "Jang Dojin", email: "dojin0721@mapgroup.co.kr", title: "Director" },
  {
    name: "Jeon Hee-jin",
    email: "heejini1@mapgroup.co.kr",
    title: "Deputy Team Lead",
  },
  { name: "Jin Hyo-won", email: "jhw0512@mapgroup.co.kr", title: "Staff" },
];
