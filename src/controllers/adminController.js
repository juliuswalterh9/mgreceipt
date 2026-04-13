import { allReceipts } from "./receiptController.js";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { toSafeJson } from "../utils/serializer.js";
import fs from "node:fs";

export async function getUsers(req, res) {
  const keyword = req.query.keyword?.toString().trim();
  const where = keyword
    ? {
        OR: [
          { userName: { contains: keyword } },
          { department: { contains: keyword } },
        ],
      }
    : {};
  const users = await prisma.user.findMany({ where, orderBy: { createdAt: "desc" } });
  return res.json({ success: true, data: toSafeJson(users), total: users.length, page: 1, pageSize: 20 });
}

export async function createUser(req, res) {
  const { user_id, password, user_name, department, phone, email, position, role = "user", remark } =
    req.body;
  if (!user_id || !user_name || !department) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "필수 필드가 누락되었습니다.",
    });
  }
  const passwordHash = await bcrypt.hash(password ?? "ChangeMe123!", 12);
  try {
    const entity = await prisma.user.create({
      data: {
        userId: user_id,
        passwordHash,
        userName: user_name,
        department,
        phone: phone ?? null,
        email: email ?? null,
        position: position ?? null,
        role,
        remark: remark ?? null,
        isActive: true,
      },
    });
    return res.json({ success: true, data: toSafeJson(entity), message: "사용자 등록 완료" });
  } catch (e) {
    if (e?.code === "P2002") {
      return res.status(409).json({
        success: false,
        error: "DUPLICATE_USER_ID",
        message: "이미 존재하는 사용자 아이디입니다.",
      });
    }
    throw e;
  }
}

export async function updateUser(req, res) {
  const id = Number(req.params.id);
  const current = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!current) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "사용자 없음" });
  }
  const data = { ...req.body };
  if (req.body.password) {
    data.passwordHash = await bcrypt.hash(req.body.password, 12);
    delete data.password;
  }
  if (data.user_id) {
    data.userId = data.user_id;
    delete data.user_id;
  }
  if (data.user_name) {
    data.userName = data.user_name;
    delete data.user_name;
  }
  if (data.is_active !== undefined) {
    data.isActive = Boolean(data.is_active);
    delete data.is_active;
  }

  const updated = await prisma.user.update({
    where: { id: BigInt(id) },
    data,
  });
  return res.json({ success: true, data: toSafeJson(updated), message: "사용자 수정 완료" });
}

export async function updateUserStatus(req, res) {
  const id = Number(req.params.id);
  const exists = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!exists) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "사용자 없음" });
  }
  const updated = await prisma.user.update({
    where: { id: BigInt(id) },
    data: { isActive: Boolean(req.body.is_active) },
  });
  return res.json({ success: true, data: toSafeJson(updated), message: "상태 변경 완료" });
}

export function listReceipts(req, res) {
  return allReceipts(req, res);
}

export async function receiptDetail(req, res) {
  const id = Number(req.params.id);
  const entity = await prisma.receipt.findUnique({
    where: { id: BigInt(id) },
    include: { user: { select: { userName: true, department: true, userId: true } } },
  });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  return res.json({ success: true, data: toSafeJson(entity), message: "조회 성공" });
}

export async function downloadReceipt(req, res) {
  const id = Number(req.params.id);
  const entity = await prisma.receipt.findUnique({ where: { id: BigInt(id) } });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  if (!fs.existsSync(entity.filePath)) {
    return res.status(404).json({
      success: false,
      error: "FILE_NOT_FOUND",
      message: "원본 파일을 찾을 수 없습니다.",
    });
  }
  return res.download(entity.filePath, entity.originalFilename);
}

export async function confirmReceipt(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, error: "VALIDATION_ERROR", message: "잘못된 ID입니다." });
  }
  const entity = await prisma.receipt.findUnique({ where: { id: BigInt(id) } });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  if (entity.adminProcessedAt) {
    return res.json({
      success: true,
      data: toSafeJson(entity),
      message: "이미 처리된 영수증입니다.",
    });
  }
  const updated = await prisma.receipt.update({
    where: { id: BigInt(id) },
    data: { adminProcessedAt: new Date() },
    include: { user: { select: { userName: true, department: true, userId: true } } },
  });
  return res.json({ success: true, data: toSafeJson(updated), message: "처리 목록으로 이관되었습니다." });
}
