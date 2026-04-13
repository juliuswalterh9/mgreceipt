import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "node:path";

import authRoutes from "./routes/auth.js";
import receiptRoutes from "./routes/receipts.js";
import adminRoutes from "./routes/admin.js";
import { getAppVersion } from "./lib/version.js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(path.resolve("public")));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
  })
);

app.get("/health", (_req, res) => {
  res.json({ success: true, message: "ok", version: getAppVersion() });
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/receipt.html"));
});

app.get("/info", (_req, res) => {
  res.json({
    success: true,
    version: getAppVersion(),
    message: "Receipt API server is running",
    endpoints: ["/", "/health", "/admin", "/info", "/api/auth", "/api/receipts", "/api/admin"],
    note: "사용자 영수증 화면은 루트(/)입니다. 예전 /receipt 주소는 / 로 리다이렉트됩니다.",
  });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve("public/admin.html"));
});

app.get("/receipt", (_req, res) => {
  res.redirect(301, "/");
});

app.use("/api/auth", authRoutes);
app.use("/api/receipts", receiptRoutes);
app.use("/api/admin", adminRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message: "요청한 API 경로를 찾을 수 없습니다.",
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "서버 오류가 발생했습니다.",
  });
});

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port} (v${getAppVersion()})`);
});
