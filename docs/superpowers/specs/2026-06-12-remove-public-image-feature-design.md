# Remove Public Image Feature Design

## Goal
Loại bỏ hoàn toàn tính năng tạo ảnh công khai và image proxy liên quan ra khỏi hệ thống, không để lại endpoint, route, cấu hình hay code chạy thác loạn liên quan.

## Architecture
Xóa toàn bộ public image feature theo hướng dọn dẹp行为:
- vô hiệu hóa và loại bỏ các endpoint công khai /images, /image, /api/public/images/*
- loại bỏ hoặc tắt logic xử lý image proxy cho /v1/images/*
- gỡ config, stats, doc, env, route UI liên quan
- giữ schema `image_usage_events` để không phá vỡ migration/hosting sẵn; không còn ai đọc/ghi trong code
- có thể finalize bằng tác vụ dọn DB rác riêng sau nếu muốn

## Tech Stack
- Fastify route registration/teardown
- React client routes/components
- SQLite schema trong `src/server/db/schema.ts`
- docs/README/`.env.example`

## Scope

### In
- Public image pages/routes
- Public image job queue/history/download APIs
- Image proxy handling cho `/v1/images/generations` và `/v1/images/edits`
- Admin image stats/config APIs
- Admin image UI blocks
- Client `ImageCreator`
- Runtime env/docs cho image

### Out
- Bảng `image_usage_events` trong DB hiện tại; schema nên giữ nguyên để không gây lát đột ngột host
- Quota/routing/proxy behavior khác image nếu không liên quan

## Migration/Runtime Notes
- Sau deploy, các endpoint liên quan ảnh sẽ hết hoạt động hoặc không còn mount.
- Không xóa dữ liệu hay file `public-images` cũ trong bước đầu; có thể làm tác vụ dọn rác sau.
