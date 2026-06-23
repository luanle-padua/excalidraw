# Event Log + Chairman — Phân tích rủi ro PHÁP LÝ & RIÊNG TƯ (legal & privacy risk)

**Trạng thái:** RESEARCH / RISK ANALYSIS (2026-06-23) · **KHÔNG có code** · đầu vào cho anh Luân quyết "có/không + làm sao" trước khi bật.

> ⚠️ **MIỄN TRỪ (disclaimer) — đọc trước.** Tôi **không phải luật sư**, đây **không phải tư vấn pháp lý**. Doc này **surface rủi ro thật, có dẫn luật cụ thể** để anh Luân ra quyết định có hiểu biết và biết **hỏi luật sư cái gì**. Trước khi launch (đặc biệt **trước Philippines + khách ngoài**), công ty **phải** xác nhận với **luật sư có chứng chỉ ở từng nước** (KR/VN/PH + EU nếu có khách EU). Doc này thiên về "biết rủi ro nằm ở đâu", không phải "đã an toàn".

Liên quan: `docs/plans/meeting-event-log.md` · `docs/specs/chairman-account.md` · `docs/plans/meeting-package.md` · `docs/plans/ai-project-knowledge-strategy.md` · `docs/plans/guest-data-lifecycle.md`.

---

## 0. TL;DR cho anh Luân (90 giây)

Hai tính năng được phân tích **vượt ranh giới E2E và biến nội dung họp thành server-đọc-được**:
1. **Event Log** (`meeting_event`) — transcript/chat/canvas-text thành **plaintext trong D1**, để AI suy luận "đã xảy ra gì + vì sao".
2. **Chairman account** — **giám sát ẩn (stealth) toàn org**, kể cả **1:1 / HR / confidential**, cộng **AI chấm hành vi từng nhân viên**.

**Mức rủi ro (thấp → cao):**

| | Nội bộ KR/VN, có thông báo | Đa quốc gia + Phi | Khách ngoài (B2B) | EU clients |
|---|---|---|---|---|
| Event Log (content server-readable + AI summary) | **Trung bình** (cần notice + lawful basis) | Trung bình–Cao | **Cao** (anh xử lý data người khác) | **Cao** |
| Chairman stealth + AI behavioral scoring | **CAO** | **RẤT CAO** | **RẤT CAO / tránh** | **Có khả năng vi phạm** |

**3–4 rủi ro lớn nhất:**
- **(R1) Giám sát NGẦM (covert/"tàng hình") nhân viên là bất hợp pháp ở cả 3 nước.** Korea: PIPA đòi consent opt-in + thông báo; giám sát ngầm **chỉ hợp pháp trong điều tra hình sự**. Philippines: NPC đã **bác giám sát không công bố** (Advisory Opinion 2018-084). Vietnam PDPL 2025: xử lý phải có **đồng ý rõ ràng + thông báo**. "Stealth/tàng hình" của Chairman đụng thẳng vào đây.
- **(R2) AI chấm điểm hành vi/HR từng người = automated decision-making + profiling, nhóm rủi ro cao nhất.** Korea PIPA **Điều 37-2** (hiệu lực 03/2024) cho data subject quyền về quyết định tự động; PIPC ra hướng dẫn riêng nêu **employee monitoring + hiring** làm ví dụ. GDPR **Điều 22** + **DPIA bắt buộc** (Điều 35(3)(a)) cho "đánh giá có hệ thống về con người". `chairman_insight` (sentiment/engagement/influence per-person) rơi đúng vào đây.
- **(R3) Ghi âm/đọc lại cuộc 1:1 & HR mà không có cơ sở rõ → Korea hình sự hoá.** **Protection of Communications Secrets Act Điều 3**: ghi/nghe lén hội thoại riêng tư = **tù 1–10 năm**. Cộng PIPA: HR/sức khoẻ/công đoàn/tư tưởng = **sensitive data** đòi **separate explicit consent**.
- **(R4) Cross-border consolidation lên Cloudflare chưa có cơ chế hợp lệ.** Vietnam PDPL 2025: transfer ra ngoài cần **hồ sơ đánh giá tác động nộp Bộ Công an**; phạt tới **5% doanh thu**. Korea: transfer cần **consent riêng cho việc chuyển ra nước ngoài** hoặc SCC/chứng nhận. PH: cần hợp đồng + accountability.

**Việc QUAN TRỌNG NHẤT phải làm trước khi ship:** **bỏ chế độ "stealth/tàng hình" như một thuộc tính sản phẩm, thay bằng GIÁM SÁT CÓ CÔNG BỐ** — đăng policy giám sát + AI analysis trong nội quy/ToS/onboarding, được người dùng acknowledge, **TRƯỚC** khi bất kỳ nội dung nào thành server-readable hay bị AI chấm. Không có cái này thì cả Event Log lẫn Chairman đều đứng trên nền pháp lý mong manh.

**Khuyến nghị bottom-line:** **Internal-first, có công bố.** Bật Event Log nội bộ (KR/VN) **sau khi** có notice + lawful basis + retention. **Hoãn Chairman behavioral-scoring** cho tới khi có DPIA + tư vấn lao động từng nước. **Trước Philippines & khách ngoài:** cần consent/DPA/transfer-mechanism riêng — đây là cổng pháp lý, không phải bước kỹ thuật.

---

## 1. Nội dung họp thành server-readable + AI xử lý — consent, mục đích, lawful basis

### 1.1 Điều gì thực sự thay đổi về mặt pháp lý

Hôm nay nội dung họp **E2E** (server relay bytes, không đọc) → công ty ở vị thế gần "data conduit". Khi Event Log/Package/Chairman **client-decrypt-rồi-POST-plaintext**, công ty trở thành **controller chủ động xử lý nội dung họp** (transcript = lời nói có thể nhận dạng người → **personal data**; có thể chứa **sensitive data**: sức khoẻ, đánh giá nhân sự, quan điểm). Mọi nghĩa vụ controller (lawful basis, notice, minimization, retention, DSAR) **bật lên** từ thời điểm đó.

### 1.2 Korea — PIPA (개인정보 보호법)

- **Lawful basis + consent:** PIPA truyền thống nặng về **consent opt-in** (freely given, specific, informed, unambiguous, affirmative act). Sửa đổi 2023 + Enforcement Decree (hiệu lực 15/09/2024) mở thêm **legitimate interest** nhưng đòi 3-bước test (legitimacy of purpose · necessity · balancing) và **không thay được consent cho sensitive/HR**. ([Kim & Chang](https://www.kimchang.com/en/insights/detail.kc?sch_section=4&idx=30360), [PIPA English text](https://elaw.klri.re.kr/eng_service/lawView.do?hseq=53044&lang=ENG))
- **Sensitive information** (tư tưởng, công đoàn, chính trị, **sức khoẻ**, sinh trắc, đời sống tình dục): **separate explicit consent** trừ khi luật cho phép. Họp HR/đánh giá rất dễ chạm. ([DLA Piper KR](https://www.dlapiperdataprotection.com/index.html?t=law&c=KR))
- **Phạt:** tới **100 triệu KRW** và/hoặc **tù tới 10 năm** cho vi phạm nặng; bản sửa 2023 gắn fine với **CEO accountability**. ([IAPP](https://iapp.org/news/a/south-korea-overhauls-pipa-and-ties-fines-to-ceo-accountability))

→ **Cần gì:** thông báo rõ (mục đích: tổng kết/AI reasoning điều hành) + lawful basis cho mỗi mục đích; **consent riêng** nếu chạm sensitive; **không** dựa legitimate interest cho HR/behavioral.

### 1.3 Philippines — Data Privacy Act 2012 (RA 10173) + NPC

- **Consent** phải **time-bound, freely given, specific, informed**; NPC cảnh báo consent gắn incentive tài chính dễ bị thách thức. ([NPC](https://privacy.gov.ph/data-privacy-act/), [IAPP summary](https://iapp.org/news/a/summary-philippines-data-protection-act-and-implementing-regulations))
- **AI phân tích nội dung để đánh giá nhân viên:** NPC **Advisory Opinion 2024-005** cho phép AI autoscore call/email **NHƯNG** đòi **proportionality + transparency + legitimate purpose**, **chỉ xử lý cái cần thiết**, và **nhân viên phải được báo qua privacy policy**. ([L&E Global PH](https://leglobal.law/2026/05/29/philippines-employee-monitoring-and-the-right-to-privacy-key-considerations-under-the-data-privacy-act-of-2012/))

→ Event Log + AI summary **khả thi ở PH** nếu có privacy policy công bố + minimization. Vấn đề **không** phải "AI đọc nội dung" mà là **bí mật + không tương xứng**.

### 1.4 Vietnam — PDPL 2025 (Luật 91/2025/QH15) + Decree 356, **hiệu lực 01/01/2026** (thay Decree 13)

- **Consent** phải **rõ ràng, tự nguyện, affirmative**; data subject phải biết **loại data · mục đích · ai xử lý · quyền của mình**. ([Hogan Lovells](https://www.hoganlovells.com/en/publications/vietnam-enacts-landmark-law-on-personal-data-protection-stable-standing-with-stricter-compliance), [Rouse](https://rouse.com/insights/news/2025/vietnam-s-new-personal-data-protection-law-what-businesses-need-to-know))
- **Phạt:** tới **VND 3 tỷ (~$115k)** cho phần lớn vi phạm; **5% doanh thu** cho vi phạm cross-border; tới **10× lợi bất chính** nếu mua/bán data. ([DFDL](https://www.dfdl.com/insights/legal-and-tax-updates/vietnam-personal-data-protection-2026-what-foreign-organizations-need-to-know/))

> **Lưu ý quan trọng:** Team note còn ghi "Decree 13/2023". Tính tới **01/01/2026 Decree 13 đã bị thay** bởi **PDPL 2025 + Decree 356** — chuẩn cao hơn, phạt nặng hơn. **Phải brief lại theo luật mới.** Team dev ở VN → nội dung họp dev nội bộ cũng là data subject VN.

### 1.5 GDPR-style (nếu có khách EU)

- **Purpose limitation · data minimization · storage limitation** (Điều 5). "Giữ full history làm moat" (xem §5) **xung đột trực tiếp** với minimization + storage limitation.
- **Profiling/automated decision-making** (Điều 22) — xem §2.4. **DPIA bắt buộc** cho đánh giá hành vi có hệ thống (Điều 35(3)(a)). ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/rights-related-to-automated-decision-making-including-profiling/))

### 1.6 Mẫu số chung (cả 4 regime)

1. **Notice/transparency là tối thiểu phổ quát** — mọi nước đòi báo trước mục đích + phạm vi. **Stealth phá điều này.**
2. **Consent cho nội dung thường + sensitive khác nhau** — HR/sức khoẻ cần **explicit/separate**.
3. **Purpose limitation + minimization** — chỉ thu cái cần cho mục đích đã công bố; "ghi tất cả để sau này dùng" là anti-pattern.
4. **Lawful basis ≠ chỉ consent** — legitimate interest dùng được cho giám sát công việc *có công bố + tương xứng*, **không** cho behavioral/HR profiling ngầm.

---

## 2. GIÁM SÁT NHÂN VIÊN / WORKPLACE MONITORING — vùng rủi ro cao nhất

> Đây là chỗ Chairman (`chairman-account.md` §2 stealth + §3 AI behavioral + §4.5 "quyền tối thượng kể cả 1:1/HR") **đụng luật nặng nhất**. Nói thẳng từng nước.

### 2.1 Korea — giám sát NGẦM gần như chắc bất hợp pháp

- **PIPA:** thu thập/dùng personal info của nhân viên cần **prior consent** trừ ngoại lệ luật định; consent phải **affirmative opt-in**. → **Giám sát ngầm không thông báo + không consent ⇒ vi phạm PIPA.** ([Pandectes](https://pandectes.io/blog/an-overview-of-south-koreas-personal-information-protection-act-pipa/), [Ground Labs](https://groundlabs.com/blog/south-koreas-privacy-laws-introducing-pipa))
- **Giám sát bí mật chỉ hợp pháp trong điều tra hình sự có phê chuẩn.** Ngoài ra **không được**. ([Practical Law — Employee Monitoring South Korea](https://uk.practicallaw.thomsonreuters.com/w-015-5010))
- **Protection of Communications Secrets Act, Điều 3:** ghi/nghe lén **hội thoại riêng tư giữa người khác** = **tù 1–10 năm**. Chairman đọc lại transcript 1:1 mà nhân viên không biết → rủi ro hình sự, không chỉ hành chính. ([search KR comms-secrets](https://www.koreaherald.com/article/3287514))
- **Works-council / labor-management council:** lắp giám sát (vd CCTV ghi nhân viên) phải **tham vấn labor-management council**; thay đổi nội quy bất lợi cho NLĐ cần **consent công đoàn / đa số NLĐ** (Labour Standards Act). Giám sát hành vi + AI scoring = thay đổi điều kiện làm việc bất lợi ⇒ nhiều khả năng **phải tham vấn**. ([Ius Laboris KR](https://iuslaboris.com/insights/korea-employees-covering-cameras/), [OECD AI & labour KR](https://www.oecd.org/en/publications/artificial-intelligence-and-the-labour-market-in-korea_68ab1a5a-en/full-report/overview_ad148dd1.html))
- **Quyết định tự động (AI):** **PIPA Điều 37-2** (hiệu lực 03/2024) + **PIPC "Guidelines on Rights of Data Subjects in Automated Decisions"** (09/2024) **lấy employee monitoring + hiring làm ví dụ** → nhân viên có quyền **được giải thích + từ chối/yêu cầu người can thiệp** với quyết định AI. ([Baker McKenzie KR](https://resourcehub.bakermckenzie.com/en/resources/global-data-and-cyber-handbook/asia-pacific/south-korea/topics/data-processing-in-the-employment-context))

→ **Kết luận KR:** "tàng hình + AI chấm người" là **combo rủi ro cao nhất**: PIPA (consent/notice), Comms-Secrets (hình sự với 1:1), Labour Standards (tham vấn council), Điều 37-2 (quyền về quyết định tự động).

### 2.2 Philippines — covert bị NPC bác thẳng

- **NPC Advisory Opinion 2018-084:** phần mềm ghi **keystroke + chụp màn hình ngẫu nhiên** mà **không công bố** = **excessive** và vi phạm; NPC yêu cầu **có policy thông báo NLĐ**. → **Covert monitoring vi phạm transparency.** ([L&E Global PH](https://leglobal.law/2026/05/29/philippines-employee-monitoring-and-the-right-to-privacy-key-considerations-under-the-data-privacy-act-of-2012/))
- **Có công bố thì OK:** Section 12(b) (hợp đồng LĐ ghi rõ) hoặc 12(f) (legitimate interest) + **transparency + proportionality + legitimate purpose**. AI autoscore được phép (AO 2024-005) **nếu báo qua privacy policy**.

→ **Kết luận PH:** giám sát + AI **được**, **stealth thì không**. Khác biệt sống-còn = **công bố**.

### 2.3 Vietnam — chưa có án lệ giám sát, nhưng PDPL 2025 đòi consent + notice + minimization

- Không có quy chế "employee monitoring" riêng, nhưng **PDPL 2025** áp nguyên tắc chung: xử lý cần **đồng ý rõ ràng + thông báo mục đích/loại data/quyền**. Giám sát hành vi ngầm khó thoả "rõ ràng + tự nguyện + biết mục đích". Phạt nặng (§1.4). ([Baker McKenzie VN](https://connectontech.bakermckenzie.com/vietnam-decoding-vietnams-pdp-law-gdpr-inspired-rules-with-local-twists/))

→ **Kết luận VN:** mặc định an toàn = **công bố + consent**; tránh ngầm.

### 2.4 AI chấm hành vi = profiling / automated decision — tầng rủi ro riêng

`chairman_insight` per-person (sentiment, engagement, influence, "blocked decision X") + cross-person trend (`chairman-account.md` §3.3) = **profiling đánh giá performance/behaviour**:
- **GDPR Điều 22 + định nghĩa profiling** (phân tích/dự đoán performance, reliability, behaviour at work). Nếu insight dẫn tới quyết định nhân sự ⇒ rơi vào Điều 22; **DPIA bắt buộc** (Điều 35(3)(a)); SCHUFA (C-634/21) kéo cả "scoring ảnh hưởng quyết định người" vào. ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/rights-related-to-automated-decision-making-including-profiling/))
- **Korea Điều 37-2** — như §2.1, employee monitoring là ví dụ điển hình.
- **PH AO 2024-005** — cho phép autoscore nhưng **proportionality + privacy policy**; "engagement score 3/10" dễ thành **excessive**.

> `chairman-account.md` §4.7 đã tự cảnh báo "pattern thay vì dossier cá nhân" — **đúng hướng pháp lý**. Cần **biến thành ràng buộc cứng**, không chỉ gợi ý prompt.

---

## 3. Cuộc họp confidential + "quyền tối thượng" của Chairman

`chairman-account.md` §4.5 (CHỐT 06-17): Chairman thấy **MỌI** cuộc kể cả **confidential / 1:1 / HR / kỷ luật**, **không tier nào chặn**. Phân tích:

- **Đây là điểm phơi nhiễu pháp lý tập trung nhất.** 1:1/HR/kỷ luật = nơi tập trung **sensitive data** (sức khoẻ, đánh giá, có thể công đoàn/khiếu nại). Đọc lại **ngầm** chồng đúng 3 rủi ro KR ở §2.1 (PIPA sensitive + Comms-Secrets hình sự + Labour council) và transparency PH/VN.
- **"Không loại trừ" làm hỏng data minimization + purpose limitation** ở mọi regime: AI/Chairman truy cập **vượt nhu cầu cần thiết** cho mục đích công bố.
- **Đối trọng hiện tại (`chairman_audit` + ít người + consent công khai) là cần nhưng CHƯA đủ** về luật: audit-after-the-fact giúp accountability **nhưng không tạo lawful basis** cho việc đọc ngầm sensitive content. Audit trị "ai lạm quyền", không trị "việc này có được phép không".
- **Carve-out tối thiểu nên cân nhắc (hỏi luật sư):** loại HR/1:1/grievance ra khỏi tầm AI-behavioral mặc định; nếu Chairman cần xem, đi qua **break-glass có lý do + thông báo tồn tại quyền này trong policy** (không cần lộ từng lần, nhưng **sự tồn tại** của quyền phải công bố). "Nhân viên có thể không biết *khi nào* bị xem, nhưng phải biết *rằng* có thể bị xem" — đây là lằn ranh giữa hợp pháp và covert.

---

## 4. Chuyển dữ liệu xuyên biên giới (cross-border transfer)

Nội dung tạo ở **KR/VN/PH + khách ngoài** gom về **Cloudflare D1/R2** (hạ tầng ngoài các nước này) = **cross-border transfer** cho mỗi regime.

- **Vietnam (gắt nhất):** PDPL 2025 (kế thừa Decree 13) coi **xử lý data công dân VN bằng hệ thống tự động đặt ngoài VN** = transfer ⇒ **bao trùm cloud**. Cần **hồ sơ đánh giá tác động chuyển dữ liệu** nộp **Bộ Công an (A05)** + consent + nêu recipient/quốc tịch + retention + hợp đồng ràng buộc. Phạt cross-border tới **5% doanh thu**. ([DLA Piper VN](https://www.dlapiper.com/en-us/insights/publications/crossroads-icr-insights/2023/vietnam-decree-13-and-the-new-regulations-on-personal-data-protection), [ITIF](https://itif.org/publications/2025/06/09/vietnam-cross-border-data-transfer-regulation/))
- **Korea:** transfer ra nước ngoài cần **consent riêng cho việc chuyển** *hoặc* nước nhận có **chứng nhận PIPC / được công nhận adequate** *hoặc* **SCC/safeguards**. ISMS-P là bước củng cố. ([DLA Piper KR transfer](https://www.dlapiperdataprotection.com/?t=transfer&c=KR), [Korea Business Hub](https://www.koreabusinesshub.kr/blog/pipa-compliance-cross-border-data-2026))
- **Philippines:** controller giữ **accountability** xuyên biên giới — cần hợp đồng/biện pháp đảm bảo recipient bảo vệ tương đương. ([NPC Data Privacy Manual](https://peace.gov.ph/wp-content/uploads/2024/01/DATA-PRIVACY-MANUAL_FINAL5.pdf))
- **EU clients:** cần cơ chế transfer GDPR (SCC) nếu data rời EEA.

→ **Hệ quả thực dụng:** **Cloudflare region/locality data** (data residency) + **DPA với Cloudflare (sub-processor)** + **transfer impact docs cho VN** trở thành **bắt buộc** trước khi gom data đa nước. Đây là việc của Luân/ops, không né được bằng kỹ thuật app.

---

## 5. Retention — TTL cho plaintext + behavioral inference, vs "revoke ≠ delete / giữ làm moat"

**Xung đột trực diện** giữa:
- **Stance của team:** `guest-data-lifecycle.md` "revoke ≠ delete, KHÔNG hard-delete, giữ full history làm moat" + AI strategy "data cuộc họp là mỏ vàng, giữ để compound".
- **Luật:** **storage limitation + right to erasure**. GDPR Điều 17 (xoá), Điều 5 (chỉ giữ khi cần). PIPA đòi **huỷ khi hết mục đích**. VN PDPL cho data subject quyền **xoá/rút consent**. PH cho quyền erasure/blocking.

**Hướng hoà giải (ưu tiên giảm dần):**
1. **Tách "moat" khỏi "personal data".** Phần compound được phép giữ lâu nên là **CRAFT/pattern content-free** (đúng split của AI strategy addendum): ontology, glossary, quy ước, pattern ẩn danh hoá — **không phải transcript thô / dossier cá nhân**. Cái này né được phần lớn erasure.
2. **TTL có hạn cho plaintext content + behavioral inference.** `meeting_event` content (transcript/chat plaintext) + `chairman_insight` per-person = **nhạy nhất** → đặt TTL (vd content N tháng, behavioral inference ngắn hơn) + auto-purge, trừ khi pin có lý do hợp pháp. `meeting-event-log.md` §4.3 và `chairman-account.md` §4.6 đã nêu hướng này — **biến thành policy cứng gắn `d1-retention.md`**.
3. **"Revoke ≠ delete" giữ được CHỈ KHI** có lawful basis độc lập với consent (vd nghĩa vụ pháp lý/legitimate interest đã cân bằng) **và** vẫn tôn trọng erasure request hợp lệ. Với **khách ngoài**, "giữ vĩnh viễn vì moat" **không** là lawful basis — rủi ro cao. Mặc định: revoke = mất truy cập + vào hàng đợi purge theo TTL, **không** giữ plaintext cá nhân vô hạn.
4. **Phân biệt nội bộ vs khách:** nội bộ (lao động) có thể giữ lâu hơn theo nghĩa vụ HR/legitimate interest *có công bố*; **khách ngoài thì hợp đồng (DPA) chi phối** + thường đòi xoá khi hết hợp đồng.

---

## 6. Khuyến nghị — kế hoạch ưu tiên hoá

### 6.1 Việc PHẢI làm TRƯỚC khi bật bất cứ thứ gì (P0 — pháp lý nền)

1. **Bỏ "stealth/tàng hình" làm thuộc tính sản phẩm; chuyển sang GIÁM SÁT CÓ CÔNG BỐ.** Đăng **policy giám sát + AI analysis** trong **nội quy lao động / onboarding / ToS**, người dùng **acknowledge** trước khi nội dung thành server-readable hoặc bị AI chấm. *Stealth có thể giữ nghĩa "participant không thấy từng lần xem", nhưng SỰ TỒN TẠI của quyền giám sát + AI behavioral PHẢI công bố.* — **đây là việc số 1.**
2. **Phân loại lawful basis theo loại cuộc:** nội dung họp thường (legitimate interest *có công bố* hoặc consent) vs **HR/1:1/sensitive** (**explicit/separate consent**, hoặc loại khỏi AI behavioral).
3. **DPIA** cho Chairman behavioral + Event Log (bắt buộc kiểu GDPR; thực hành tốt cho KR Điều 37-2 / PH proportionality). Có **human-in-the-loop** cho mọi quyết định nhân sự dựa trên insight (Điều 22 / 37-2).
4. **Cross-border:** ký **DPA với Cloudflare**, cân nhắc **data locality**, chuẩn bị **transfer impact dossier cho VN** + cơ chế transfer KR (consent/SCC/cert).
5. **Retention policy cứng** (gắn `d1-retention.md`): TTL cho `meeting_event` content + `chairman_insight`; quy trình erasure/DSAR; tách moat = CRAFT content-free.

### 6.2 Opt-in / cấu hình (P1)

- **Event Log content = opt-in ở cấp tổ chức/dự án**, có banner khi tạo cuộc ("Cuộc họp này được ghi & có thể được phân tích bởi AI").
- **AI behavioral per-person = opt-in riêng, mặc định TẮT**, và **mặc định loại HR/1:1/grievance**.
- **Confidential meeting:** AI behavioral **không** chạy mặc định; Chairman xem = **break-glass có lý do + ghi `chairman_audit`**.

### 6.3 NÊN TRÁNH

- **Covert/stealth monitoring không công bố** — bất hợp pháp KR/PH, rủi ro cao VN. (Bỏ, hoặc đổi thành "ẩn ở mức UI nhưng công bố ở mức policy".)
- **AI chấm điểm tuyệt đối hoá con người** ("engagement 3/10") dùng cho nhân sự **không có human review** — Điều 22/37-2.
- **Đọc lại ngầm 1:1/HR ở Korea** — rủi ro hình sự (Comms-Secrets Act).
- **Giữ plaintext cá nhân/dossier vô thời hạn "làm moat"**, nhất là **khách ngoài**.

### 6.4 Checklist "safe to ship" theo phase

**A. Internal-only (KR/VN), rủi ro THẤP-TRUNG — bật được sớm nếu:**
- [ ] Policy giám sát + AI công bố, NLĐ acknowledge (onboarding/nội quy).
- [ ] Lawful basis xác định/loại cuộc; sensitive/HR có consent riêng hoặc loại khỏi AI.
- [ ] (KR) Cân nhắc tham vấn **labor-management council** cho giám sát + AI scoring.
- [ ] Retention/TTL + DSAR vận hành.
- [ ] Event Log: bật content + AI summary nội bộ. **Chairman behavioral: HOÃN tới khi có DPIA + tư vấn lao động.**

**B. Đa quốc gia + Philippines, rủi ro TRUNG-CAO — thêm:**
- [ ] Privacy policy PH (transparency + proportionality, theo NPC AO 2024-005/2018-084).
- [ ] (VN) Transfer impact dossier + cơ chế cross-border; brief lại theo **PDPL 2025** (không phải Decree 13).
- [ ] Localize notice/consent từng nước (KR/VN/PH).

**C. Khách ngoài (B2B) + EU, rủi ro CAO — thêm:**
- [ ] **DPA với từng khách** (ai controller/processor); transfer mechanism (SCC cho EU).
- [ ] Cam kết retention/erasure trong hợp đồng (override "moat" cho data khách).
- [ ] **Chairman cross-org KHÔNG đụng data khách ngoài** trừ khi hợp đồng cho phép minh thị — mặc định **không**.
- [ ] DPIA cập nhật cho profiling đa khách.

### 6.5 Hỏi luật sư cái gì (mua tư vấn đúng chỗ)

1. **(KR)** Đọc lại transcript 1:1/HR ngầm — có chạm **Communications Secrets Act Điều 3** (hình sự) không? Giám sát + AI scoring có cần **labor-management council**/consent công đoàn không? Điều 37-2 áp ra sao cho `chairman_insight`?
2. **(PH)** Mô hình notice + AI autoscore của ta có thoả **proportionality + AO 2024-005** không? Cần gì trong privacy policy?
3. **(VN)** PDPL 2025 + Decree 356: nghĩa vụ transfer impact + consent cụ thể cho consolidation lên Cloudflare? Phạt 5% áp thế nào?
4. **(EU, nếu có khách)** Chairman behavioral có vi phạm **Điều 22** không? DPIA scope?
5. **(All)** "Revoke ≠ delete / moat" hoà giải với storage limitation + erasure tới đâu cho **nội bộ** vs **khách**?

---

## 7. Nguồn (web, truy 2026-06-23)

**Korea PIPA / monitoring:**
- PIPA English text — https://elaw.klri.re.kr/eng_service/lawView.do?hseq=53044&lang=ENG
- Kim & Chang, consent guidelines 2024 — https://www.kimchang.com/en/insights/detail.kc?sch_section=4&idx=30360
- IAPP, PIPA overhaul + CEO accountability — https://iapp.org/news/a/south-korea-overhauls-pipa-and-ties-fines-to-ceo-accountability
- DLA Piper Korea — https://www.dlapiperdataprotection.com/index.html?t=law&c=KR
- Practical Law, Employee Monitoring (South Korea) — https://uk.practicallaw.thomsonreuters.com/w-015-5010
- Ius Laboris, Korea workplace surveillance / council — https://iuslaboris.com/insights/korea-employees-covering-cameras/
- Baker McKenzie, KR data in employment (Art. 37-2, automated decisions) — https://resourcehub.bakermckenzie.com/en/resources/global-data-and-cyber-handbook/asia-pacific/south-korea/topics/data-processing-in-the-employment-context
- OECD, AI & Labour Market in Korea — https://www.oecd.org/en/publications/artificial-intelligence-and-the-labour-market-in-korea_68ab1a5a-en/full-report/overview_ad148dd1.html
- DLA Piper, KR transfer — https://www.dlapiperdataprotection.com/?t=transfer&c=KR
- Korea Business Hub, PIPA cross-border 2026 — https://www.koreabusinesshub.kr/blog/pipa-compliance-cross-border-data-2026
- Korea Herald, recording as evidence (Comms-Secrets Act) — https://www.koreaherald.com/article/3287514

**Philippines DPA / NPC:**
- L&E Global, PH employee monitoring (AO 2018-084, 2024-003, 2024-005) — https://leglobal.law/2026/05/29/philippines-employee-monitoring-and-the-right-to-privacy-key-considerations-under-the-data-privacy-act-of-2012/
- NPC, Data Privacy Act — https://privacy.gov.ph/data-privacy-act/
- IAPP, PH DPA summary — https://iapp.org/news/a/summary-philippines-data-protection-act-and-implementing-regulations
- NPC Data Privacy Manual — https://peace.gov.ph/wp-content/uploads/2024/01/DATA-PRIVACY-MANUAL_FINAL5.pdf

**Vietnam PDPL 2025 / Decree 13:**
- Hogan Lovells, VN PDPL — https://www.hoganlovells.com/en/publications/vietnam-enacts-landmark-law-on-personal-data-protection-stable-standing-with-stricter-compliance
- Rouse, VN new PDP Law — https://rouse.com/insights/news/2025/vietnam-s-new-personal-data-protection-law-what-businesses-need-to-know
- DFDL, VN PDP 2026 (fines) — https://www.dfdl.com/insights/legal-and-tax-updates/vietnam-personal-data-protection-2026-what-foreign-organizations-need-to-know/
- DLA Piper, Decree 13 — https://www.dlapiper.com/en-us/insights/publications/crossroads-icr-insights/2023/vietnam-decree-13-and-the-new-regulations-on-personal-data-protection
- ITIF, VN cross-border transfer — https://itif.org/publications/2025/06/09/vietnam-cross-border-data-transfer-regulation/
- Baker McKenzie, VN PDP law — https://connectontech.bakermckenzie.com/vietnam-decoding-vietnams-pdp-law-gdpr-inspired-rules-with-local-twists/

**GDPR (EU clients):**
- ICO, automated decision-making & profiling (Art. 22, SCHUFA C-634/21) — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/rights-related-to-automated-decision-making-including-profiling/
