# Design System "Glass Desk" — MCM Dashboard 2026

> Chốt 2026-06-12 bởi team 6 agents (research Liquid Glass + khảo sát token + 3 design director + judge). Yêu cầu gốc của anh Luân: "redesign UI/UX của toàn bộ trang dashboard - a muốn nó giống như app của Apple design, trend 2026". Khung lấy từ hướng **Liquid Glass Faithful** (44/50), ghép sự tiết chế của **HIG Refined** (blur budget 3, scrim không blur, text-soft solid, ring-trong-shadow, tabular-nums) và chi tiết của **Spatial 2026** (--mcm-kind-* có cặp dark, đèn rail trên meeting card, FAB hover translateY).
>
> Bản đầy đủ (bảng điểm 3 hướng + spec từng mục) nằm trong kết quả workflow `wf_dee5dfa3-013`; file này là bản tóm lược vận hành — đủ để maintain/mở rộng đúng hệ.

**Tên nội bộ:** "Glass Desk" — *bàn giấy đặc, khung kính nổi*. Content (cards, list, calendar) luôn là giấy đặc; chỉ KHUNG điều hướng (header, sidebar, overlay) là kính Liquid Glass.

**Phạm vi:** mọi thứ trong `.mcm-lobby` (dashboard). KHÔNG đụng canvas họp.

## Nguyên tắc bất biến

1. **Scope an toàn:** token mới + giá trị đổi chỉ khai báo trong `.mcm-lobby` (block sau `.mcm-shell` trong MeetingShell.scss). Mixin gốc chỉ nhận 2 fix: `--mcm-surface-3` (cả 2 theme) + `--mcm-danger` dark `#f87171`. Canvas họp miễn nhiễm.
2. **Dark override lặp đủ 3 ngữ cảnh:** `.mcm-shell:has(.excalidraw.theme--dark) .mcm-lobby`; khối stamp portal body (`.mcm-pp-overlay`/`.mcm-cmodal-ov` — MỌI token mới phải stamp vào đây, thiếu là "nút tàng hình"); khối dark CalendarX.scss.
3. **Ngân sách backdrop-filter ≤ 4 đồng thời** (06-12 frosted-mirror rev, từ ≤3): 3 vùng cố định sidebar + header + middle-head toolbar row (MỘT filter cho cả hàng, không per-button) + MỘT overlay. CẤM blur trên mcard / list row / calendar cell / scrim / phần tử cuộn-drag; nút đứng lẻ trên desk (FAB…) nền semi-transparent, không blur riêng. Mixin `mcm-glass` mặc định ĐỤC (`--mcm-glass-bg`), chỉ trong suốt trong `@supports (backdrop-filter…)`. Công thức frost 06-12: blur 22px + saturate 1.5|1.45 + brightness 1.05|0.9, alpha kính .52|.47 — wallpaper gần rõ với **whisper-blur 5px** trên layer ảnh (PM tune: "rõ thì rối, nhòe 1 chút xíu thôi" — giữ ≤6px, kèm scale 1.02 che mép lem), scrim mỏng .30|.22.
4. **4 nhánh fallback bắt buộc:** no-backdrop-filter (tự nhiên), `prefers-reduced-transparency`, `prefers-contrast: more`, `prefers-reduced-motion` (kill-switch cuối MeetingShell.scss).
5. **Hợp đồng inline từ TSX giữ nguyên tên:** `--mcard-color` / `--pa` / `--mc` / `--swatch`.
6. **Concentric radii:** radius con = radius cha − 4px mỗi cấp lồng (24 → 18 → 14 → 10 → 6); scale: xs 6 / sm 10 / md 14 / lg 18 / xl 24 / pill 999.
7. **Sàn đục kính (06-12 nới):** light .52 / dark .47 — sàn cũ ≥70/64% retired vì blur 22px tự làm phẳng chi tiết sau kính; text trên kính vẫn không phụ thuộc nội dung sau lưng nhờ blur+brightness. `--mcm-text-faint` chỉ dành cho placeholder/decor, cấm text nội dung.

## Token chính (light | dark)

- Ink: `--mcm-text #1d1d1f | #f0f0f4` · `--mcm-text-soft #6e6e73 (solid) | rgba(240,240,244,.66)`
- Nền: `--mcm-bg #eef0f5 | #0e0e11` (+ 2 radial-gradient tĩnh trên `.mcm-3col`, không animate, không fixed-attachment) · `--mcm-surface #fff | #1c1c21` · `--mcm-surface-0` (lõm) · `--mcm-surface-2` (wash) · `--mcm-surface-3`
- Accent: `--mcm-accent #5e5ad8 | #a8a5ff`; semantic success/warning/danger light đậm hóa đạt AA, soft chuyển alpha
- Kính (06-12 frosted-mirror): `--mcm-glass-bg(-tr .52|.47)`, `--mcm-glass-blur 22px`, `--mcm-glass-sat 1.5|1.45`, `--mcm-glass-bright 1.05|0.9`, `--mcm-glass-stroke` (viền gradient 1px), `--mcm-highlight` (specular mép trên)
- Elevation 3 bậc `--mcm-shadow-1/2/3` (ring 1px nằm TRONG shadow thay border) · `--mcm-scrim` · `--mcm-ring` (focus-visible toàn dashboard)
- Kind colors My Files: `--mcm-kind-pdf/dxf/ifc/img/misc` đủ cặp light/dark
- Motion: `--mcm-dur-fast 120 / base 180 / enter 240`, `--mcm-ease`, `--mcm-ease-spring` (chỉ popover/swatches/toast vào). Chỉ animate transform/opacity/background-color.

## Vật liệu theo surface

| Surface | Vật liệu |
|---|---|
| Header `.mcm-lobby__top`, Sidebar `.mcm-nav` | KÍNH (mcm-glass; sidebar nổi margin 12px, radius-lg, nav active = wash + bar dọc 3px capsule) |
| Modal panel, popover/user-menu/swatches, toast, bell dropdown | KÍNH (overlay slot; toast có rail semantic 3px thay nền đỏ đặc; scrim ĐẶC không blur) |
| Meeting card, My Files, ProjectManager, Calendar, day panel | GIẤY ĐẶC (mcard: bỏ stripe trái → đèn rail 2.5×36px top-center màu meeting; LIVE ring tĩnh 2 lớp; My Files/PMgr de-box: section card + divider hairline-2 + hover wash) |

Typography: Display 24/700 · Title 16/650 · Number 17/700 tnum · Body 13.5/450 · Label 11/650 UPPERCASE (text-soft, không faint) · Caption 11.5/500. `tabular-nums` cho mọi giờ/ngày/size/count.

## Bổ sung theo lưu ý anh Luân (06-12)

- Project viewer (trang Quản lý dự án) có toggle **LIST ↔ CARD** như meeting viewer; CARD mode lấy cover làm điểm nhấn (~16:10, không cover → gradient accent-soft + chữ cái đầu); tái dùng `.mcm-segmented` + keys `view.grid`/`view.list` sẵn có.
- Nút lệnh từng surface: không thừa, không thiếu, dễ hiểu — audit khi sửa surface.

## Trạng thái implement

Triển khai 06-12 bằng workflow `wf_d94801ef-60a` (B1 token layer → B2-5 MeetingShell surfaces ∥ B6 ProjectManager+toggle ∥ B7 CalendarX ∥ B8 NotificationBell → verify). Xem progress log 2026-06-12 cho kết quả + những gì lệch spec.
