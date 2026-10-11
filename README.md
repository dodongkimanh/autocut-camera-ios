# AutoCut Camera cho iPhone — hướng dẫn build

App biến iPhone thành camera cho AutoCut Studio, giống app Android: iPhone và máy tính dùng chung Wi-Fi. Mở app, bấm **📷 Quét mã QR**, quét mã trong AutoCut (tab 📷 Camera → 📱 Điện thoại) là có hình và tiếng.

Apple chỉ cho build và ký app iPhone **trên máy Mac có Xcode**. Thư mục `ios` này đã có sẵn mọi thứ, chỉ cần làm các bước dưới.

## Cần có

| | |
|---|---|
| Máy Mac | macOS 14 trở lên, cài **Xcode 16** trở lên (miễn phí trên App Store) |
| Tài khoản Apple | Tài khoản Apple ID miễn phí: cài thử lên iPhone của mình, **app hết hạn sau 7 ngày**. Tài khoản **Apple Developer** (99 USD/năm): cài lâu dài và gửi cho người khác qua **TestFlight** |
| iPhone | iOS 15 trở lên (iPhone 16 Pro Max chạy được) |

## Bước 1 — chuẩn bị trên máy Windows (đã làm sẵn)

```
npm run build:ios
```

Lệnh này chép giao diện, bộ quét QR và AI xoá phông vào `ios/AutoCutCamera/www`, đồng thời tạo biểu tượng app. Mỗi lần sửa `android/www` thì chạy lại lệnh này.

Chép **cả thư mục `ios`** sang máy Mac (USB, Google Drive, AirDrop…).

## Bước 2 — tạo dự án Xcode trên Mac

Mở **Terminal** trên Mac:

```bash
# Cài Homebrew nếu chưa có: https://brew.sh
brew install xcodegen
cd đường-dẫn-tới/ios
xcodegen
open AutoCutCamera.xcodeproj
```

## Bước 3 — ký app

Trong Xcode:

1. Bấm vào dự án **AutoCutCamera** (cột trái) → target **AutoCutCamera** → tab **Signing & Capabilities**.
2. Tick **Automatically manage signing**. Ở mục **Team**, chọn tài khoản Apple (chưa có thì chọn *Add an Account…* để đăng nhập Apple ID).
3. Nếu Xcode báo trùng **Bundle Identifier** `vn.autocut.camera`, đổi thành tên riêng, ví dụ `vn.kimanh.autocutcamera`.

## Bước 4 — cài lên iPhone

1. Cắm iPhone vào Mac bằng cáp, bấm **Tin cậy** trên iPhone.
2. Trên iPhone: **Cài đặt → Quyền riêng tư & Bảo mật → Chế độ nhà phát triển → Bật** (máy khởi động lại).
3. Trong Xcode, chọn iPhone ở thanh trên cùng, bấm **▶ (Run)**.
4. Lần đầu dùng tài khoản miễn phí: trên iPhone vào **Cài đặt → Cài đặt chung → Quản lý VPN & thiết bị** → chọn tài khoản của bạn → **Tin cậy**.

## Bước 5 — gửi cho người khác (cần tài khoản Apple Developer)

1. Xcode: chọn thiết bị **Any iOS Device (arm64)** → menu **Product → Archive**.
2. Archive xong: **Distribute App → TestFlight & App Store → Upload**.
3. Vào [App Store Connect](https://appstoreconnect.apple.com) → app → **TestFlight**, thêm email người dùng. Họ cài app **TestFlight** trên iPhone rồi bấm link mời.

## Lần đầu mở app trên iPhone

iPhone hỏi 3 quyền, cần **Cho phép** cả ba:

- **Camera**, **Micro**
- **Mạng cục bộ**: bắt buộc để kết nối tới máy tính. Lỡ bấm *Không cho phép* thì vào **Cài đặt → AutoCut Camera → bật Mạng cục bộ**.

## Khác với bản Android

- **Không tự tìm máy tính trong mạng.** Apple chặn kiểu tìm bằng broadcast nếu không xin quyền đặc biệt, nên dùng **quét mã QR** (hoặc nhập địa chỉ IP bằng tay).
- **Tắt màn hình / chuyển sang app khác thì camera dừng.** iOS không cho dùng camera chạy nền. Quay lại app thì camera tự mở lại.
- Quét mã QR bằng **app Camera của iPhone** sẽ mở trang AutoCut trong Safari. Bấm **Mở app & kết nối** là app tự kết nối.

## Phiên bản

Đổi trong `project.yml`: `MARKETING_VERSION` (vd `1.0.2`) và `CURRENT_PROJECT_VERSION` (tăng 1 mỗi lần gửi TestFlight). Sau đó chạy lại `xcodegen`.
