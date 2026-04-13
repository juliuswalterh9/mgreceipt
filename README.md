# 법인카드 영수증 디지털화 백엔드 시작 코드

`process.txt`와 `법인카드_영수증_디지털화_절차서.docx` 기준으로 초기 백엔드 골격을 구성했습니다.

## 포함 내용

- Auth API 골격: `/api/auth/register`, `/login`, `/refresh`, `/logout`, `/me`
- 사용자 영수증 API 골격: `/api/receipts/ocr`, `/api/receipts`, `/api/receipts/my`, `/api/receipts/:id`
- 관리자 API 골격: `/api/admin/users*`, `/api/admin/receipts`
- JWT 인증/관리자 권한 미들웨어
- 업로드 제약(타입/10MB) 및 OCR 파싱 서비스 스텁
- Prisma 스키마(`users`, `receipts`) 초안
- 환경변수 샘플 파일

## 다음 작업 권장

1. `.env.example`를 복사해 `.env` 생성 후 `DATABASE_URL` 설정
2. `npm run prisma:migrate`로 마이그레이션 생성/반영
3. `npm run dev`로 서버 실행
4. `ocrService.js`를 Naver Clova OCR API 연동으로 교체
5. 관리자 엑셀 다운로드(`/api/admin/receipts/export`) 구현
