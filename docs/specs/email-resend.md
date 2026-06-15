# Gửi email mời khách qua Resend (MCM)

Hướng dẫn này giúp bật chức năng **Worker tự gửi email** cho khách (link cuộc họp, kèm mật khẩu đăng nhập nếu cần). Dùng **Resend** — dịch vụ gửi email đơn giản, có sẵn gói miễn phí. Bạn **không cần đụng vào code**: chỉ làm vài bước cấu hình dưới đây.

Có 2 thứ cần đặt:

| Tên | Là gì | Đặt ở đâu |
|---|---|---|
| `RESEND_API_KEY` | **Bí mật** — chìa khoá tài khoản Resend | `wrangler secret put` (KHÔNG ghi vào git) |
| `RESEND_FROM` | Địa chỉ người gửi (ví dụ `Canvas M <onboarding@resend.dev>`) | `worker/wrangler.jsonc` mục `vars` (đã có sẵn placeholder) |

---

## 1. Lấy API key của Resend

1. Đăng nhập **https://resend.com** (bạn đã có tài khoản).
2. Vào **API Keys** (menu bên trái) → **Create API Key**.
3. Đặt tên bất kỳ (vd `mcm-worker`), quyền để mặc định **Full access** (hoặc *Sending access*), bấm **Add**.
4. Resend hiện key dạng `re_xxxxxxxx...` **một lần duy nhất** — copy ngay và giữ kín. Nếu lỡ mất, tạo key mới.

> Đừng dán key này vào bất kỳ file nào trong repo. Nó chỉ sống trong "secret" của Cloudflare.

## 2. Nạp key + người gửi vào Worker

Mở terminal trong thư mục `worker/` rồi chạy:

```bash
# Đưa key bí mật lên Cloudflare (nó sẽ hỏi và bạn dán key vào)
npx wrangler secret put RESEND_API_KEY
# → dán re_xxxxxxxx... rồi Enter
```

`RESEND_FROM` thì **đã có sẵn** trong `worker/wrangler.jsonc`:

```jsonc
"vars": {
  "RESEND_FROM": "Canvas M <onboarding@resend.dev>"
}
```

Lần sau khi đổi giá trị này, chỉ cần sửa file rồi `npx wrangler deploy` lại — không sửa code.

**Chạy thử ở máy (local `wrangler dev`):** tạo/ sửa file `worker/.dev.vars` (file này đã được gitignore) và thêm dòng:

```
RESEND_API_KEY=re_xxxxxxxx...
RESEND_FROM=Canvas M <onboarding@resend.dev>
```

## 3. Chế độ TEST — gửi ngay, không cần DNS

Resend cho sẵn người gửi dùng chung **`onboarding@resend.dev`**. Để nguyên `RESEND_FROM` như placeholder ở trên là gửi được liền, **không phải cấu hình tên miền gì cả**.

Lưu ý của chế độ test:
- Trong khi tài khoản chưa "verify domain", Resend có thể **chỉ cho gửi tới chính email bạn đã đăng ký Resend**. Đủ để bạn tự kiểm tra luồng gửi.
- Thư có thể vào mục **Spam/Quảng cáo** — đó là bình thường ở giai đoạn test.
- Xem log từng email đã gửi tại Resend → **Emails** (thành công / lỗi / mở thư).

Tới đây là đủ để demo nội bộ.

## 4. KHI SẴN SÀNG — dùng tên miền công ty (gửi cho người ngoài)

Để gửi tới khách bất kỳ và thư trông chuyên nghiệp (`no-reply@mapgroup.co.kr`), cần **verify tên miền** một lần:

1. Resend → **Domains** → **Add Domain** → nhập `mapgroup.co.kr` (hoặc subdomain riêng cho email hệ thống: `mail.mapgroup.co.kr` — khuyến nghị, không đụng email người dùng hiện có).
2. Resend hiện ra một danh sách **bản ghi DNS** (vài dòng **SPF**, **DKIM**, và **DMARC**). Đây chỉ là mấy dòng text.
3. Vào nơi quản lý DNS của `mapgroup.co.kr` (chỗ mua/quản lý tên miền) → **thêm đúng từng bản ghi** Resend đưa (copy y nguyên Name + Type + Value).
4. Quay lại Resend bấm **Verify**. Chờ DNS lan (thường vài phút tới ~1 giờ) đến khi tất cả chuyển **xanh / Verified**.
5. Sửa `RESEND_FROM` trong `worker/wrangler.jsonc` thành:
   ```jsonc
   "RESEND_FROM": "MAP CanvasMeet <no-reply@mapgroup.co.kr>"
   ```
   rồi `npx wrangler deploy`. **Không cần sửa code.**

> Nếu phần DNS làm bạn ngại, gửi mấy dòng Resend đưa cho người quản trị tên miền/IT — họ thêm 5 phút là xong. Không có rủi ro cho email hiện tại nếu bạn dùng subdomain `mail.mapgroup.co.kr`.

---

## (Tuỳ chọn) Dùng Resend làm SMTP cho magic-link của Supabase

Hiện magic-link / email xác thực do **Supabase** tự gửi (gateway mặc định, giới hạn thấp). Nếu muốn các email đó cũng đi qua Resend cho ổn định và đồng nhất tên miền:

- Supabase → **Authentication → Emails → SMTP Settings** → bật **Custom SMTP**, điền:
  - Host: `smtp.resend.com`
  - Port: `465`
  - Username: `resend`
  - Password: **API key Resend** (`re_...`)
  - Sender: cùng địa chỉ đã verify, vd `no-reply@mapgroup.co.kr`

Đây là cấu hình ở phía Supabase, **độc lập** với Worker — không ảnh hưởng tới `sendEmail` của Worker và cũng không cần đổi code.
