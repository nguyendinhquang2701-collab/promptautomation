# Mã kích hoạt — CẢNH BÁO trước khi bán

> **KHÔNG dùng cơ chế hiện tại để bảo vệ sản phẩm trả phí.** Firebase Realtime
> Database đang cho phép trình duyệt đọc/ghi trực tiếp. Người biết URL có thể xem,
> tạo, gia hạn, chiếm phiên hoặc xóa mã mà không cần `admin.html`. Việc giữ file
> quản trị trên máy riêng không khắc phục được lỗ hổng này.
>
> Trước khi bán, phải chuyển toàn bộ thao tác license sang backend đã xác thực,
> đặt Firebase Rules mặc định từ chối truy cập công khai, giữ credential ở secret
> của server, dùng transaction khi kích hoạt, và thêm rate limit/audit log/admin MFA.
> Client chỉ nên nhận một phiên hoặc token ký có thời hạn ngắn.

Phần dưới chỉ mô tả công cụ **legacy để thử nội bộ**, không phải hướng dẫn triển khai production.

Bán app, mỗi mã có **hạn dùng** (1 giờ thử / 7 ngày / 1 tháng / 3 tháng / 1 năm / vĩnh viễn)
và **chỉ đăng nhập được ở một nơi cùng lúc** — khách kích hoạt ở máy mới thì máy cũ tự đăng xuất.

Firebase mở công khai là cấu hình thử nghiệm không an toàn; không triển khai cấu hình này cho khách hàng.

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

> ⚠️ Firebase mở không phù hợp cho bất kỳ nhóm khách trả phí nào; đây là lỗi P0,
> không phải hạng mục nâng cấp tùy chọn.
>
> `admin.html` là công cụ nội bộ — chỉ mở trên máy bạn, đừng đưa lên web, đừng chia sẻ file.
> Khi build app (`npm run build`) file này **không** bị đóng gói nên khách không thấy được.
