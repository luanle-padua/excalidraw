# Meeting Recording (Phase 5) — Storage, Usage & Cost Estimate

> **Status:** ANALYSIS / COST MODEL (2026-06-23). No code. Companion to the design
> spec `docs/specs/video-and-recording.md` (the "record-what / how" decisions) and
> the backup policy in `docs/runbooks/backup.md`. This doc answers the **one open
> question** the spec defers to anh Luân: *how much does Phase 5 recording actually
> cost per month, and what is the cheapest sensible config for "review / docs only"?*
>
> **Đọc trước (cho PM):** §0 tóm tắt và bảng §6. Phần giữa là cơ sở tính toán.

---

## 0. Tóm tắt điều hành (executive summary)

- **Mô hình chi phí:** mỗi cuộc *có ghi* = (a) **Daily cloud recording** tính theo
  **recorded-minute** (1 file MP4, KHÔNG nhân theo số người) + (b) **R2 storage**
  theo GB-tháng × cửa sổ retention. Egress R2 = **free**. Canvas dựng lại từ
  event-log ⇒ **≈0 chi phí lưu trữ thêm** (chỉ thêm vài KB D1). STT/Daily call
  minutes đã tính riêng (xem [[ai-model-per-job]] / Admin Cost tab).
- **Daily recording charge** là khoản lớn nhất và là khoản **chạy ngay khi ghi**:
  **$0.01349/phút ghi + $0.003/phút lưu** = **~$0.0165/phút** ⇒ **~$0.99/giờ ghi**
  (xem §1). Đây là chi phí **per-recording-minute**, độc lập với số người dự.
- **R2 lưu trữ rất rẻ** ở bitrate thấp: 1 giờ MP4 480p ≈ **180 MB** ⇒ ~**$0.0027/tháng**
  (Standard) hay ~**$0.0018/tháng** (IA). Chi phí lưu chỉ thành đáng kể khi
  **volume × retention** lớn — và vẫn nhỏ hơn nhiều so với khoản Daily recording.
- **Headline $/tháng (xem bảng §6):**
  - **Small** (20 cuộc × 45 phút, retention 90 ngày): **≈ $15.0 / tháng**.
  - **Medium** (100 cuộc × 60 phút, retention 90 ngày): **≈ $99.7 / tháng**.
  - **Large** (300 cuộc × 60 phút, retention 180 ngày): **≈ $300 / tháng**.
  - Trong mọi kịch bản, **Daily recording charge chiếm ~98–99%** tổng chi phí
    Phase 5; R2 storage là phần lẻ.
- **Cấu hình rẻ nhất hợp lý cho "review/docs only"** (§5): **480p @ ~600 kbps +
  AAC 64 kbps, IA tier, retention 90 ngày, default OFF**. Đòn bẩy tiết kiệm LỚN
  nhất KHÔNG phải bitrate hay tier — mà là **chỉ ghi khi cần** (default OFF) và
  **dùng audio-only khi không cần hình** (Daily vẫn tính recording-minute như
  nhau, nhưng file nhỏ ~10× ⇒ R2 rẻ hơn nữa, và phần lớn giá trị review là giọng
  nói + transcript + canvas-replay chứ không phải khuôn mặt).

---

## 1. Daily cloud recording — chi phí (đã verify)

Daily tính **recording theo phút GHI (recorded-minute), KHÔNG theo participant-minute**
— 1 cuộc 60 phút có ghi = 60 recorded-minute dù 2 hay 20 người dự (đây là lý do
spec §3.3 muốn **merge mic+camera+screen vào 1 Daily room** ⇒ 1 file composited,
1 dòng tính tiền, thay vì 2 room = 2 file = 2× recording charge).

| Khoản | Đơn giá | Ghi chú |
| --- | --- | --- |
| Cloud recording (composited) | **$0.01349 / recorded-min** | per recorded-minute |
| Recording storage (phía Daily) | **$0.003 / min** | tính khi file còn nằm trên Daily/S3 |
| **Tổng recording** | **≈ $0.01649 / recorded-min** | ⇒ **~$0.989 / giờ ghi** |
| Free tier | **10,000 phút/tháng** | là **participant-minute của call**, dùng chung audio/video — **không** miễn phí recorded-minute |

> **Hệ quả chi phí:** copy file về R2 **rồi xoá bản Daily** (spec §3.3 pipeline
> "optionally delete the Daily-side copy") để **cắt khoản $0.003/min storage phía
> Daily** — chỉ giữ ~$0.01349/min recording. Nếu xoá ngay sau khi `recording.ready`,
> phần $0.003/min gần như bằng 0. Mô hình dưới đây **giả định giữ nguyên ~$0.0165/min**
> (thận trọng / conservative); nếu xoá sớm bản Daily, Daily charge tụt ~18% còn
> **~$0.81/giờ**.

Nguồn: [Daily.co Video SDK pricing](https://www.daily.co/pricing/video-sdk/) (truy cập 2026-06-23).

---

## 2. Mô hình kích thước MP4 (MB/phút) — tối ưu cho file nhỏ

File = **H.264 video + AAC audio** (Daily composited MP4). Kích thước ≈
`(video_bitrate + audio_bitrate) / 8` byte mỗi giây.

Công thức nhanh: **MB/phút ≈ tổng_kbps × 60 / 8 / 1000 = tổng_kbps × 0.0075**.

| Cấu hình | Video kbps | Audio kbps | Tổng kbps | **MB/phút** | **MB/giờ** | Dùng cho |
| --- | --- | --- | --- | --- | --- | --- |
| **Audio-only** | 0 | 64 (AAC) | 64 | **0.48** | **~29 MB** | review giọng nói + transcript, canvas qua event-log |
| **480p low** | ~500 | 64 | 564 | **4.2** | **~254 MB** | rẻ nhất có hình; talking-heads + screen mờ vừa đủ đọc |
| **480p (khuyến nghị)** | ~600 | 64 | 664 | **5.0** | **~299 MB** | mặc định "docs only" — cân bằng đọc-được vs nhỏ |
| **720p low** | ~1000 | 96 | 1096 | **8.2** | **~493 MB** | khi cần đọc rõ screen-share/diagram |
| **720p** | ~1500 | 96 | 1596 | **12.0** | **~718 MB** | chất lượng review cao, ít dùng |

> **Quy đổi tròn dùng cho §4 (per recorded-hour):**
> audio-only ≈ **0.03 GB/giờ**; 480p ≈ **0.18 GB/giờ** (làm tròn ~600 kbps tổng,
> bao gồm overhead container); 720p-low ≈ **0.30 GB/giờ**; 720p ≈ **0.50 GB/giờ**.
> Khớp với "ballpark ~0.5–1.5 GB/giờ" của spec §3.4 — đầu thấp của dải đó vì ta
> ép bitrate xuống cho mục đích review/docs, KHÔNG broadcast.

Lưu ý: Daily composited recording mặc định ~chuẩn (cao hơn). Phải **set bitrate/res
thấp** qua tham số recording (`videoBitrate` / preset thấp) lúc start — đây là đòn
bẩy §5. Nếu để mặc định Daily, GB/giờ sẽ ở đầu CAO của dải (~0.5–1+ GB/giờ).

---

## 3. R2 storage — chi phí (đã verify)

| | **Standard** | **Infrequent Access (IA)** |
| --- | --- | --- |
| Storage | **$0.015 / GB-tháng** | **$0.010 / GB-tháng** |
| Class A ops (writes/PUT) | $4.50 / triệu | $9.00 / triệu |
| Class B ops (reads/GET) | $0.36 / triệu | $0.90 / triệu |
| Data retrieval | — (free) | **$0.01 / GB** mỗi lần đọc |
| Min storage duration | — | **30 ngày** (tính đủ 30 ngày dù xoá sớm) |
| Free tier | 10 GB-tháng + 1M Class A + 10M Class B / tháng | **KHÔNG có free tier** |
| Egress (internet) | **Free** | **Free** |

Nguồn: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) (page metadata 2026-05-28, truy cập 2026-06-23).

**Ops gần như miễn phí cho ca này:** mỗi recording = ~1 PUT (Class A) + vài GET
khi review (Class B). Ở quy mô vài trăm cuộc/tháng, ops « $0.01/tháng và **lọt
trọn trong free tier của Standard**. ⇒ Chi phí R2 thực chất chỉ là **GB-tháng**.

**Standard vs IA — phân tích cho recording:**
- IA rẻ hơn **33%** ở storage ($0.010 vs $0.015) nhưng **mất** free 10 GB-tháng,
  cộng **$0.01/GB retrieval** mỗi lần xem và **floor 30 ngày**.
- Recording là dữ liệu **ghi-1-lần, đọc-hiếm** ⇒ đúng hồ sơ IA. Vì retention tối
  thiểu của ta ≥ 30 ngày, floor IA không phạt gì. Retrieval $0.01/GB chỉ ảnh
  hưởng nếu review rất nhiều (1 lần xem file 0.18 GB = $0.0018 — không đáng kể).
- **Khuyến nghị:** **IA cho recordings** (xem §5). Standard chỉ lợi ở dải rất nhỏ
  nhờ 10 GB-tháng free — nhưng 10 GB free đó nên để dành cho dữ liệu hot khác
  (scene/material blobs), không nên "đốt" vào recording lạnh.

---

## 4. Kịch bản sử dụng (usage scenarios)

**Giả định chung:**
- Recording **default OFF** ⇒ chỉ một phần cuộc được ghi (số dưới là **số cuộc THỰC SỰ ghi**, không phải tổng số cuộc họp).
- 1 file MP4 composited / cuộc (đã merge room — spec §3.3). Mọi tham gia viên dự
  KHÔNG nhân chi phí recording.
- Codec H.264+AAC, bitrate ép thấp (§2). GB/giờ theo §2.
- **Steady-state storage** = trung bình dữ liệu nằm trong cửa sổ retention. Với
  lượng nạp đều mỗi tháng và retention R ngày, lượng tích luỹ ổn định ≈
  `GB nạp / tháng × (R / 30)`. (Vd R=90 ⇒ ×3 tháng nạp; R=180 ⇒ ×6.)
- R2 **IA** ($0.010/GB-tháng). Daily recording **$0.0165/min** (giữ bản Daily —
  conservative; xoá sớm ⇒ rẻ hơn ~18%).

### Công thức
```
recorded_min/tháng = số_cuộc × phút_TB
Daily $/tháng      = recorded_min × $0.0165
GB nạp/tháng       = (recorded_min / 60) × GB_per_hour
GB steady-state    = GB nạp/tháng × (retention_ngày / 30)
R2 $/tháng         = GB_steady_state × $0.010   (IA)
Tổng $/tháng       = Daily $/tháng + R2 $/tháng
```

### Kịch bản A — Small (nội bộ, dùng nhẹ)
20 cuộc ghi/tháng × 45 phút · **480p (0.18 GB/giờ)** · retention **90 ngày** · IA.
- recorded_min = 900/tháng ⇒ Daily = 900 × $0.0165 = **$14.85**
- GB nạp = (900/60) × 0.18 = **2.70 GB/tháng**
- Steady-state = 2.70 × 3 = **8.1 GB** ⇒ R2 = 8.1 × $0.010 = **$0.081**
- **Tổng ≈ $14.9 / tháng** (Daily 99.5%, R2 0.5%)

### Kịch bản B — Medium (đa quốc gia, dùng đều)
100 cuộc ghi/tháng × 60 phút · **480p (0.18 GB/giờ)** · retention **90 ngày** · IA.
- recorded_min = 6,000/tháng ⇒ Daily = 6,000 × $0.0165 = **$99.0**
- GB nạp = (6,000/60) × 0.18 = **18.0 GB/tháng**
- Steady-state = 18.0 × 3 = **54 GB** ⇒ R2 = 54 × $0.010 = **$0.54**
- **Tổng ≈ $99.5 / tháng** (Daily 99.5%, R2 0.5%)

### Kịch bản C — Large (mở rộng, retention dài + 720p)
300 cuộc ghi/tháng × 60 phút · **720p-low (0.30 GB/giờ)** · retention **180 ngày** · IA.
- recorded_min = 18,000/tháng ⇒ Daily = 18,000 × $0.0165 = **$297.0**
- GB nạp = (18,000/60) × 0.30 = **90 GB/tháng**
- Steady-state = 90 × 6 = **540 GB** ⇒ R2 = 540 × $0.010 = **$5.40**
- **Tổng ≈ $302.4 / tháng** (Daily 98.2%, R2 1.8%)

> **Quan sát chốt:** R2 storage gần như không bao giờ là vấn đề ở bitrate review.
> **Chi phí Phase 5 ≈ chi phí Daily recording ≈ ~$1/giờ-ghi** (hoặc ~$0.81/giờ nếu
> xoá sớm bản Daily). Muốn giảm tiền ⇒ **giảm SỐ GIỜ GHI**, không phải giảm GB.

---

## 5. Đòn bẩy tối ưu (optimization levers) — định lượng

Xếp theo mức tác động lên **tổng** chi phí Phase 5:

1. **Default OFF / chỉ ghi khi cần (LỚN NHẤT).** Nếu chỉ 30% cuộc cần ghi thay vì
   100%, tổng chi phí giảm **~70%** thẳng. Đây là đòn bẩy mạnh nhất vì Daily charge
   tỉ lệ thẳng với recorded-minute. Spec đã chốt default OFF + gate `recording_enabled`
   + consent banner ⇒ giữ nguyên.
2. **Audio-only khi không cần hình.** Daily **vẫn** tính recording-minute như nhau
   (KHÔNG giảm Daily charge), nhưng:
   - File ~0.03 GB/giờ thay vì 0.18 (480p) ⇒ **R2 giảm ~6×** (đã nhỏ sẵn).
   - Giá trị review chính = **giọng + transcript + canvas-replay** (event-log),
     không phải khuôn mặt ⇒ audio-only thường ĐỦ cho "docs only".
   - ⇒ Lợi chính là **kích thước/đơn giản**, không phải $ Daily. Cân nhắc cho
     cuộc thuần thảo luận; bật hình khi cần screen-share/diagram.
3. **Ép bitrate/res thấp (480p ~600 kbps).** So 720p (0.50 GB/giờ) → 480p (0.18):
   R2 giảm **~64%**. Nhưng vì R2 chỉ là ~0.5–2% tổng, tác động lên TỔNG nhỏ
   (Medium: $0.54 → $0.19, tiết kiệm ~$0.35/tháng). Vẫn nên làm vì "miễn phí" về
   chất lượng review.
4. **IA tier thay Standard.** Storage rẻ hơn **33%**. Trên Medium steady-state 54 GB:
   Standard (sau 10 GB free) = 44 × $0.015 = $0.66 vs IA = 54 × $0.010 = $0.54.
   Chênh nhỏ (~$0.12/tháng) ở quy mô này nhưng đúng hồ sơ dữ liệu lạnh; tỉ lệ
   tiết kiệm tăng theo volume.
5. **Retention ngắn hơn.** Steady-state ∝ retention. 30 ngày thay 90 ⇒ R2 giảm
   **3×**; 90 thay 180 ⇒ giảm **2×**. Lại chỉ tác động phần R2 nhỏ — nhưng retention
   ngắn cũng giảm rủi ro pháp lý/disclosure (xem [[event-log-privacy-analysis]]),
   nên giá trị thực nằm ở **compliance** hơn là tiền.
6. **Canvas qua event-log (KHÔNG quay video canvas).** Đây là quyết định kiến trúc
   đã chốt (spec §3.1 Option c): canvas dựng lại từ scene-versions + transcript +
   chat ⇒ **0 GB video cho phần giá trị nhất của app**. Nếu thay vào đó quay màn
   hình canvas full-HD, GB/giờ sẽ ~3–5× và mất khả năng scrub/diff. ⇒ Giữ nguyên.
7. **Xoá bản Daily sau khi copy về R2.** Cắt $0.003/min storage phía Daily ⇒
   Daily charge $0.0165 → **$0.01349/min** (~**18%** rẻ hơn TỔNG, vì Daily là phần
   chính). Trên Medium: $99.0 → $80.9. **Đáng làm** — pipeline spec §3.3 đã ghi.

### Cấu hình rẻ nhất hợp lý — KHUYẾN NGHỊ "review / docs only"

| Tham số | Giá trị | Lý do |
| --- | --- | --- |
| Trigger | **Default OFF**, host bấm Record, gate `recording_enabled` + consent | đòn bẩy #1 — chỉ trả tiền khi cần |
| Track | **Audio-only mặc định; bật video chỉ khi cần screen/diagram** | giá trị review = giọng+transcript+canvas; file nhỏ ~6× |
| Khi có video | **480p @ ~600 kbps + AAC 64 kbps** | đọc được, ~0.18 GB/giờ |
| Canvas | **event-log replay (không quay video)** | 0 GB cho phần lõi của app |
| R2 tier | **Infrequent Access** | dữ liệu ghi-1-đọc-hiếm; rẻ hơn 33% |
| Retention | **90 ngày** (lifecycle rule trên `recordings/`) | cân bằng review-window vs storage/compliance |
| Sau ghi | **copy về R2 rồi xoá bản Daily** | cắt $0.003/min Daily storage (~18% tổng) |

Với cấu hình này + xoá-sớm-Daily, **Medium tụt còn ≈ $81/tháng** (gần như toàn bộ
là Daily recorded-minute); nếu nhiều cuộc dùng audio-only thì R2 gần như bằng 0.

---

## 6. Bảng tổng hợp (scenario → GB/tháng → $/tháng)

> Giả định: IA tier, **giữ bản Daily** (conservative $0.0165/min). "GB nạp" = thêm
> mỗi tháng; "GB steady" = tích luỹ ổn định trong cửa sổ retention.

| Kịch bản | Cuộc ghi × phút | Res | Retention | GB nạp/tháng | GB steady-state | Daily $/tháng | R2 $/tháng | **Tổng $/tháng** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A — Small** | 20 × 45 | 480p | 90 ngày | 2.7 | 8.1 | $14.85 | $0.08 | **≈ $14.9** |
| **B — Medium** | 100 × 60 | 480p | 90 ngày | 18.0 | 54 | $99.00 | $0.54 | **≈ $99.5** |
| **C — Large** | 300 × 60 | 720p-low | 180 ngày | 90 | 540 | $297.00 | $5.40 | **≈ $302** |

**Biến thể tiết kiệm (áp lên Medium B):**

| Biến thể | Thay đổi | Daily $/tháng | R2 $/tháng | **Tổng** |
| --- | --- | --- | --- | --- |
| B gốc | 480p, giữ Daily | $99.0 | $0.54 | $99.5 |
| B + xoá Daily sớm | $0.01349/min | $80.9 | $0.54 | **$81.5** |
| B + audio-only | 0.03 GB/giờ | $80.9 | $0.09 | **$81.0** |
| B + 30% cuộc thực ghi | 30 cuộc thay 100 | $24.3 | ~$0.03 | **≈ $24.3** |

> **Đọc bảng:** giảm GB hầu như không nhúc nhích tổng; giảm **số giờ ghi** (default
> OFF, chỉ ghi cuộc cần) và **xoá bản Daily** mới là nơi tiền thực sự đổi.

---

## 7. Giả định & cảnh báo (assumptions / caveats)

- **Daily free 10k phút/tháng là participant-minute của CALL** (audio/video), KHÔNG
  áp cho recorded-minute ⇒ recording trả tiền từ phút đầu. Khoản call-minute đã
  tính riêng (Admin Cost tab); doc này chỉ tính **chi phí MỚI = recording + R2**.
- **GB/giờ phụ thuộc bitrate ta SET.** Nếu để Daily composited mặc định (không ép
  bitrate), GB/giờ ở đầu cao của dải (~0.5–1+ GB/giờ) ⇒ R2 ×3–5 (vẫn nhỏ so tổng,
  nhưng đừng quên set preset thấp lúc start recording).
- **Ops R2 bỏ qua được** ở quy mô này (PUT/GET « free-tier Standard / vài cent IA).
- **Steady-state giả định nạp đều.** Tháng đầu chưa đạt steady (ít dữ liệu hơn);
  số GB steady là mức ổn định sau khi đầy cửa sổ retention — dùng cho ngân sách dài hạn.
- **Retrieval IA $0.01/GB** chỉ phát sinh khi review; ở mức review bình thường là
  vài cent/tháng — đã bỏ qua trong bảng. Nếu recording bị xem rất nhiều, cân nhắc
  Standard cho file "hot" gần đây.
- **Một file/cuộc giả định đã merge room** (spec §3.3). Nếu chưa merge mà ghi 2
  room (audio + screen) = **2 file ⇒ 2× recording charge** — phải merge trước Phase 5.
- Giá có thể đổi: **verify lại** Daily & R2 trước khi chốt ngân sách thật.

---

## 8. Nguồn (đã verify 2026-06-23)

- Daily cloud recording $0.01349/recorded-min + $0.003/min storage; free 10,000
  participant-min/tháng; recording tính per-recorded-minute:
  [Daily.co Video SDK pricing](https://www.daily.co/pricing/video-sdk/).
- R2 Standard $0.015/GB-tháng (free 10 GB-tháng), IA $0.010/GB-tháng (no free,
  retrieval $0.01/GB, min 30 ngày), egress free cả hai tier; Class A/B ops như §3:
  [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) (metadata 2026-05-28).
- Cơ sở thiết kế (record-what, pipeline, retention, E2E boundary):
  `docs/specs/video-and-recording.md`; chính sách lưu trữ `docs/runbooks/backup.md`.
