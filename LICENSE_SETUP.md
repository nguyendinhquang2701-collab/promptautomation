# Mã kích hoạt — Hướng dẫn cho người bán

Bán app, mỗi mã có **hạn dùng** (1 giờ thử / 7 ngày / 1 tháng / 3 tháng / 1 năm / vĩnh viễn)
và **chỉ đăng nhập được ở một nơi cùng lúc** — khách kích hoạt ở máy mới thì máy cũ tự đăng xuất.

**Không cần cài đặt gì cả.** Firebase của app đã mở sẵn, không cần secret, không cần chỉnh luật.

---

## Tạo mã để bán (chỉ 3 bước)

1. Mở file **`admin.html`** — nhấp đúp, nó mở ngay bằng Chrome (chạy trên máy bạn, không cần đưa lên web).
2. Điền **Tên khách hàng** (tuỳ chọn), chọn **Thời hạn**, **Số lượng** → bấm **Tạo**.
   Mã hiện ngay trong bảng và **tự copy vào clipboard**. Gửi mã cho khách là xong.

Khách dán mã vào app (màn hình "Nhập mã kích hoạt") là dùng được.

---

## Quản lý mã đã bán

Ngay trong bảng của `admin.html`:

- **Trạng thái**: `Tồn kho` (chưa ai kích hoạt) · `Đang chạy` (đang có người dùng) · `Hết hạn`.
- **Copy**: copy lại mã để gửi khách.
- **Đá máy**: buộc khách đăng nhập lại (dùng khi muốn chuyển mã sang máy khác cho khách).
- **Thu hồi**: xoá mã vĩnh viễn (khách mất quyền dùng ngay).

---

## Cơ chế "1 mã = 1 nơi" (giải thích ngắn)

- Mỗi máy khi kích hoạt sinh ra một `token` ngẫu nhiên, ghi vào trường `deviceId` của mã.
- Chỉ máy có `token` trùng `deviceId` mới được vào. Kích hoạt ở máy mới ghi đè `deviceId`
  → máy cũ (khoảng 30 giây sau) thấy lệch → bị đăng xuất, hiện nút **"Dùng ở máy này"**.
- **Hạn dùng tính từ lúc kích hoạt lần đầu** (mã để trong kho không bị trừ ngày).
- Hạn so theo **giờ máy chủ**, nên khách chỉnh đồng hồ máy vô ích.

## Một bản ghi mã trông như thế nào (tham khảo)

```json
{
  "customerName": "Anh Quân",
  "durationMs": 2592000000,   // 30 ngày (-1 = vĩnh viễn)
  "createdAt": 1723456789000,
  "deviceId": null,           // token máy đang giữ phiên (null = chưa kích hoạt)
  "deviceAt": 0,
  "expiresAt": null           // chốt khi kích hoạt lần đầu = lúc kích hoạt + durationMs
}
```

---

> ⚠️ **Lưu ý bảo mật (thành thật):** để cho đơn giản, Firebase đang để mở — nghĩa là người
> rành kỹ thuật, nếu biết đường link database, có thể xem hoặc sửa mã. Bán cho khách thường
> thì hoàn toàn ổn (giống hệt cách công cụ cũ của bạn đang chạy). Nếu sau này cần khoá chặt
> hơn (bắt đăng nhập admin, chặn xem trộm), nhắn tôi làm bản nâng cấp.
>
> `admin.html` là công cụ nội bộ — chỉ mở trên máy bạn, đừng đưa lên web, đừng chia sẻ file.
> Khi build app (`npm run build`) file này **không** bị đóng gói nên khách không thấy được.
