# Đồng bộ Design System: Dashboard ↔ Canvas/Meeting

> **Trạng thái:** CHIẾN LƯỢC — chưa implement. Tài liệu để anh Luân (PM) thực thi sau, theo phase.
> **Ngày:** 2026-06-19
> **Phạm vi:** chỉ token + SCSS chrome trong `excalidraw-app/components/mcm/` và `excalidraw-app/components/ChatPanel.scss`. KHÔNG đụng canvas-engine của Excalidraw core.
> **Nguyên tắc nền:** giữ khác biệt **glass (dashboard) vs solid (canvas)** CÓ CHỦ ĐÍCH; chỉ loại bỏ phần "lệch do hardcode".

---

## 0. Bối cảnh & kết quả audit (đầu vào, đã xác minh file:line)

Hệ token `--mcm-*` hiện được định nghĩa trong **`MeetingShell.scss`** qua **2 nhánh mixin tách biệt CÓ CHỦ ĐÍCH**:

| Mixin | Dòng | Stamp lên | Material |
|---|---|---|---|
| `mcm-tokens-light` / `mcm-tokens-dark` | 30–69 | `.mcm-shell` (canvas) | **SOLID** — no blur, no glass |
| `mcm-lobby-tokens-light` / `mcm-lobby-tokens-dark` | 77–210 | `.mcm-lobby` + `.mcm-admin` + portal roots | **Glass-Desk** — blur/sat/stroke/elevation |

Comment đầu file (`MeetingShell.scss:3–16`) ghi rõ canvas cố ý: *"No glass / no backdrop blur… 12px radius standard; 8px for buttons; 200ms ease universally."* Đây là **quyết định thiết kế**, không phải lỗi — phải bảo toàn.

### 4 điểm lệch CHÍNH (cần đồng bộ)

1. **ChatPanel namespace riêng `--chat-*`** — `ChatPanel.scss:26–66` map `--chat-*` sang token Excalidraw **core** (`--island-bg-color`, `--text-primary-color`, `--color-primary`), TÁCH hẳn khỏi `--mcm-*`. Hệ quả: chat đổi theo theme Excalidraw, không theo brand MCM; `--chat-bot: #7c6bff` là màu chết hardcode (`ChatPanel.scss:65`).

2. **Video chrome hardcode dark-glass + green + radius**, bỏ qua token:
   - `MeetingGallery.scss`: `rgba(20, 24, 32, 0.97)` (L16), `rgba(11, 14, 20, 0.96)` (L76), `#34d399` (L58, L165), `border-radius: 14px/9px/16px/10px` (L15, 34, 153, 121).
   - `VideoFilmstrip.scss`: `rgba(11, 14, 20, 0.97)` (L54), `blur(14px)` (L55), `rgba(255,255,255,0.08)` stroke (L57).
   - **Comment SAI:** `MeetingGallery.scss:68` ("Dark, glassy, **Glass-Desk consistent**") và `VideoFilmstrip.scss:3` ("**Glass-Desk consistent**") — thực tế KHÔNG đọc token Glass-Desk nào, toàn hardcode.

3. **Accent lệch hue:** canvas/chrome `--mcm-accent: #6965db` (`MeetingShell.scss:41`) vs dashboard `--mcm-accent: #5e5ad8` (`MeetingShell.scss:88`). Hai sắc tím khác nhau → brand không nhất quán giữa 2 mặt sản phẩm.

4. **Typography 2 hệ rời:** dashboard dùng Manrope/Fraunces + type-mixins (`_type.scss`, scope *"`.mcm-lobby` + portal roots ONLY, never the meeting canvas"*); meeting dùng system/SF stack (`MeetingShell.scss:279–283`) với size hardcode rời rạc (`font-size: 13px/14px…`).

### Nợ phụ: radius/motion/shadow ở meeting chrome HARDCODE

Trong chính `MeetingShell.scss` (vùng chrome, sau dòng ~450): `border-radius: 9px` (L459, 580, 627, 1941), `8px` (L511), `14px` (L1257), `16px` (L996, 1699), `10px` (L1888); motion `200ms` (L512, 525, 588…), `120ms` (L561, 788, 1015…), `180ms` (L1259). Scale radius/motion ĐÃ tồn tại dưới dạng token nhưng **chỉ trong nhánh lobby** (`--mcm-radius-*` L129–134, `--mcm-dur-*` L143–146) → chrome không với tới được.

### Pattern mẫu "ngoan nhất": `LiveCaptionDock.scss`

`LiveCaptionDock.scss:66–83` là component DUY NHẤT làm đúng cách dung hòa:
- Dùng `border-radius: var(--mcm-radius-md, 14px)` — token-first + fallback.
- Dùng `blur(var(--mcm-glass-blur, 16px)) saturate(var(--mcm-glass-sat, 1.4))` — đọc token Glass-Desk có fallback.
- GIỮ scrim tối cố định `rgba(20,24,32,0.62)` (L67) **có giải thích** (L62–65): nó float trên video frame tùy ý, surface theo-theme sẽ "biến mất" trên frame cùng tông → đây là dark-on-video CÓ CHỦ ĐÍCH.

→ Đây là **khuôn mẫu** cho tầng token `video` đề xuất bên dưới.

---

## 1. Mục tiêu & nguyên tắc

### Mục tiêu
- **1 nguồn duy nhất** cho **brand-invariant** (accent, radius scale, motion, focus-ring) — dùng chung cho MỌI mặt: dashboard, canvas, video, chat.
- **Context-specific** cho **material** (surface màu, glass blur, scrim) — vẫn tách theo ngữ cảnh.
- Xóa mọi giá trị **hardcode trùng lặp** (radius/motion/green/dark-glass) → thay bằng `var()` có fallback.
- Hợp nhất accent về 1 hue.

### Nguyên tắc bất biến
1. **Giữ glass-vs-solid CÓ CHỦ ĐÍCH.** Canvas = solid (đỡ phân tâm khi vẽ/họp); dashboard = glass (mặt "bàn làm việc" sang). KHÔNG biến canvas thành glass.
2. **Dark-on-video là hợp lệ.** Caption/gallery/filmstrip ngồi TRÊN video frame → scrim tối cố định là đúng, KHÔNG ép theo theme. Nhưng phải **token-hóa** scrim/green/radius đó (tầng `video`) thay vì rải số.
3. **Brand-invariant không được fork.** Accent, radius, motion: 1 giá trị, mọi nơi đọc cùng token.
4. **Alias để không vỡ.** Mọi namespace cũ (`--chat-*`) giữ lại như alias trỏ vào `--mcm-*` → đổi nền móng mà không phải sửa hàng trăm call-site cùng lúc.
5. **Đổi theo TẦNG, không big-bang.** Mỗi phase chỉ chạm 1 tầng token; smoke-test xong mới sang tầng kế.

---

## 2. Kiến trúc token đề xuất

Tách 1 file mới **`excalidraw-app/components/mcm/_tokens.scss`** chứa 4 mixin theo quan hệ **kế thừa** (mixin sau `@include` mixin trước rồi override). `MeetingShell.scss` chỉ còn `@use "./tokens"` và stamp các mixin lên đúng selector.

```
mcm-tokens-core        (brand-invariant — nền của TẤT CẢ)
   ├── mcm-tokens-chrome      (canvas/meeting SOLID — override surface)
   ├── mcm-tokens-glassdesk   (dashboard GLASS — override surface + thêm material)
   └── mcm-tokens-video       (dark-on-video — scrim/green/radius cho gallery/filmstrip/caption)
```

### Tầng `mcm-tokens-core` — brand-invariant (KHÔNG fork)

| Nhóm | Token | Nguồn hiện tại |
|---|---|---|
| Accent | `--mcm-accent`, `--mcm-accent-soft` | **hợp nhất** (xem P3) |
| Radius | `--mcm-radius-xs/sm/md/lg/xl/pill` | từ lobby L129–134 → nâng lên core |
| Padding | `--mcm-pad-card` | L135 |
| Motion | `--mcm-dur-fast/base/enter`, `--mcm-ease`, `--mcm-ease-spring` | từ lobby L143–152 → nâng lên core |
| Focus | `--mcm-ring` | L127 |
| Semantic | `--mcm-success`, `--mcm-danger`, `--mcm-warning` (+ `-soft`) | hiện có ở cả 2 nhánh — gộp về core, mỗi theme 1 giá trị |
| Lux | `--mcm-lux` | L93/L178 (dashboard-only về mặt *dùng*, nhưng định nghĩa ở core cho gọn) |

> Core có 2 biến thể light/dark; chrome & glassdesk chỉ override những token **khác** giữa 2 ngữ cảnh.

### Tầng `mcm-tokens-chrome` — canvas SOLID (`.mcm-shell`)

`@include mcm-tokens-core` rồi override **material**:

| Token | Giá trị (light / dark) | Ghi chú |
|---|---|---|
| `--mcm-bg` | `#f5f5f7` / `#121212` | L31 / L51 |
| `--mcm-text` (+`-soft`/`-faint`) | L32–34 / L52–54 | |
| `--mcm-surface` / `-2` / `-3` | L35–37 / L55–57 | SOLID, không glass |
| `--mcm-hairline` (+`-2`) | L38–39 / L58–59 | |
| `--mcm-elev` | L40 / L60 | shadow solid (không dùng `--mcm-shadow-3` glass) |

→ **KHÔNG** có `--mcm-glass-*` ở tầng này (canvas không glass). Đó là sự khác biệt CÓ CHỦ ĐÍCH.

### Tầng `mcm-tokens-glassdesk` — dashboard GLASS (`.mcm-lobby`, `.mcm-admin`, portal roots)

`@include mcm-tokens-core` rồi override material + **thêm vocabulary glass**:

| Nhóm | Token | Dòng hiện tại |
|---|---|---|
| Surface | `--mcm-bg`, `--mcm-surface`/`-2`/`-0`, `--mcm-text*`, `--mcm-hairline*` | L79–86 / L161–171 |
| Glass | `--mcm-glass-bg`, `--mcm-glass-bg-tr`, `--mcm-glass-blur`, `--mcm-glass-sat`, `--mcm-glass-bright`, `--mcm-glass-stroke`, `--mcm-highlight` | L101–118 / L185–198 |
| Elevation | `--mcm-shadow-1/2/3` | L120–125 / L199–203 |
| Scrim | `--mcm-scrim` | L126 / L204 |
| File-kind | `--mcm-kind-pdf/dxf/ifc/img/misc` | L137–141 / L205–209 |
| Wallpaper | `--mcm-wall-scrim` | `Wallpaper.scss:32–37` (giữ nguyên file) |
| Typography | `--mcm-font-ui`, `--mcm-font-display-num` | L319–320 |

### Tầng `mcm-tokens-video` — dark-on-video (MỚI; gallery/filmstrip/caption)

Mục đích: gom mọi hardcode dark-glass/green/radius của video chrome thành token, **không** ép theo theme (đúng tinh thần `LiveCaptionDock`). Stamp lên `.mcm-gallery`, `.mcm-filmstrip`, `.mcm-layout-switcher__menu`, `.mcm-caption`.

| Token (đề xuất) | Giá trị | Thay cho |
|---|---|---|
| `--mcm-video-surface` | `rgba(11, 14, 20, 0.96)` | gallery L76, filmstrip L54 |
| `--mcm-video-popover` | `rgba(20, 24, 32, 0.97)` | switcher menu L16, caption scrim L67 |
| `--mcm-video-stroke` | `rgba(255, 255, 255, 0.10)` | L17, L57, L71 |
| `--mcm-video-blur` | `blur(10–14px)` (chọn 1) | L18, L55, L77 |
| `--mcm-video-live` | `#34d399` | L58, L165 (viền "đang nói") |
| `--mcm-video-live-glow` | `rgba(52, 211, 153, 0.4)` | L165 |
| Radius | **đọc `--mcm-radius-md/sm`** (đã core) | L15, L34, L121, L153… |

> `--mcm-video-live` cố ý TÁCH khỏi `--mcm-success` của core: đây là "active-speaker ring" trên nền video tối, ngữ nghĩa khác success-state, và phải pop trên frame tối. Nhưng giờ là **1 token** thay vì rải `#34d399` khắp nơi.

---

## 3. Kế hoạch migration theo PHASE

> Mỗi phase độc lập, deploy/smoke-test riêng. Không gộp.

### P0 — Tách `_tokens.scss` + đưa radius/motion/ring vào tầng core (nền móng)

- **Mục tiêu:** core hóa brand-invariant; chrome (`.mcm-shell`) đọc được `--mcm-radius-*` / `--mcm-dur-*` / `--mcm-ring` (hiện chỉ lobby có).
- **File:line đụng tới:**
  - Tạo `excalidraw-app/components/mcm/_tokens.scss` (4 mixin theo §2).
  - `MeetingShell.scss:30–210` → chuyển nội dung mixin sang file mới; ở đây chỉ còn `@use "./tokens" as *` + các `@include` tại L259, L270–272, L311, L340, L347.
  - Di chuyển `--mcm-radius-*` (L129–134), `--mcm-dur-*`/`--mcm-ease*` (L143–152), `--mcm-ring` (L127), `--mcm-pad-card` (L135) từ nhánh lobby lên `mcm-tokens-core` → cả chrome lẫn glassdesk đều thừa hưởng.
- **Thay đổi cụ thể:** thuần refactor cấu trúc; **giá trị token giữ y nguyên**. Output CSS gần như bit-identical (chỉ thêm radius/motion vào scope `.mcm-shell`, vốn chưa ai dùng nên vô hại).
- **Rủi ro:** thấp. Rủi ro chính = sai thứ tự `@include` (core phải đứng trước override). Glass material **không** được rò xuống chrome (chrome KHÔNG include glass mixin).
- **Verify:** build SCSS sạch; diff CSS compiled trước/sau (`grep` các token trên `.mcm-shell` vs `.mcm-lobby` không đổi giá trị); smoke-test: dashboard/login/admin/canvas hiển thị y hệt.
- **Effort:** ~0.5 ngày.

### P1 — ChatPanel → `--mcm-*` (giữ alias `--chat-*`) + token-hóa radius/motion meeting chrome

- **Mục tiêu:** chat ăn token MCM thay vì token Excalidraw core; chrome dùng `var(--mcm-radius/dur-*)` thay hardcode.
- **File:line đụng tới:**
  - `ChatPanel.scss:27–66`: đổi nguồn của `--chat-*` từ `--island-bg-color`/`--text-primary-color`/`--color-primary` sang `--mcm-surface`/`--mcm-text`/`--mcm-accent`. **GIỮ tên `--chat-*`** (alias) → toàn bộ rule body (L68+) không phải sửa. `--chat-bot: #7c6bff` (L65) → cân nhắc đổi sang `var(--mcm-accent)` hoặc giữ làm token bot riêng `--mcm-bot`.
  - `MeetingShell.scss` chrome: thay `border-radius: 9px/8px/14px/16px/10px` (L459, 511, 580, 627, 996, 1257, 1699, 1888, 1941) → `var(--mcm-radius-sm/md/lg)`; thay `120ms/180ms/200ms` (L512, 525, 561, 588, 788, 1015, 1159, 1259…) → `var(--mcm-dur-fast/base)` + `var(--mcm-ease)`. Map giá trị cũ → token gần nhất (8/9/10px→`sm`(10px) hoặc giữ qua biến mới `--mcm-radius-btn:9px` nếu cần khớp pixel).
- **Rủi ro:** trung bình. Chat đang theo theme Excalidraw; sau đổi sẽ theo theme MCM — phải kiểm tương phản text/bubble ở cả light/dark. Radius 8/9px ≠ scale 10px → quyết định: chấp nhận dịch sang 10px (đồng bộ hơn) HAY thêm token `--mcm-radius-btn: 9px` vào core để giữ pixel cũ. **Khuyến nghị:** thêm `--mcm-radius-btn` để không đổi hình học nút.
- **Verify:** smoke-test chat (gửi/nhận, bubble, AI bot màu, translate toggle) light+dark; nút/panel chrome không xê dịch radius rõ rệt.
- **Effort:** ~1 ngày (chat 0.5 + chrome token-hóa 0.5).

### P2 — Token-hóa video chrome (gallery/filmstrip/caption/switcher) + sửa comment sai

- **Mục tiêu:** xóa hardcode dark-glass/green/radius ở video chrome; nối vào tầng `mcm-tokens-video`.
- **File:line đụng tới:**
  - Thêm `@include mcm-tokens-video` (stamp lên `.mcm-gallery`, `.mcm-filmstrip`, `.mcm-layout-switcher`, `.mcm-caption` — hoặc 1 selector chung).
  - `MeetingGallery.scss`: L16→`var(--mcm-video-popover)`, L76→`var(--mcm-video-surface)`, L58/L165→`var(--mcm-video-live)` + `var(--mcm-video-live-glow)`, L15/34/121/153→`var(--mcm-radius-*)`, L17→`var(--mcm-video-stroke)`. **Sửa comment sai L68** ("Glass-Desk consistent" → "dark-on-video scrim, token-hóa qua mcm-tokens-video").
  - `VideoFilmstrip.scss`: L54→`var(--mcm-video-surface)`, L55→`var(--mcm-video-blur)`, L57→`var(--mcm-video-stroke)`. **Sửa comment sai L3.**
  - `LiveCaptionDock.scss`: đã gần đúng — chỉ đổi scrim hardcode L67 sang `var(--mcm-video-popover)`, giữ nguyên fallback pattern (đây là chuẩn vàng).
- **Rủi ro:** thấp–trung bình. Giá trị giữ nguyên (chỉ đổi tên), nên hình thức không đổi; rủi ro = bỏ sót 1 chỗ hardcode → lệch. Lưu ý green `#34d399` cũng là `--mcm-success` ở dark lobby (L179) — **đừng nhầm**: video-live là token riêng dù trùng giá trị.
- **Verify:** smoke-test gallery (grid + speaker), filmstrip, caption (overlay/embedded/popout), layout-switcher menu, active-speaker ring sáng đúng.
- **Effort:** ~1 ngày.

### P3 — Hợp nhất accent + quyết định typography

- **Mục tiêu:** 1 hue accent toàn sản phẩm; chốt hướng typography cho meeting.
- **Accent (`MeetingShell.scss:41` `#6965db` vs `:88` `#5e5ad8`):**
  - Đặt **1 giá trị** vào `mcm-tokens-core` (light). Khuyến nghị: chọn `#5e5ad8` (sắc dashboard mới hơn, theo Glass-Desk 06-12) HOẶC giữ `#6965db` (sắc Excalidraw gốc) — **PM chốt 1**. Xóa override accent ở nhánh còn lại.
  - Kiểm hệ quả: `--mcm-accent-soft`, `--mcm-ring` (color-mix từ accent), mọi `var(--mcm-accent, #6965db)` fallback rải trong chrome (L599, 602, 1825, 1923, 1960…) → fallback cập nhật theo giá trị chốt.
  - Dark accent (`#a8a5ff` chrome L61 vs `#b9b4f4` lobby L174) cũng nên chốt 1 (hoặc giữ 2 nếu olive-dark cần warm — đây là *material-context*, có thể chấp nhận khác).
- **Typography — 2 lựa chọn (PM chốt):**
  - **(A) Mở rộng `_type.scss` cho meeting:** bỏ giới hạn scope, dùng Manrope cho cả chrome. *Lợi:* 1 typeface toàn sản phẩm, cảm giác đồng bộ tuyệt đối. *Hại:* canvas/chrome đang cố ý dùng system/SF stack (`MeetingShell.scss:279` — render nhanh, "app-native", không tải web-font trong phòng họp); đổi = thêm rủi ro FOUT, đụng nhiều size hardcode, mâu thuẫn comment chủ đích.
  - **(B) Giữ system-font cho meeting CÓ CHỦ ĐÍCH (khuyến nghị):** canvas giữ SF/system stack; chỉ **token-hóa size** rời rạc thành thang `--mcm-fs-*` để bớt số ma thuật, nhưng KHÔNG ép Manrope. Ghi rõ vào comment: "meeting = system-font intentional (perf + native feel); dashboard = Manrope branded." Đây là *khác biệt CÓ CHỦ ĐÍCH* giống glass-vs-solid.
  - **Trade-off cốt lõi:** (A) đồng bộ thị giác tối đa, đánh đổi perf + chủ đích "app-native"; (B) giữ chủ đích, đồng bộ ở mức "hệ thang/kỷ luật" thay vì "cùng typeface". Đề xuất **(B)**.
- **Rủi ro:** accent = diện rộng (chạm focus-ring, badge, nút primary mọi view). Typography (A) rủi ro cao; (B) rủi ro thấp.
- **Verify:** soát mọi view có accent (nút primary, focus-ring, badge, link, active-state) light+dark; nếu chọn (A) kiểm FOUT + Korean fallback.
- **Effort:** accent ~0.5 ngày; typography (B) ~0.5 ngày / (A) ~2 ngày.

---

## 4. Thứ tự an toàn & nguyên tắc không vỡ

Đổi token = thay đổi diện rộng (mỗi token chạm hàng chục–trăm call-site). Giảm rủi ro:

1. **Đi đúng thứ tự P0→P3.** P0 thuần cấu trúc (giá trị bất biến) → an toàn nhất, làm móng. Không nhảy cóc.
2. **Alias trước, đổi nguồn sau.** Giữ `--chat-*` (P1), `--mcm-video-*` map giá trị cũ y nguyên (P2) → đổi nền móng mà body rule không phải sửa.
3. **Đổi từng TẦNG, mỗi tầng 1 PR + 1 smoke-test pass.** core → chrome → video → accent. Không trộn nhiều tầng trong 1 PR.
4. **Giữ giá trị bằng số ở P0–P2** (chỉ đổi *tên*, không đổi *giá trị*) → diff CSS compiled phải gần bit-identical; bất kỳ thay đổi pixel nào ngoài dự kiến = dấu hiệu lỗi map.
5. **Fallback luôn đi kèm `var()`** theo chuẩn `LiveCaptionDock`: `var(--mcm-radius-md, 14px)` — portal/popout/clone-stylesheet thiếu stamp vẫn render đúng.
6. **Smoke-test checklist (chạy SAU MỖI phase):** dashboard home / login / admin console / canvas (in-meeting) / gallery (grid + speaker) / filmstrip / screen-share present / live-caption (overlay+popout) / chat panel — ở **cả light & dark**.
7. **Tách "material-context khác biệt" khỏi "lệch lỗi".** Khi gặp giá trị khác giữa 2 ngữ cảnh, hỏi: *cố ý (glass vs solid, dark-on-video, system-font) hay hardcode trùng?* Chỉ hợp nhất loại sau.

---

## 5. Acceptance criteria ("đã đồng bộ")

- [ ] Toàn bộ token `--mcm-*` định nghĩa trong **1 file** `_tokens.scss`, theo 4 tầng kế thừa (`core` → `chrome`/`glassdesk`/`video`).
- [ ] **Brand-invariant không fork:** `--mcm-accent`, `--mcm-radius-*`, `--mcm-dur-*`/`--mcm-ease*`, `--mcm-ring` có **đúng 1 nguồn** ở `core` (light + dark), không bị override theo ngữ cảnh.
- [ ] **0 hardcode** radius/motion trong meeting chrome (`MeetingShell.scss` vùng chrome) — tất cả qua `var(--mcm-radius-*/dur-*)`.
- [ ] **0 hardcode** `rgba(20,24,32…)` / `rgba(11,14,20…)` / `#34d399` trong gallery/filmstrip/caption/switcher — tất cả qua `--mcm-video-*`.
- [ ] `ChatPanel` đọc `--mcm-*` (qua alias `--chat-*`), không còn phụ thuộc `--island-bg-color`/`--color-primary`.
- [ ] Comment sai ở `MeetingGallery.scss:68` và `VideoFilmstrip.scss:3` đã sửa cho đúng bản chất (dark-on-video, không phải Glass-Desk).
- [ ] **Khác biệt CÓ CHỦ ĐÍCH được bảo toàn & ghi chú rõ:** canvas solid (no glass), dashboard glass, video dark-scrim, (nếu chọn B) meeting system-font.
- [ ] Smoke-test 9 view × 2 theme: không lệch thị giác ngoài dự kiến.

---

## 6. Bảng token nguồn cuối (SSOT sau migration)

> Giá trị light (dark trong ngoặc khi khác). "Dùng ở đâu" = selector stamp.

### Tầng `core` — brand-invariant (mọi nơi)

| Token | Giá trị (light / dark) | Dùng ở đâu |
|---|---|---|
| `--mcm-accent` | **`#5e5ad8`** *(PM chốt)* / `#b9b4f4` hoặc `#a8a5ff` | toàn sản phẩm |
| `--mcm-accent-soft` | `rgba(94,90,216,.12)` | nền active/hover |
| `--mcm-ring` | `0 0 0 3px color-mix(accent 30%)` | focus-ring |
| `--mcm-radius-xs/sm/md/lg/xl/pill` | `6/10/14/18/24/999px` | mọi bo góc |
| `--mcm-radius-btn` *(mới, nếu giữ pixel)* | `9px` | nút chrome |
| `--mcm-pad-card` | `12px` | padding card |
| `--mcm-dur-fast/base/enter` | `120/180/240ms` | mọi transition |
| `--mcm-ease` / `--mcm-ease-spring` | `cubic-bezier(.2,0,0,1)` / `(.34,1.25,.64,1)` | easing |
| `--mcm-success/-soft` | `#16a34a` (`#22c55e`) | state OK |
| `--mcm-danger/-soft` | `#dc2626` (`#f87171`) | state lỗi |
| `--mcm-warning/-soft` | `#d97706` (`#fbbf24`) | state cảnh báo |
| `--mcm-lux` | `#b08d3e` (`#d6c08a`) | display numeral (dashboard) |

### Tầng `chrome` — canvas SOLID (`.mcm-shell`)

| Token | Giá trị (light / dark) |
|---|---|
| `--mcm-bg` | `#f5f5f7` / `#121212` |
| `--mcm-text` (+`-soft`/`-faint`) | `#1b1b1f` / `#ebebef` (+α) |
| `--mcm-surface` / `-2` / `-3` | `#fff`/`#f0f0f3`/`#fbfbfd` (dark: `#232329`/`#2c2c34`/`#2f2f38`) |
| `--mcm-hairline` (+`-2`) | `rgba(0,0,0,.12)` / `rgba(255,255,255,.12)` |
| `--mcm-elev` | shadow solid (L40 / L60) |

### Tầng `glassdesk` — dashboard GLASS (`.mcm-lobby`, `.mcm-admin`, portal roots)

| Token | Giá trị (light / dark) |
|---|---|
| `--mcm-bg` | `#eef0f5` / `#0c100b` |
| `--mcm-surface` / `-2` / `-0` | `#fff`/`#f2f3f7`/`#e9ebf1` (dark: `#151a12`/`#1e2419`/`#0e120c`) |
| `--mcm-glass-bg` / `-bg-tr` | `#f7f8fb` / `rgba(250,250,253,.52)` (dark `#161c13` / `rgba(22,28,19,.47)`) |
| `--mcm-glass-blur` / `-sat` / `-bright` | `22px` / `1.5` / `1.05` (dark `1.45` / `.9`) |
| `--mcm-glass-stroke` / `--mcm-highlight` | L112 / L118 |
| `--mcm-shadow-1/2/3` | L120–125 / L199–203 |
| `--mcm-scrim` | `rgba(28,28,30,.35)` / `rgba(0,0,0,.55)` |
| `--mcm-kind-pdf/dxf/ifc/img/misc` | L137–141 / L205–209 |
| `--mcm-wall-scrim` | `rgba(245,246,250,.3)` / `rgba(8,10,7,.22)` |
| `--mcm-font-ui` / `--mcm-font-display-num` | Manrope stack / Fraunces |

### Tầng `video` — dark-on-video (`.mcm-gallery`, `.mcm-filmstrip`, `.mcm-caption`, `.mcm-layout-switcher`)

| Token | Giá trị | Thay cho |
|---|---|---|
| `--mcm-video-surface` | `rgba(11,14,20,.96)` | gallery L76, filmstrip L54 |
| `--mcm-video-popover` | `rgba(20,24,32,.97)` | switcher L16, caption L67 |
| `--mcm-video-stroke` | `rgba(255,255,255,.10)` | L17/57/71 |
| `--mcm-video-blur` | `blur(10–14px)` | L18/55/77 |
| `--mcm-video-live` | `#34d399` | L58/165 (active-speaker ring) |
| `--mcm-video-live-glow` | `rgba(52,211,153,.4)` | L165 |
| *(radius)* | đọc `--mcm-radius-sm/md` (core) | L15/34/121/153 |

---

## 7. Tóm tắt 1 dòng cho mỗi phase

- **P0:** tách `_tokens.scss`, nâng radius/motion/ring lên `core` (giá trị bất biến). ~0.5d, rủi ro thấp.
- **P1:** ChatPanel → `--mcm-*` (alias `--chat-*`) + token-hóa radius/motion chrome. ~1d, rủi ro TB.
- **P2:** token-hóa video chrome qua `mcm-tokens-video` + sửa 2 comment sai. ~1d, rủi ro thấp–TB.
- **P3:** hợp nhất accent (PM chốt hue) + quyết định typography (khuyến nghị giữ system-font có chủ đích). ~1d.
