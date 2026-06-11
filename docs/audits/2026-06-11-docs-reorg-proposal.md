# Đề xuất tổ chức lại thư mục `docs/` — 2026-06-11

> **Trạng thái: ĐỀ XUẤT — chưa di chuyển/sửa file nào.** Khảo sát 20 file `.md` trong `docs/`
> (lệnh `Get-ChildItem`, đọc đầu file + headings từng file, grep toàn bộ cross-reference).
> Mục tiêu: anh Luân (không phải dân CS) mở `docs/` ra là biết **đọc gì trước, đọc gì sau theo tiến trình dự án**,
> file mới sinh ra biết bỏ vào đâu.

---

## 1. Phân loại 20 file hiện có

Sau 10 ngày phát triển, `docs/` đang trộn lẫn 5 vai trò khác nhau trong cùng 1 thư mục phẳng:

| Vai trò | Đặc điểm | File |
|---|---|---|
| **Nhật ký ngày (daily log)** | Tên `YYYY-MM-DD.md`, ghi lại 1 phiên làm việc — tư liệu lịch sử, KHÔNG cập nhật lại | `2026-05-08.md`, `2026-05-29.md`, `2026-06-02.md`, `2026-06-05.md`, `2026-06-10.md`, `2026-06-11.md` |
| **Plan đang sống** | Cập nhật liên tục, là "việc cần làm / thứ tự làm" | `master-plan-4-groups.md`, `roadmap.md`, `production-data-plan.md`, `dev-phase-notes.md`, `2026-06-01-plan-ha-tang-cloudflare.md` (plan gốc, phần lớn đã thực thi) |
| **Spec thiết kế** | Mô tả "hệ thống PHẢI hoạt động thế nào", sống lâu, ít đổi | `host-and-scheduling.md`, `admin-console.md`, `user-data-model.md`, `supabase-setup.md` (hướng dẫn cấu hình) |
| **Audit / báo cáo point-in-time** | Ảnh chụp tại 1 ngày cụ thể, chốt xong là ĐÓNG BĂNG | `data-architecture-audit.md` (06-10), `phase-review-2026-06-11.md`, `admin-feature-proposals-2026-06-11.md`, `user-feature-audit-2026-06-11.md` |
| **Generated doc** | Sinh tự động bằng agent, KHÔNG sửa tay, ghi đè khi regenerate | `architecture.md` |

**Về "đã lỗi thời":** không file nào đáng xoá, nhưng 2 file cần dán banner cảnh báo khi di chuyển:

- `data-architecture-audit.md` — nhiều finding (§2, §3, §4, §5) **đã được fix trong P0+P1**; chính `phase-review-2026-06-11.md` §B đã đề xuất dán banner *"snapshot sáng 06-10, trạng thái sống xem production-data-plan §5"* để khỏi fix lại lần hai.
- `2026-06-01-plan-ha-tang-cloudflare.md` — kế hoạch hạ tầng gốc; P1 remote đã XONG 06-11, một số chi tiết (Cloudflare Access, task theo tuần) đã bị thay bằng quyết định mới (Supabase Auth, master-plan-4-groups). Giữ làm tư liệu "vì sao chọn Cloudflare", dán banner *"plan gốc 06-01 — trạng thái sống xem roadmap.md track I + production-data-plan §5"*.

---

## 2. Cấu trúc mới đề xuất + đích đến từng file

```
docs/
├── README.md                  ← MỤC LỤC dẫn đường (mới, nội dung ở §4)
├── generated/
│   └── architecture.md
├── plans/
│   ├── master-plan-4-groups.md
│   ├── roadmap.md
│   ├── production-data-plan.md
│   ├── dev-phase-notes.md
│   └── 2026-06-01-plan-ha-tang-cloudflare.md
├── specs/
│   ├── host-and-scheduling.md
│   ├── admin-console.md
│   ├── user-data-model.md
│   └── supabase-setup.md
├── audits/
│   ├── 2026-06-10-data-architecture-audit.md      (đổi tên: thêm ngày)
│   ├── 2026-06-11-phase-review.md                 (đổi tên: ngày lên trước)
│   ├── 2026-06-11-admin-feature-proposals.md      (đổi tên: ngày lên trước)
│   └── 2026-06-11-user-feature-audit.md           (đổi tên: ngày lên trước)
└── logs/
    ├── 2026-05-08.md
    ├── 2026-05-29.md
    ├── 2026-06-02.md
    ├── 2026-06-05.md
    ├── 2026-06-10.md
    └── 2026-06-11.md
```

### Bảng đích đến + lý do (từng file)

| # | File hiện tại | Đích đề xuất | Lý do (1 dòng) |
|---|---|---|---|
| 1 | `2026-05-08.md` | `logs/2026-05-08.md` | Nhật ký phiên đầu tiên (realtime collab + tunnel) — tư liệu lịch sử thuần. |
| 2 | `2026-05-29.md` | `logs/2026-05-29.md` | Nhật ký phiên AI bot + attribution — lịch sử thuần. |
| 3 | `2026-06-01-plan-ha-tang-cloudflare.md` | `plans/2026-06-01-plan-ha-tang-cloudflare.md` | Là PLAN (dù tên có ngày) — plan hạ tầng gốc tháng 6, vẫn được architecture.md trỏ tới; dán banner "phần lớn đã thực thi". |
| 4 | `2026-06-02.md` | `logs/2026-06-02.md` | Nhật ký phiên load-perf + dọn data — lịch sử thuần. |
| 5 | `2026-06-05.md` | `logs/2026-06-05.md` | Nhật ký phiên screen share Daily.co Phase 1+2 — lịch sử thuần. |
| 6 | `2026-06-10.md` | `logs/2026-06-10.md` | Nhật ký ngày dày nhất (Phase 4.5 + hardening) — lịch sử thuần. |
| 7 | `2026-06-11.md` | `logs/2026-06-11.md` | Nhật ký phiên P1 remote + architecture doc — lịch sử thuần. |
| 8 | `admin-console.md` | `specs/admin-console.md` | Spec back-office Phase A — thiết kế sống, sẽ build theo. |
| 9 | `admin-feature-proposals-2026-06-11.md` | `audits/2026-06-11-admin-feature-proposals.md` | Đề xuất chốt tại 1 ngày (tổng hợp 4 báo cáo) — point-in-time, ngày lên đầu tên để xếp theo thời gian. |
| 10 | `architecture.md` | `generated/architecture.md` | Doc sinh tự động (8 agents), ghi đè khi regenerate — tách riêng để không ai sửa tay nhầm. |
| 11 | `data-architecture-audit.md` | `audits/2026-06-10-data-architecture-audit.md` | Audit snapshot 06-10, nhiều finding đã fix — thêm ngày vào tên + dán banner stale. |
| 12 | `dev-phase-notes.md` | `plans/dev-phase-notes.md` | Sổ theo dõi "việc tạm/soft cần finalize" — checklist sống, cập nhật liên tục, đi cặp với roadmap. |
| 13 | `host-and-scheduling.md` | `specs/host-and-scheduling.md` | Spec thiết kế host/scheduling chuẩn production — được cả code lẫn doc khác trỏ tới. |
| 14 | `master-plan-4-groups.md` | `plans/master-plan-4-groups.md` | Plan TỔNG đang sống (chốt với anh Luân 06-11) — file "đọc đầu tiên khi quay lại làm việc". |
| 15 | `phase-review-2026-06-11.md` | `audits/2026-06-11-phase-review.md` | Rà soát toàn bộ kế hoạch tại 06-11 — point-in-time, tự nhận "không sửa doc nào khác, chỉ liệt kê". |
| 16 | `production-data-plan.md` | `plans/production-data-plan.md` | Plan dữ liệu production đang sống (P1 ✅, P2/P3 còn lại) — cập nhật theo tiến độ. |
| 17 | `roadmap.md` | `plans/roadmap.md` | Tự nhận "nguồn tham chiếu chuẩn duy nhất cho các phase" — plan sống số 1. |
| 18 | `supabase-setup.md` | `specs/supabase-setup.md` | Hướng dẫn cấu hình Auth ổn định, ít đổi — xếp vào specs để khỏi đẻ thêm thư mục `guides/` (đơn giản trước). |
| 19 | `user-data-model.md` | `specs/user-data-model.md` | Nửa audit nửa spec, nhưng "mô hình đích" (UUID identity) là spec cho P2 CHƯA làm — vẫn là thiết kế sống. |
| 20 | `user-feature-audit-2026-06-11.md` | `audits/2026-06-11-user-feature-audit.md` | Khảo sát 6 hành trình user tại 06-11 — point-in-time, checklist (d) sẽ tick dần nhưng bảng inventory là snapshot. |
| — | `docs-reorg-proposal.md` (file này) | `audits/2026-06-11-docs-reorg-proposal.md` | Chính nó cũng là đề xuất point-in-time — sau khi thực thi xong thì chuyển vào audits/ làm tư liệu. |

**Nguyên tắc phân loại nhanh** (khi phân vân): *file có ngày trong tên hoặc "chốt ngày X" → audits/ hoặc logs/; file phải mở ra cập nhật mỗi khi làm xong việc → plans/; file mô tả "hệ thống hoạt động thế nào" → specs/; file do agent sinh → generated/.*

---

## 3. Cross-reference sẽ GÃY khi di chuyển

Grep toàn bộ `](...)` và mention `docs/...` trong docs + code. Chia 3 nhóm:

### 3a. Link Markdown thật (tương đối) — GÃY, PHẢI sửa khi di chuyển

| File chứa link (vị trí mới) | Dòng | Link hiện tại | Sửa thành |
|---|---|---|---|
| `specs/admin-console.md` | 3 | `](roadmap.md)` | `](../plans/roadmap.md)` |
| `plans/dev-phase-notes.md` | 3 | `](host-and-scheduling.md)` | `](../specs/host-and-scheduling.md)` |
| `plans/dev-phase-notes.md` | 3 | `](admin-console.md)` | `](../specs/admin-console.md)` |
| `audits/2026-06-10-data-architecture-audit.md` | 5 | `](user-data-model.md)` | `](../specs/user-data-model.md)` |
| `audits/2026-06-10-data-architecture-audit.md` | 5 | `](host-and-scheduling.md)` | `](../specs/host-and-scheduling.md)` |
| `audits/2026-06-10-data-architecture-audit.md` | 5 | `](dev-phase-notes.md)` | `](../plans/dev-phase-notes.md)` |
| `audits/2026-06-10-data-architecture-audit.md` | 5 | `](admin-console.md)` | `](../specs/admin-console.md)` |
| `audits/2026-06-10-data-architecture-audit.md` | 45, 102 | `](user-data-model.md)` ×2 | `](../specs/user-data-model.md)` |
| `plans/production-data-plan.md` | 3 | `](data-architecture-audit.md)` | `](../audits/2026-06-10-data-architecture-audit.md)` *(đổi cả tên)* |
| `plans/production-data-plan.md` | 3 | `](user-data-model.md)` | `](../specs/user-data-model.md)` |
| `plans/master-plan-4-groups.md` | 3 | `](phase-review-2026-06-11.md)` | `](../audits/2026-06-11-phase-review.md)` *(đổi cả tên)* |
| `plans/master-plan-4-groups.md` | 3 | `](admin-feature-proposals-2026-06-11.md)` | `](../audits/2026-06-11-admin-feature-proposals.md)` *(đổi cả tên)* |
| `plans/master-plan-4-groups.md` | 3, 9 | `](user-feature-audit-2026-06-11.md)` ×2 | `](../audits/2026-06-11-user-feature-audit.md)` *(đổi cả tên)* |
| `plans/roadmap.md` | 14 | `](supabase-setup.md)` | `](../specs/supabase-setup.md)` |
| `plans/roadmap.md` | 23 | `](host-and-scheduling.md)` | `](../specs/host-and-scheduling.md)` |
| `plans/roadmap.md` | 49 | `](admin-console.md)` | `](../specs/admin-console.md)` |

**Link TỰ LÀNH** (2 file đi cùng nhau vào cùng thư mục — không cần sửa):
- `2026-06-11.md:3` → `](2026-06-10.md)` — cả hai cùng vào `logs/`.
- `host-and-scheduling.md:3` → `](admin-console.md)` — cả hai cùng vào `specs/`.
- `dev-phase-notes.md:3` → `](roadmap.md)` — cả hai cùng vào `plans/`.

### 3b. Mention dạng text/backtick `docs/...` trong docs — không phải hyperlink nhưng NÊN sửa (kẻo người đọc/agent lạc đường)

| File | Dòng | Mention | Xử lý |
|---|---|---|---|
| `roadmap.md` | 3 | `docs/YYYY-MM-DD.md`, `2026-06-10.md`, `production-data-plan.md` | Sửa → `docs/logs/YYYY-MM-DD.md`, `logs/2026-06-10.md` (production-data-plan cùng plans/, giữ nguyên). |
| `architecture.md` | 5 | `docs/roadmap.md`, `docs/dev-phase-notes.md`, `docs/production-data-plan.md`, `docs/host-and-scheduling.md`, `docs/2026-06-01-plan-ha-tang-cloudflare.md` | Generated — sẽ tự đúng ở lần regenerate; sửa tay tạm 5 path cũng được. |
| `phase-review-2026-06-11.md` | 72–90, 100 | ~18 mention `docs/roadmap.md`, `docs/production-data-plan.md`, `docs/data-architecture-audit.md`, `docs/dev-phase-notes.md`, `docs/host-and-scheduling.md`, `docs/admin-console.md` | Là snapshot lịch sử — chấp nhận để nguyên, chỉ cần dòng đầu file ghi "đường dẫn trong bảng là vị trí cũ trước reorg 06-11". |
| `user-feature-audit-2026-06-11.md` | 145 | `docs/host-and-scheduling.md` | Như trên (snapshot — ghi chú 1 dòng đầu file). |
| `admin-feature-proposals-2026-06-11.md` | 156 | `docs/admin-console.md`, `docs/data-architecture-audit.md` | Như trên. |
| `2026-06-10.md` | 39–41 | `docs/data-architecture-audit.md`, `docs/user-data-model.md`, `docs/production-data-plan.md` | Log lịch sử — để nguyên, README đã giải thích quy ước cũ/mới. |
| `2026-06-11.md` | 37 | `docs/architecture.md` | Log lịch sử — để nguyên hoặc sửa → `docs/generated/architecture.md`. |

### 3c. Tham chiếu từ NGOÀI `docs/` — dễ quên nhất

**Trong code (comment — nên sửa cùng đợt di chuyển):**

| File code | Dòng | Trỏ tới | Sửa thành |
|---|---|---|---|
| `excalidraw-app/components/mcm/meetingStatus.ts` | 2 | `docs/host-and-scheduling.md` | `docs/specs/host-and-scheduling.md` |
| `excalidraw-app/components/mcm/WaitingForStart.tsx` | 16 | `docs/host-and-scheduling.md` | `docs/specs/host-and-scheduling.md` |
| `excalidraw-app/data/userProfile.ts` | 263 | `docs/host-and-scheduling.md` | `docs/specs/host-and-scheduling.md` |
| `excalidraw-app/data/userProfile.ts` | 428, 435 | `docs/user-data-model.md` | `docs/specs/user-data-model.md` |

**Trong memory của Claude (ngoài repo — nhắc agent phiên sau cập nhật khi thực thi reorg):**
7 file memory đang trỏ `docs/...` đường dẫn cũ: `MEMORY.md`, `project_mcm-overview.md`, `project_mcm-dev-phase.md` (→ dev-phase-notes), `project_mcm-finished-meeting-immutable.md`, `reference_mcm-architecture-doc.md` (→ architecture.md), `reference_mcm-progress-log.md` (→ vị trí daily log), `reference_mcm-review-mode-entry.md`.

---

## 4. Nội dung đề xuất cho `docs/README.md`

```markdown
# MAP CanvasMeet — Tài liệu dự án

Tool họp nội bộ trên nền Excalidraw fork: canvas chung realtime, chat + AI bot,
dịch/STT, viewer DXF/IFC/PDF, screen share (Daily.co), auth Supabase,
backend Cloudflare Worker + D1 + R2. Bắt đầu 2026-05-08.

## Đọc theo thứ tự này (người mới / quay lại sau nghỉ)

1. **`generated/architecture.md`** — Bức tranh hệ thống HIỆN TẠI (sinh tự động
   2026-06-11). Hiểu cái gì đang chạy trước khi đọc kế hoạch.
2. **`plans/master-plan-4-groups.md`** — Việc SẮP LÀM, chia 4 nhóm, thứ tự đã
   chốt với anh Luân 06-11. Đây là "kim chỉ nam" hiện hành.
3. **`plans/roadmap.md`** — Phase nào xong / đang dở (nguồn chuẩn duy nhất về phase).
4. **`plans/production-data-plan.md`** + **`plans/dev-phase-notes.md`** —
   Kế hoạch dữ liệu production và danh sách "việc tạm cần finalize".
5. **`specs/`** — Đọc KHI CẦN chi tiết thiết kế: host & lịch họp
   (`host-and-scheduling.md`), admin console (`admin-console.md`),
   model user (`user-data-model.md`), cấu hình auth (`supabase-setup.md`).
6. **`audits/`** — Ảnh chụp đánh giá tại từng mốc (tên có ngày). Đọc khi cần
   hiểu "vì sao hồi đó quyết định vậy". KHÔNG coi là trạng thái hiện tại.
7. **`logs/`** — Nhật ký từng phiên làm việc (tiếng Việt), chi tiết kỹ thuật
   + gotchas. Tra cứu khi cần biết "hôm đó đã làm gì, vướng gì".

## Dòng thời gian dự án (qua logs/)

| Ngày | Mốc |
|---|---|
| 05-08 | Realtime collab chạy được qua Cloudflare Tunnel |
| 05-29 | AI bot trong canvas + attribution tác giả |
| 06-01 | Chốt kế hoạch hạ tầng Cloudflare serverless (plans/2026-06-01-…) |
| 06-02 | Tăng tốc mở lại meeting + chốt "meeting xong = bất biến" |
| 06-05 | Screen share + audio qua Daily.co; Supabase Auth |
| 06-10 | Phase 4.5 scheduling + siết quyền server-enforced + 3 audit dữ liệu |
| 06-11 | P1 hạ tầng Cloudflare remote LIVE + architecture.md + master plan 4 nhóm |

## Quy ước đặt file MỚI (từ 2026-06-11)

- `logs/YYYY-MM-DD.md` — nhật ký ngày; viết xong KHÔNG sửa lại (trừ typo).
- `audits/YYYY-MM-DD-<chủ-đề>.md` — báo cáo/đề xuất point-in-time; chốt xong
  ĐÓNG BĂNG; nếu sau này stale thì dán banner trỏ tới doc sống, không sửa nội dung.
- `plans/<tên-không-ngày>.md` — kế hoạch sống; dòng đầu file luôn có
  "Cập nhật lần cuối: YYYY-MM-DD".
- `specs/<tên-không-ngày>.md` — thiết kế sống; sửa trực tiếp khi quyết định đổi,
  ghi "(cập nhật YYYY-MM-DD)" cạnh mục đổi.
- `generated/` — KHÔNG sửa tay; regenerate bằng agent rồi ghi đè.
- Link giữa các doc: luôn dùng đường dẫn tương đối (`../specs/…`) để click được
  trên GitHub/editor.
- Tên file: kebab-case, không dấu, tiếng Anh cho plans/specs; nội dung tiếng Việt OK.
```

---

## 5. Trình tự thực thi an toàn (khi anh Luân duyệt)

1. Tạo 5 thư mục con + `git mv` 20 file theo bảng §2 (dùng `git mv` để giữ history).
2. Sửa 16 link thật theo bảng §3a (cùng 1 commit với bước 1 — tránh trạng thái gãy).
3. Sửa 5 comment trong code theo §3c (cùng commit).
4. Sửa mention sống ở `roadmap.md:3`; dán 3 banner (data-architecture-audit, plan 06-01, ghi chú "đường dẫn cũ" đầu 3 file audit 06-11).
5. Tạo `docs/README.md` theo §4.
6. Regenerate `architecture.md` ở lần cập nhật kế tiếp (tự sửa path); cập nhật 7 file memory của Claude.
7. Kiểm tra: grep `](` trong `docs/` — mọi link tương đối phải resolve được.
