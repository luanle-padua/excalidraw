# Chiến lược AI cho Canvas M — Bộ nhớ dự án theo chuỗi cuộc họp

> Chốt 2026-06-15 bởi team 5 agent (4 lăng kính: kiến trúc KB · chuỗi-reasoning · stress-test "1 model" vs bảo mật · lộ trình+chi phí → 1 tổng hợp). Yêu cầu gốc của anh Luân: AI hiểu **chuỗi cuộc họp** + reasoning → dựng **knowledge base cho dự án theo thời gian** → admin tổng hợp để "train 1 model".

## Định khung lại (quan trọng nhất)

**Mình KHÔNG "train một con AI".** Mình dựng **bộ nhớ dự án có truy hồi (retrieval-grounded)** trên dữ liệu đã có sẵn — các bản **tóm tắt cuộc họp**. Mọi thứ nằm trong dữ liệu mình kiểm soát (D1 + R2), **không nhồi vào trọng số model**. Cái này rẻ hơn, cập nhật tức thì khi họp xong, trích dẫn được, và **không bao giờ nướng dữ liệu mật vào weights không gỡ ra được**.

## Kiến trúc: 3 "tài sản sống" mỗi dự án

1. **Bản tóm tắt cuộc họp** (đã có) — mỗi cuộc họp xong ghi 1 text bất biến, server đọc được, trong D1, gắn `project_id`. **Đây là nguyên tử của bộ nhớ** — mọi thứ build từ đây.
2. **Bản tóm lược dự án cuộn (rolling brief)** (mới, là điểm nhấn) — 1 tài liệu sống/dự án: *Quyết định tới nay · Việc còn mở (kèm chủ trì + trạng thái) · Hướng thiết kế hiện tại · Thuật ngữ · Rủi ro*. Mỗi cuộc họp xong → **1 lần gọi Claude** gộp tóm tắt cuộc đó vào brief. Đây chính là "chuỗi" + "KB lớn dần" được cụ thể hoá.
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
