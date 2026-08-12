# Hệ thống mã kích hoạt — Hướng dẫn cho người bán

Mục tiêu: bán app, mỗi mã có **hạn dùng** (1 tháng / 3 tháng / 1 năm / vĩnh viễn) và
**chỉ đăng nhập được ở một nơi cùng lúc** — kích hoạt ở máy mới thì máy cũ tự đăng xuất.

Không cần server riêng. Chỉ dùng Firebase Realtime Database (đã có sẵn trong app).

---

## Cài đặt 1 lần (khoảng 3 phút)

### Bước 1 — Dán luật bảo mật (bắt buộc)

Vào **Firebase Console → Realtime Database → tab Rules**, xoá luật cũ, dán toàn bộ nội dung
file `firebase-rules.json` vào, nhấn **Publish**.

Luật này khoá lại để:
- Khách **không xem được** danh sách mã của bạn.
- Khách **không tự sửa** được hạn dùng / gói / trạng thái khoá (các trường tiền bạc bị "đóng băng").
- Khách chỉ được ghi 2 trường kỹ thuật: `session` và `sessionAt` (phục vụ việc "1 nơi 1 lúc").
- Phần thống kê `veo3_stats` của app vẫn chạy bình thường.

### Bước 2 — Lấy Database Secret (để tạo/quản lý mã)

Vào **Firebase Console → ⚙️ Project settings → Service accounts → Database secrets**,
copy chuỗi secret. Dùng nó trong công cụ quản lý ở bước sau.

> Nếu dự án của bạn không hiện "Database secrets", bỏ qua — bạn vẫn tạo mã được bằng cách
> dán JSON thủ công vào Console (xem phần "Không có secret").

---

## Tạo mã để bán

Mở file **`admin.html`** bằng trình duyệt (nhấp đúp — chạy ngay trên máy bạn, **không cần** đưa lên web).

1. Dán **Database Secret** vào ô cấu hình.
2. Chọn **gói hạn dùng** + **số lượng** → **Tạo mã**.
3. Nhấn **⬆️ Ghi thẳng lên Firebase** → xong. Mỗi mã hiện ở cột "Mã (gửi khách)".
4. Copy mã, gửi cho khách. Khách dán mã vào app là dùng được.

**Không có secret?** Sau khi Tạo mã, nhấn **📋 Copy JSON**, rồi vào
**Console → Realtime Database → node `veo3_licenses`** và dán/thêm thủ công. Kết quả như nhau.

---

## Quản lý mã đã bán

Cũng trong `admin.html`, phần **🛠️ Quản lý một mã** (cần Database Secret):

- **Tra cứu**: xem gói, hạn, còn hạn hay không, đang được dùng ở đâu.
- **🔒 Khoá mã / 🔓 Mở khoá**: khoá là chặn dùng ngay (ví dụ khách bùng tiền).
- **📴 Đá thiết bị**: buộc khách đăng nhập lại (dùng khi cần thu hồi phiên).
- **➕ Gia hạn thêm 30 ngày**: cộng dồn hạn (nhấn nhiều lần để cộng nhiều).
- **🗑️ Xoá mã**: xoá vĩnh viễn.

---

## Cơ chế "1 mã = 1 nơi" (giải thích ngắn)

- Mỗi máy khi kích hoạt sinh ra một `token` ngẫu nhiên và ghi vào `session` của mã.
- Máy nào có `token` trùng `session` mới được vào. Kích hoạt ở máy mới ghi đè `session`
  → máy cũ lần kiểm tra kế tiếp thấy lệch → bị đăng xuất, hiện nút "Dùng ở máy này".
- Hạn dùng so theo **giờ máy chủ** (không phải giờ máy khách) nên khách chỉnh đồng hồ vô ích.

## Cấu trúc một bản ghi mã (tham khảo)

```json
{
  "plan": "1 tháng",
  "durationDays": 30,
  "createdAt": 1723456789000,
  "expiresAt": 1726048789000,
  "disabled": false,
  "session": null,
  "sessionAt": 0
}
```

- `durationDays`: 30 / 90 / 365 / 0 (0 = vĩnh viễn).
- `expiresAt`: mốc hết hạn (ms). `0` = không bao giờ hết. **Chốt ngay lúc tạo mã.**
- `disabled`: `true` = đã khoá.

> ⚠️ `admin.html` là công cụ nội bộ có quyền quản trị. Chỉ mở trên máy bạn, đừng deploy,
> đừng chia sẻ file này hay Database Secret cho bất kỳ ai. File chỉ dùng ở máy nên
> **không** bị đóng gói khi build app (`npm run build` chỉ build `index.html`).
