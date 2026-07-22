# Kết nối dashboard với Google Sheets + Apps Script

Google Sheet production và Spreadsheet ID không được ghi vào repository công khai. Chỉ chủ studio lưu các thông tin này trong Apps Script Properties.

## 1. Tạo Apps Script Web App

1. Mở Google Sheet ở link trên.
2. Chọn **Extensions → Apps Script**.
3. Thay nội dung `Code.gs` bằng file [`google-apps-script/Code.gs`](google-apps-script/Code.gs) trong repo.
4. Mở **Project Settings**, bật hiển thị file manifest và thay `appsscript.json` bằng file cùng tên trong repo.
5. Trong **Script Properties**, thêm:
   - `SPREADSHEET_ID` = ID của Google Sheet production.
   - `API_TOKEN` = một chuỗi bí mật dài tối thiểu 24 ký tự do Trinh tự đặt.
   - `TELEGRAM_BOT_TOKEN` = token do `@BotFather` cấp.
   - `TELEGRAM_CHAT_ID` = chat ID của TrinhNYoga nhận cảnh báo.

Không ghi `API_TOKEN` vào GitHub, file HTML hoặc tab `Settings`.

## 2. Deploy API

1. Chọn **Deploy → New deployment → Web app**.
2. Execute as: **Me**.
3. Chọn phạm vi truy cập phù hợp với tài khoản triển khai và không công khai URL/token trong repository.
4. Authorize quyền đọc/ghi Google Sheet.
5. Sao chép URL kết thúc bằng `/exec`.

Mọi API đọc/ghi ngoại trừ health check đều bắt buộc có `API_TOKEN`. Nếu cần cho frontend công khai truy cập, nên đặt thêm một Vercel serverless proxy để token không nằm ở trình duyệt.

## 3. Kết nối dashboard

1. Mở `https://diemtrinh.vercel.app/quan-ly`.
2. Bấm nhãn **Dữ liệu mẫu** trên thanh đầu trang.
3. Dán Apps Script Web App URL và `API_TOKEN`.
4. Bấm **Kết nối & đồng bộ**.

URL API được lưu trên trình duyệt; token chỉ giữ trong phiên hiện tại (`sessionStorage`) và sẽ phải nhập lại sau khi đóng trình duyệt.

## 4. Cấu trúc database

| Tab | Vai trò |
| --- | --- |
| `Dashboard` | KPI và biểu đồ tổng hợp trực tiếp trong Google Sheet |
| `Students` | Hồ sơ học viên, gói, học phí, ngày thu, số buổi và tình trạng `Duy trì / Ngừng tập` |
| `Payments` | Phiếu thu bất biến |
| `Allocations` | Một bút toán trả nợ và bốn bút toán quỹ tương ứng với mỗi phiếu thu |
| `Settings` | Tỷ lệ phân bổ và cấu hình hệ thống |

## 5. Bật cảnh báo Telegram còn 2 buổi

1. Tạo bot với `@BotFather`, lấy `TELEGRAM_BOT_TOKEN`.
2. Gửi một tin nhắn bất kỳ cho bot, sau đó lấy `chat_id` và lưu thành `TELEGRAM_CHAT_ID` trong Script Properties.
3. Trong Apps Script, chọn hàm `installDailyTelegramTrigger` và bấm **Run** một lần để tạo lịch kiểm tra mỗi ngày lúc 8 giờ sáng.
4. Khi bấm **Điểm danh** trên dashboard và số buổi còn lại chuyển thành đúng 2, Telegram được gửi ngay. Trigger hằng ngày là lớp kiểm tra dự phòng.

Thông báo chỉ gửi một lần cho mỗi mốc còn 2 buổi nhờ cột `Low_Session_Alert_At` trong tab `Students`.

## 6. Quy tắc an toàn

- Không xóa phiếu thu đã phát sinh; hoàn tiền bằng giao dịch âm/đảo chiều ở phiên bản tiếp theo.
- Chỉ chỉnh tỷ lệ từ dashboard hoặc tab `Settings`, tổng luôn phải bằng 100%.
- Bật xác minh 2 bước cho tài khoản Google sở hữu Sheet.
- Định kỳ tải bản sao `.xlsx` hoặc bật thông báo thay đổi trên Google Sheet.
- Nếu URL/token bị lộ, đổi `API_TOKEN` trong Script Properties và tạo deployment version mới.
- Không xóa học viên đã có phiếu thu; chuyển `Tình trạng tập` sang `Ngừng tập` để bảo toàn lịch sử.
- Có thể thêm, sửa và xóa học viên trực tiếp ở màn hình **Học viên**; thao tác xóa sẽ bị chặn nếu đã có phiếu thu.
- Mỗi tháng, hệ thống trích đủ 3.000.000 ₫ vào quỹ trả nợ trước; chỉ phần còn lại mới chia theo tỷ lệ 4 quỹ.
