import { allReceipts } from "./receiptController.js";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { toSafeJson } from "../utils/serializer.js";
import fs from "node:fs";

async function resolveAdminScope(req) {
  const adminId = Number(req.user?.id);
  if (!Number.isFinite(adminId)) return null;
  const admin = await prisma.user.findUnique({
    where: { id: BigInt(adminId) },
    select: { department: true, role: true, isActive: true },
  });
  if (!admin || !admin.isActive || admin.role !== "admin") return null;
  const department = String(admin.department ?? "").trim();
  const isGlobal = department === "전사";
  return { department, isGlobal };
}

function inDepartmentScope(scope, department) {
  if (!scope) return false;
  if (scope.isGlobal) return true;
  return String(department ?? "").trim() === scope.department;
}

export async function getUsers(req, res) {
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 조회 권한이 없습니다." });
  }
  const keyword = req.query.keyword?.toString().trim();
  const where = {
    AND: [
      !scope.isGlobal ? { department: scope.department } : {},
      keyword
        ? {
            OR: [{ userName: { contains: keyword } }, { department: { contains: keyword } }],
          }
        : {},
    ],
  };
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
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 수정 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  const current = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!current) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "사용자 없음" });
  }
  if (!inDepartmentScope(scope, current.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 사용자는 수정할 수 없습니다." });
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
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 수정 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  const exists = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!exists) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "사용자 없음" });
  }
  if (!inDepartmentScope(scope, exists.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 사용자는 수정할 수 없습니다." });
  }
  const updated = await prisma.user.update({
    where: { id: BigInt(id) },
    data: { isActive: Boolean(req.body.is_active) },
  });
  return res.json({ success: true, data: toSafeJson(updated), message: "상태 변경 완료" });
}

/** 관리자 강제 비밀번호 변경 (`users.password_hash` 갱신) */
export async function changeUserPasswordByAdmin(req, res) {
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 수정 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res
      .status(400)
      .json({ success: false, error: "VALIDATION_ERROR", message: "잘못된 사용자 ID입니다." });
  }

  const newPassword = String(req.body.newPassword ?? req.body.new_password ?? "").trim();
  if (newPassword.length < 4) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "새 비밀번호는 4자 이상으로 입력해 주세요.",
    });
  }

  const user = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!user) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "사용자 없음" });
  }
  if (!inDepartmentScope(scope, user.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 사용자는 수정할 수 없습니다." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: BigInt(id) },
    data: { passwordHash },
  });

  return res.json({ success: true, message: "비밀번호를 강제 변경했습니다." });
}

export function listReceipts(req, res) {
  // 부서 범위 강제: '전사'만 전체, 그 외는 본인 부서만
  return resolveAdminScope(req).then((scope) => {
    if (!scope) {
      return res
        .status(403)
        .json({ success: false, error: "FORBIDDEN", message: "관리자 조회 권한이 없습니다." });
    }
    if (!scope.isGlobal) {
      req.query = { ...req.query, department: scope.department };
    }
    return allReceipts(req, res);
  });
}

export async function receiptDetail(req, res) {
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 조회 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  const entity = await prisma.receipt.findUnique({
    where: { id: BigInt(id) },
    include: { user: { select: { userName: true, department: true, userId: true } } },
  });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  if (!inDepartmentScope(scope, entity.user?.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 영수증은 조회할 수 없습니다." });
  }
  return res.json({ success: true, data: toSafeJson(entity), message: "조회 성공" });
}

export async function downloadReceipt(req, res) {
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 조회 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  const entity = await prisma.receipt.findUnique({
    where: { id: BigInt(id) },
    include: { user: { select: { department: true } } },
  });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  if (!inDepartmentScope(scope, entity.user?.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 영수증은 다운로드할 수 없습니다." });
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
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 처리 권한이 없습니다." });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, error: "VALIDATION_ERROR", message: "잘못된 ID입니다." });
  }
  const entity = await prisma.receipt.findUnique({
    where: { id: BigInt(id) },
    include: { user: { select: { department: true } } },
  });
  if (!entity) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "영수증 없음" });
  }
  if (!inDepartmentScope(scope, entity.user?.department)) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "다른 부서 영수증은 처리할 수 없습니다." });
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

/** 미처리 영수증만 일괄 삭제(파일 포함). 부서 스코프는 목록·확인과 동일 */
export async function deletePendingReceiptsBulk(req, res) {
  const scope = await resolveAdminScope(req);
  if (!scope) {
    return res
      .status(403)
      .json({ success: false, error: "FORBIDDEN", message: "관리자 삭제 권한이 없습니다." });
  }

  const raw = req.body?.receiptIds ?? req.body?.ids ?? [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "삭제할 영수증 ID를 하나 이상 보내 주세요.",
    });
  }

  const numericIds = [...new Set(raw.map((v) => Number(v)).filter(Number.isFinite))];
  if (numericIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "유효한 영수증 ID가 없습니다.",
    });
  }

  const bigIds = numericIds.map((n) => BigInt(n));
  const userWhere = scope.isGlobal ? {} : { user: { department: scope.department } };

  const pending = await prisma.receipt.findMany({
    where: {
      id: { in: bigIds },
      adminProcessedAt: null,
      ...userWhere,
    },
    select: { id: true, filePath: true },
  });

  if (pending.length === 0) {
    return res.json({
      success: true,
      data: { deleted: 0, requested: numericIds.length },
      message: "삭제할 미처리 영수증이 없습니다(이미 처리됨·권한 밖·존재하지 않음).",
    });
  }

  for (const row of pending) {
    const fp = row.filePath;
    if (fp && fs.existsSync(fp)) {
      try {
        fs.unlinkSync(fp);
      } catch {
        // DB 삭제는 계속 진행
      }
    }
  }

  await prisma.receipt.deleteMany({
    where: { id: { in: pending.map((p) => p.id) } },
  });

  const skipped = numericIds.length - pending.length;
  let message = `${pending.length}건의 미처리 영수증을 삭제했습니다.`;
  if (skipped > 0) {
    message += ` (${skipped}건은 이미 처리됨·다른 부서·없는 ID로 건너뜀)`;
  }

  return res.json({
    success: true,
    data: { deleted: pending.length, requested: numericIds.length, skipped },
    message,
  });
}
