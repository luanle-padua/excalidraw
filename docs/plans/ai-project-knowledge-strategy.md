# Chiến lược AI cho Canvas M — Bộ nhớ dự án theo chuỗi cuộc họp

> Chốt 2026-06-15 bởi team 5 agent (4 lăng kính: kiến trúc KB · chuỗi-reasoning · stress-test "1 model" vs bảo mật · lộ trình+chi phí → 1 tổng hợp). Yêu cầu gốc của anh Luân: AI hiểu **chuỗi cuộc họp** + reasoning → dựng **knowledge base cho dự án theo thời gian** → admin tổng hợp để "train 1 model".

## Định khung lại (quan trọng nhất)

**Mình KHÔNG "train một con AI".** Mình dựng **bộ nhớ dự án có truy hồi (retrieval-grounded)** trên dữ liệu đã có sẵn — các bản **tóm tắt cuộc họp**. Mọi thứ nằm trong dữ liệu mình kiểm soát (D1 + R2), **không nhồi vào trọng số model**. Cái này rẻ hơn, cập nhật tức thì khi họp xong, trích dẫn được, và **không bao giờ nướng dữ liệu mật vào weights không gỡ ra được**.

## Kiến trúc: 3 "tài sản sống" mỗi dự án

1. **Bản tóm tắt cuộc họp** (đã có) — mỗi cuộc họp xong ghi 1 text bất biến, server đọc được, trong D1, gắn `project_id`. **Đây là nguyên tử của bộ nhớ** — mọi thứ build từ đây.
2. **Bản tóm lược dự án cuộn (rolling brief)** (mới, là điểm nhấn) — 1 tài liệu sống/dự án: _Quyết định tới nay · Việc còn mở (kèm chủ trì + trạng thái) · Hướng thiết kế hiện tại · Thuật ngữ · Rủi ro_. Mỗi cuộc họp xong → **1 lần gọi Claude** gộp tóm tắt cuộc đó vào brief. Đây chính là "chuỗi" + "KB lớn dần" được cụ thể hoá.
3. **"Hỏi-dự-án" (Ask-this-project)** (mới) — ô hỏi: ai trong dự án hỏi gì → server đưa các tóm tắt + brief của dự án đó cho Claude → trả lời **kèm trích dẫn cuộc họp cụ thể**.

**Transcript đầy đủ vẫn E2E-mã hoá trong R2** làm chi-tiết-khi-cần — KHÔNG đụng (xem căng thẳng cuối).

## Chuỗi vận hành thế nào — "mang sang", không đọc lại

Khi cuộc họp N xong (ngay sau chỗ ghi summary, `worker/src/index.ts` ~1368):

1. Lấy brief hiện tại của dự án.
2. **1 lần gọi Claude**: "đây là brief + tóm tắt cuộc mới → trả về brief đã cập nhật: gộp quyết định mới, đóng việc đã xong, ghi cái gì đổi."
3. Lưu brief mới vào D1; snapshot brief cũ ra R2 (`project-brief/{projectId}/{ts}.md`) để **luôn dựng lại + audit được**.

→ Chi phí **O(1)/cuộc họp** (gộp 1 delta, không xử lại lịch sử). Cuộc N mở ra là bot đã "biết" cuộc N-1 để đâu, vì N-1 đã gấp delta vào brief.

**Quyết định prose vs ledger:** bắt đầu bằng **brief văn xuôi** (gọn ~3-6k token, mỗi quyết định ghi rõ từ cuộc nào) — 80% giá trị, ít phức tạp. **Chỉ thêm hàng action-item có cấu trúc** (chủ trì/trạng thái/hạn — thứ user thật sự muốn dạng danh sách + checkbox). Hoãn ledger quyết-định-có-ID tới khi prose chứng minh không trả lời nổi "cái gì đã đổi".

## "1 model của admin" thực ra là gì — KHÔNG fine-tune

**Câu trả lời thẳng: đừng fine-tune.** "Train 1 model trên mọi thứ" sai trên mọi trục quan trọng ở đây:

- **Gần như không mua được như tưởng tượng** — Anthropic API là Claude host chung + prompt/caching; **không có** sản phẩm "upload mọi cuộc họp → ra Claude riêng của mình".
- **Phá đúng ràng buộc khó nhất của mình** — model học cả Dept A + Dept B sẽ nướng cả hai vào weights → user Dept B moi được fact Dept A qua kênh mà Worker authz **không thấy/chặn/thu hồi được**. Fine-tune **xoá bức tường phòng ban** mình dựng cả access model để giữ.
- **Cũ + đắt** — cuộc hôm qua chưa "ở trong" model tới lần retrain tốn kém sau. Retrieval gộp nó tức thì, vài xu.

**Cái admin thật sự cần (và nên có):** đúng trợ lý "Hỏi-dự-án" đó, **bỏ filter phòng ban, chỉ admin, audit đầy đủ** (theo đúng pattern admin-stealth + bắt-buộc-audit sẵn có). Tức **"1 AI biết tất cả" = 1 Claude chung + phạm vi truy hồi mở rộng cho admin.** Trí tuệ là xuyên-dự-án; bảo mật vẫn theo-phòng-ban vì ranh giới là **filter truy vấn enforce được**, không phải hy vọng weights nhớ gì.

> Nói gọn cho anh Luân: **"train trên mọi thứ" = "cho admin query xuyên mọi thứ".** Cùng 1 model, mở rộng phạm vi đọc.

## Lộ trình (MVP trước)

- **Phase 0 — tuần này (~1-2 ngày). Làm chắc nền.** Đổi summary từ Gemini → **Claude Haiku (mới nhất)** (1 giờ transcript ~8-15k token, dưới 1 xu/cuộc); giữ schema JSON. **Quan trọng: vá summary fire-and-forget** — hiện gọi fail là **mất summary vĩnh viễn** (audit #13). Thêm retry + cờ. Cả KB dựng trên artifact này → phải bền.
- **Phase 1 — kế (~1 tuần). Demo bán được ý tưởng: "Hỏi dự án này bất cứ gì."** Nối các `ai_summary` (đã gate phòng ban) của 1 dự án vào **1 prompt Claude Sonnet** → trả lời kèm trích dẫn. **Không embeddings, không vector DB, không RAG** — 30 tóm tắt × ~1k token thừa sức. Vài xu/câu. Đã đủ "hiểu chuỗi" + "reason xuyên cuộc họp" cho ~90% câu thật.
- **Phase 1.5 — rồi (~vài ngày). Rolling brief + hàng action-item.** Như mục trên. Đây là "KB lớn dần", hiện ngay trên trang dự án Glass Desk.
- **Phase 2 — chỉ khi cần. RAG cấp transcript (Cloudflare Vectorize).** Thêm **chỉ khi** user kêu "summary thiếu chi tiết tôi cần" hoặc dự án >~50 cuộc. Chunk + embed (Workers AI, on-platform), lưu Vectorize với metadata `project_id` làm tường phòng ban. **⚠️ Bước này vượt lằn ranh bảo mật — báo anh Luân TRƯỚC:** transcript đang E2E, RAG cần server đọc được → đây là **quyết định chính sách** (index dẫn xuất server-đọc-được vs E2E thật), không chỉ là việc kỹ thuật. Phase 0-1.5 không hề chạm lằn ranh này.
- **Phase 3 — trợ lý xuyên-dự-án của admin.** Như trên: dùng lại retrieval Phase 1/2 bỏ filter dự án, chỉ admin + audit.

## Rủi ro (ưu tiên giảm dần)

1. **Chất lượng summary là TRẦN.** Mọi thứ build từ summary D1, không phải transcript mã hoá. Đầu tư prompt summary có cấu trúc (decisions/actions/glossary) **trước tiên**. Transcript trộn VN/KO/EN của Deepgram dễ sai → **mọi câu trả lời giữ trích dẫn cuộc họp** để user kiểm.
2. **Lỗ authz qua route AI.** "Hỏi-dự-án" phải chạy **đúng** check `project_member`/confidential như mở cuộc họp. Enforce filter server-side từ session đã verify — **không tin `project_id` do client gửi**. Query không filter = bug bảo mật. Admin xuyên-dự-án = code path riêng, có chủ đích, audit.
3. **Brief trôi (tam sao thất bản).** Brief ghi đè có thể bóp méo dần. Giảm: summary từng cuộc **bất biến** làm gốc trong D1; snapshot mọi version brief ra R2; prompt cập nhật **ghi nguồn cuộc họp** cho mỗi quyết định → audit + dựng lại được.
4. **Bất biến vs sửa sai.** Cuộc họp xong = read-only nên summary tệ đầu độc chuỗi mãi. Thêm đường **admin-only regenerate** brief/summary dù cuộc họp gốc vẫn khoá.
5. **Lỗi/độ trễ lúc đóng họp.** Gọi cập-nhật-brief **bất đồng bộ** (không chặn End-for-all) + **Cron reconcile** chạy lại cuộc nào thiếu brief → tự lành.

## Chi phí (hợp công ty nhỏ, theo usage chứ không theo data)

- Summary + cập nhật brief: **dưới 1 xu/cuộc** (Haiku).
- Reasoning mỗi câu hỏi: **vài xu** (Sonnet). **Prompt caching** trên brief tái dùng để cắt chi phí câu lặp.
- Embeddings (chỉ Phase 2): vài phần xu/cuộc, một lần. Vectorize storage: không đáng kể.
- Dành tier nặng nhất (Opus) chỉ cho reasoning xuyên-cuộc-họp thật khó.
- **So với fine-tune:** tốn upfront + retrain định kỳ + cũ + không mua được cho Claude + mìn bảo mật. Ở đây 0 chi phí GPU rảnh.

## Căng thẳng cốt lõi (nói thẳng)

Tín hiệu giàu nhất (transcript đầy đủ) cố tình **E2E, server không đọc được**; mà AI reasoning cần text server đọc được. **Summary D1 là cầu nối hợp lệ** → **chất lượng bộ nhớ bị chặn bởi chất lượng summary.** Đó là lý do Phase 0 (summary Claude tốt + bền) đi trước tất cả, và không đụng transcript tới khi công ty **chốt rõ** giá trị tìm kiếm có đáng nới E2E không.

## File sẽ đụng (khi triển khai)

- Room-server summarize/chatbot (đang Gemini — điểm swap, `index.ts` ~2862).
- `worker/src/index.ts` chỗ ghi summary ~1368 (neo D1 query được — thêm gọi cập-nhật-brief async ngay sau).
- Cột mới `project.ai_brief` + snapshot brief ra R2.
- Route admin xuyên-dự-án dùng lại scoping roomGate/`project_member` bỏ filter dự án.
- Migration cộng dồn; regenerate `docs/architecture.md`, đừng sửa tay.

> Liên quan: access model theo phòng ban (project-scoped guest) · `docs/plans/roadmap.md` (Phase 5 recording) · `docs/architecture.md`.

---

## Addendum 2026-06-15 — Nadella lens: own the learning loop (token capital)

**Luận điểm Nadella (3 dòng):** AI tạo lần đầu một _cognitive loop_ người ↔ máy; model sẽ liên tục **commoditize** chuyên môn của ai phơi nó ra. Nên mỗi công ty phải vừa xây **human capital** (phán đoán, quan hệ, pattern-recognition của người) vừa xây **token capital** (năng lực AI công ty **sở hữu**), và tài sản thật KHÔNG phải chọn model giỏi nhất mà là **sở hữu cái learning loop** nơi hai vốn này _compound_ — đó mới là IP của firm. Bài test chủ quyền: **swap model generalist mà KHÔNG mất "company veteran"**.

### 1. Hoà giải "đừng fine-tune" với "private RL" của Nadella — không hề mâu thuẫn

Hai bên **nhắm vào hai vật khác nhau**, nên cùng đúng:

- Doc bác bỏ **fine-tune 1 generalist chung trên data MỌI phòng ban** — việc này nướng fact Dept A + Dept B vào weights mà Worker authz **không thấy/lọc/thu hồi được**, phá đúng bức tường phòng ban cả access model dựng ra để giữ. Bác bỏ này **vẫn 100% đúng**.
- Nadella tán thành **sở hữu cái loop** (evals + traces thật + KB + môi trường có kiểm soát) **portable across models**; private RL chỉ là **tuỳ chọn về sau**, chạy trên **một model + một scope mình kiểm soát**, **không bao giờ** là 1 model chung bôi qua ranh giới mật.

**Quy tắc đã hoà giải:** giữ IP compound trong **LOOP, không trong WEIGHTS.** Loop (summary bất biến → rolling brief → Ask-this-project → traces bắt được → private evals) chính là "hill-climbing machine", **portable by design**. RL/fine-tune nếu có chỉ là tối ưu _per-scope_ trên weights **vứt đi được**: phép thử là **xoá weights đó vẫn dựng lại được chuyên môn từ D1/R2.** Nếu không dựng lại được → đã trượt bài test chủ quyền. Vậy: deferred nhưng **architected-for**, không cấm vĩnh viễn.

### 2. Những trụ cột MỚI doc cũ chưa nhấn đủ

- **Model SOVEREIGNTY / portability (swap-the-model test).** Mỗi asset hỏi: _Claude biến mất mai này, mình MẤT gì?_ Cái mất = IP kẹt trong weights người khác (fail). Cái còn = sống trong D1/R2 của mình (pass). Core của doc (summary D1 + brief + R2 snapshot + Ask) **đã pass by construction** — phải **đặt tên nó là IP của firm**. Cụ thể hoá: bọc model-call sau **một seam config `provider+model+version`** (chỗ Gemini `index.ts` ~2862 / ~3165) → swap là đổi config, không viết lại.
- **Cái COMPOUNDING loop — bắt tín hiệu NGAY.** Doc hiện chỉ **lớn dần** (accumulate) chứ chưa **tốt dần** (compound). Q&A và brief-merge đang fire-and-forget → tín hiệu giàu nhất (câu hỏi thật + context truy hồi + câu trả lời + nó đúng/sai) **bốc hơi**. Không log = tự nguyện vứt đúng IP Nadella bảo phải hoard. Bắt **4 luồng rẻ**: thumbs ± / "copy answer" trên Ask; cặp before→after khi admin regenerate summary (risk #4); decision-reversed (cuộc N+k lật quyết định cuộc N — tín hiệu giàu nhất của firm kiến trúc); action-item lifecycle.
- **PRIVATE EVALS trên business outcome, không phải benchmark ngoài.** Mỗi metric chỉ là **SQL aggregate** chạy weekly Cron, không cần ML: `decision_reversal_rate` · `action_followthrough_rate` · `ask_thumbs_up_rate` / `ask_used_rate` · phút _cuộc-xong → brief-ready_ · edits-per-summary giảm dần · "rework tránh được" (Ask khơi lại quyết định cũ TRƯỚC khi họp re-litigate). Render lên trang dự án Glass Desk — đây là **scoreboard private-eval theo outcome của MAP**.
- **ADMIN = token-capital steward.** "1 model của admin" = retrieval-scope mở rộng + audit (doc đã đúng), nay **đặt tên lại**: admin trông coi **cái loop** — prompts/glossary/eval-set/trace corpus. Tách hai scope compound: **CRAFT layer** (prompt schema, brief-merge prompt, glossary, eval set, question-patterns) **content-free → compound TOÀN firm** không lộ fact; **PROJECT FACTS** compound **cục bộ sau tường**, qua filter `project_id` server-side. _Chia sẻ phương pháp, rào fact._

### 3. Làm NGAY — rẻ, để compound từ ngày đầu (pre-RL)

1. **Bền hoá** summary + brief-merge (vá fire-and-forget, audit #13): retry + cờ + Cron reconcile. Mất = mất IP vĩnh viễn.
2. **Log traces từ ngày đầu** — 1 bảng `ai_signal` (migration **0020**, copy shape `audit_log` `0005`), cột `{kind, project_id, meeting_id, model+version, retrieved refs, prompt_version, output, rating, before/after, cost, latency, ts}`. `project_id` làm tín hiệu **thừa kế tường phòng ban**. Đây là nước cờ chủ quyền lợi-hại nhất, gần như free.
3. **Version hoá prompts** (summary + brief-merge) thành artifact theo dõi trong repo — logic distillation là IP của firm.
4. **Eval set nhỏ:** ~20-50 câu hỏi thật + đáp án người-duyệt qua 2-3 dự án; chạy mỗi lần swap model → biến "swap" từ niềm tin thành **test passed**. Đóng băng golden set ra R2.
5. **Seam model-call** một interface config (đã nêu) → portability thành thao tác.
6. **Tường phòng ban = filter lúc query, không bao giờ là thuộc tính weights** (doc đã bắt buộc) — đây cũng chính là cái khiến private RL _an toàn-về-sau_ vì scope được trace corpus.

### 4. Right-size cho firm nhỏ, non-CS PM — đừng over-build

**KHÔNG** dựng private RL / fine-tune / vector-RAG / pipeline train bây giờ — đó là bẫy over-invest. Bản "own your learning loop" đúng cỡ MAP = **Phase 0-1.5 của doc + 1 bảng `ai_signal` + 1 file eval JSON**. Cái đó lấy ~90% IP compound ở **vài xu/cuộc**. Caveat thật: firm vài chục cuộc có thể **không bao giờ** đủ trace để bõ RL — _và ổn_. Mục đích do-now KHÔNG phải để rồi sẽ fine-tune; mà để **giữ OPTION chủ quyền** và làm product tốt hơn mỗi ngày qua evals/traces. "Đừng fine-tune" của doc đúng cho HÔM NAY; điều duy nhất Nadella sửa: **đừng vứt traces + eval set** — thứ cho phép mai này quyết định RL **có chủ đích**, hoặc bỏ qua mà chẳng mất gì. Giữ Vectorize/RAG (Phase 2) và mọi RL nặng **sau cổng "user thật sự đòi"**.

---

## Addendum 2026-06-15 (b) — Data → Tri thức TẬP ĐOÀN: dùng data cuộc họp ntn để AI HỌC + HIỂU

> Tầm nhìn anh Luân: **KB cho cả tập đoàn**, data cuộc họp/dự án là **mỏ vàng**. Câu hỏi: dùng nó sao cho AI **học + hiểu**. Đáp: _understanding đến từ **cấu trúc + liên kết**, không phải nhồi transcript vào model._

### Data thô = nhiễu. 4 nấc biến nó thành tri thức AI hiểu được

1. **TRÍCH XUẤT → fact có cấu trúc (nguyên tử).** Mỗi cuộc họp xong rút ra: _quyết định · việc cần làm (chủ trì/hạn/trạng thái) · câu hỏi mở · THỰC THỂ (người · dự án · bản vẽ · cấu kiện · vật liệu · nhà thầu) · tham chiếu cuộc/bản vẽ trước_. Nguyên tử KHÔNG phải transcript — mà là fact đã rút. **Trần chất lượng nằm ở đây** → prompt trích xuất là ưu tiên #1 (đã là Phase 0).
2. **LIÊN KẾT → đồ thị, không phải đống file.** "Hiểu" cấp tập đoàn = nối: _quyết định → cuộc họp → dự án → bản vẽ/cấu kiện → người → đảo quyết định trước nào_. Một **graph quyết-định/thực-thể nhẹ** (lưu trong D1 theo `project_id` + `meeting_id` + entity) cho AI **truy nhân-quả + thấy pattern**, thay vì chỉ tìm text. Đây là lúc institutional memory thành **query được**.
3. **CHƯNG CẤT → 2 tầng, một mạch (mấu chốt bảo mật tập đoàn).**
   - **Per-project (mật, có tường):** bộ nhớ từng dự án; user/khách chỉ thấy phần mình — filter `project_id` server-side.
   - **Firm-wide "practice memory" (admin chưng cất):** tri thức **đã khái quát hoá** — chi tiết tiêu chuẩn lặp lại, quyết định hay gặp, quy ước đặt tên, bài học, hiệu năng nhà thầu. **Đây mới là IP tập đoàn compound.** Khớp với split CRAFT-vs-FACTS của addendum (a): phần _content-free_ (phương pháp/pattern) compound toàn firm tự do; còn **promote một FACT cụ thể lên tầng tập đoàn là QUYẾT ĐỊNH CÓ CHỦ ĐÍCH của admin** (admin full-power + audit) — abstract thành pattern, review nội dung, **không bao giờ tự động** chảy ngang qua tường. _Chia sẻ phương pháp, rào fact; vượt tường = admin cố ý + ghi audit._
4. **GIỮ TÍN HIỆU → để "học" thật.** Ở giai đoạn này **"AI học" = KB lớn dần (graph thêm fact) + feedback (câu trả lời nào dùng được, summary nào bị sửa, quyết định nào giữ vs bị đảo)** — bảng `ai_signal` của addendum (a). **Chưa train weights**; nhưng kiến trúc để private-RL là option mình làm chủ sau khi đã đủ traces.

### Vì sao đây là cách ĐÚNG (không phải "đổ data cho AI")

"Đổ" transcript thô vào model = đắt, không truy dẫn được, không scale, và **không hiểu** (model chỉ tóm). Trích-xuất→liên-kết→chưng-cất cho **tri thức truy nguyên + compound + portable** — đổi model nào cũng giữ (bài test chủ quyền). **Moat của tập đoàn = graph tri thức có cấu trúc + được sửa đúng + tầng practice-memory admin chưng cất**, nằm trong D1/R2 mình sở hữu.

### Làm cho thành thật (đúng cỡ firm nhỏ)

1. **Định "ontology" của hãng** — thế nào là _quyết định / action / bản vẽ / cấu kiện / vật liệu / nhà thầu_ → trích xuất nhất quán (1 file schema, phần CRAFT compound firm).
2. **Prompt trích xuất có cấu trúc** (Phase 0) → nguyên tử chất lượng.
3. **Liên kết fact thành graph nhẹ** trong D1 (`project_id`+`meeting_id`+entity) — không cần graph-DB riêng, bảng quan hệ là đủ.
4. **Admin chưng cất tầng firm-wide** định kỳ (Cron/thủ công) từ project memory → practice-memory, **có review + audit** khi promote fact.
5. **Bật `ai_signal` từ ngày đầu** → nhiên liệu loop.

> Tóm 1 câu: **trích xuất → liên kết (graph) → chưng cất lên tập đoàn (admin gác cổng) → giữ feedback.** Đó là cách data cuộc họp thành tri thức AI _hiểu_, và thành IP tập đoàn _compound_ — vẫn giữ tường phòng ban.
