import fs from "node:fs/promises";
import path from "node:path";
import { extractReceiptFromImage, parseReceiptFields } from "../services/ocrService.js";
import { prisma } from "../lib/prisma.js";
import { toSafeJson } from "../utils/serializer.js";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads", "receipts");

function sanitizeFileToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
}

function formatDateForFilename(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown-date";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}_${hour}${minute}`;
}

export async function ocrReceipt(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "FILE_REQUIRED",
      message: "이미지 파일이 필요합니다.",
    });
  }

  try {
    const data = await extractReceiptFromImage(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    return res.json({
      success: true,
      data,
      message: data.ocrWarning ? "OCR 완료(일부 확인 필요)" : "OCR 처리 완료",
    });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(422).json({
      success: false,
      error: "OCR_FAILED",
      message: err instanceof Error ? err.message : "OCR 처리에 실패했습니다.",
    });
  }
}

export async function submitReceipt(req, res) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "FILE_REQUIRED",
      message: "이미지 파일이 필요합니다.",
    });
  }

  let parsed;
  try {
    parsed = await extractReceiptFromImage(req.file.buffer, req.file.mimetype, req.file.originalname);
  } catch {
    parsed = parseReceiptFields(req.file.originalname);
    parsed.ocrWarning = "이미지 OCR에 실패하여 파일명 기준으로 초기값을 채웠습니다.";
  }

  const approvedAt = req.body.approvedAt || parsed.approvedAt;
  const cardNumber = req.body.cardNumber ?? parsed.cardNumber;
  const amount = req.body.amount != null && req.body.amount !== "" ? req.body.amount : String(parsed.amount);
  const storeName = req.body.storeName ?? parsed.storeName;
  const businessRegNo = req.body.businessRegNo ?? parsed.businessRegNo ?? null;

  if (!approvedAt || !cardNumber || !amount || !storeName) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "필수 필드가 누락되었습니다.",
    });
  }

  const approvedDate = new Date(approvedAt);
  if (Number.isNaN(approvedDate.getTime())) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "승인일시 형식이 올바르지 않습니다.",
    });
  }

  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  const approvedDateToken = formatDateForFilename(approvedDate);
  const userToken = sanitizeFileToken(req.user.userId || "unknown-user");
  const baseFilename = `${approvedDateToken}_${userToken}`;
  const finalFilename = `${baseFilename}.jpg`;
  const filePath = path.join(UPLOAD_ROOT, finalFilename);
  await fs.writeFile(filePath, req.file.buffer);

  const digitsOnly = String(amount).replace(/\D/g, "");
  if (!digitsOnly) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "승인 금액이 올바르지 않습니다.",
    });
  }
  let amountBig;
  try {
    amountBig = BigInt(digitsOnly);
  } catch {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "승인 금액이 올바르지 않습니다.",
    });
  }

  const entity = await prisma.receipt.create({
    data: {
      userId: BigInt(req.user.id),
      approvedAt: approvedDate,
      cardNumber,
      amount: amountBig,
      businessRegNo,
      storeName,
      filePath,
      originalFilename: finalFilename,
      ocrRaw: {
        engine: parsed.ocrEngine ?? "tesseract",
        confidence: parsed.confidence ?? null,
        recognizedText: parsed.recognizedText ?? null,
        warning: parsed.ocrWarning ?? null,
        clovaMeta: parsed.clovaMeta ?? null,
        parsedAtSubmit: {
          approvedAt: parsed.approvedAt,
          cardNumber: parsed.cardNumber,
          amount: parsed.amount,
          storeName: parsed.storeName,
          businessRegNo: parsed.businessRegNo,
        },
      },
    },
  });
  return res.json({ success: true, data: toSafeJson(entity), message: "영수증 저장 완료" });
}

export async function createReceipt(req, res) {
  const payload = req.body;
  if (!payload.approvedAt || !payload.cardNumber || !payload.amount || !payload.storeName || !payload.filePath || !payload.originalFilename) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "필수 필드가 누락되었습니다.",
    });
  }

  const entity = await prisma.receipt.create({
    data: {
      userId: BigInt(req.user.id),
      approvedAt: new Date(payload.approvedAt),
      cardNumber: payload.cardNumber,
      amount: BigInt(payload.amount),
      businessRegNo: payload.businessRegNo ?? null,
      storeName: payload.storeName,
      filePath: payload.filePath,
      originalFilename: payload.originalFilename,
      ocrRaw: payload.ocrRaw ?? null,
    },
  });
  return res.json({ success: true, data: toSafeJson(entity), message: "영수증 저장 완료" });
}

export async function myReceipts(req, res) {
  const data = await prisma.receipt.findMany({
    where: { userId: BigInt(req.user.id) },
    orderBy: { approvedAt: "desc" },
  });
  return res.json({
    success: true,
    data: toSafeJson(data),
    total: data.length,
    page: 1,
    pageSize: data.length || 20,
  });
}

export async function receiptById(req, res) {
  const id = Number(req.params.id);
  const entity = await prisma.receipt.findFirst({
    where: { id: BigInt(id), userId: BigInt(req.user.id) },
  });
  if (!entity) {
    return res.status(404).json({
      success: false,
      error: "NOT_FOUND",
      message: "영수증을 찾을 수 없습니다.",
    });
  }
  return res.json({ success: true, data: toSafeJson(entity), message: "조회 성공" });
}

export async function allReceipts(req, res) {
  const page = Math.max(Number(req.query.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 20), 1), 100);
  const processedParam = req.query.processed?.toString().toLowerCase();
  const processedOnly = processedParam === "true" || processedParam === "1";
  const pendingOnly = processedParam === "false" || processedParam === "0" || processedParam === undefined;

  const where = {
    approvedAt: {
      gte: req.query.from ? new Date(`${req.query.from}T00:00:00`) : undefined,
      lte: req.query.to ? new Date(`${req.query.to}T23:59:59`) : undefined,
    },
    userId: req.query.userId ? BigInt(req.query.userId) : undefined,
    adminProcessedAt: processedOnly ? { not: null } : pendingOnly ? null : undefined,
  };
  const dept = req.query.department?.toString().trim();
  if (dept) {
    where.user = { department: dept };
  }

  const orderBy = processedOnly ? { adminProcessedAt: "desc" } : { approvedAt: "desc" };

  const [total, data] = await Promise.all([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where,
      include: { user: { select: { userName: true, department: true } } },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return res.json({ success: true, data: toSafeJson(data), total, page, pageSize });
}
