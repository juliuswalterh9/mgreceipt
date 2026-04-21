import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { toSafeJson } from "../utils/serializer.js";

const refreshTokenStore = new Map();

function buildTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id.toString(), userId: user.userId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  const refreshToken = jwt.sign(
    { id: user.id.toString(), userId: user.userId, role: user.role, t: Date.now() },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
  refreshTokenStore.set(refreshToken, user.id);
  return { accessToken, refreshToken };
}

export async function register(req, res) {
  const { user_id, password, user_name, department, phone, email, position, role = "user", remark } =
    req.body;
  if (!user_id || !password || !user_name || !department) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "필수 필드가 누락되었습니다.",
    });
  }

  const exists = await prisma.user.findUnique({ where: { userId: user_id } });
  if (exists) {
    return res.status(409).json({
      success: false,
      error: "DUPLICATE_USER_ID",
      message: "이미 존재하는 사용자 아이디입니다.",
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
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
    },
  });

  return res.json({ success: true, message: "등록 완료" });
}

export async function login(req, res) {
  const { user_id, password } = req.body;
  const user = await prisma.user.findUnique({ where: { userId: user_id } });

  if (!user || !user.isActive) {
    return res.status(401).json({
      success: false,
      error: "INVALID_CREDENTIALS",
      message: "아이디 또는 비밀번호가 올바르지 않습니다.",
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({
      success: false,
      error: "INVALID_CREDENTIALS",
      message: "아이디 또는 비밀번호가 올바르지 않습니다.",
    });
  }

  const { accessToken, refreshToken } = buildTokens(user);
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({
    success: true,
    data: { accessToken },
    message: "로그인 성공",
  });
}

export function refresh(req, res) {
  const token = req.cookies.refreshToken;
  if (!token || !refreshTokenStore.has(token)) {
    return res.status(401).json({
      success: false,
      error: "INVALID_REFRESH_TOKEN",
      message: "Refresh Token이 유효하지 않습니다.",
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const accessToken = jwt.sign(
      { id: payload.id, userId: payload.userId, role: payload.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({ success: true, data: { accessToken }, message: "재발급 완료" });
  } catch (_e) {
    return res.status(401).json({
      success: false,
      error: "INVALID_REFRESH_TOKEN",
      message: "Refresh Token이 만료되었거나 유효하지 않습니다.",
    });
  }
}

export function logout(req, res) {
  const token = req.cookies.refreshToken;
  if (token) {
    refreshTokenStore.delete(token);
  }
  res.clearCookie("refreshToken");
  return res.json({ success: true, message: "로그아웃 완료" });
}

export function me(req, res) {
  return res.json({ success: true, data: toSafeJson(req.user), message: "조회 성공" });
}

/** 로그인 사용자 본인 비밀번호 변경 (DB `password_hash` 갱신) */
export async function changePassword(req, res) {
  const currentPassword = req.body.currentPassword ?? req.body.current_password;
  const newPassword = req.body.newPassword ?? req.body.new_password;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "현재 비밀번호와 새 비밀번호를 입력해 주세요.",
    });
  }
  const next = String(newPassword);
  if (next.length < 4) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "새 비밀번호는 4자 이상으로 설정해 주세요.",
    });
  }

  const userId = BigInt(req.user.id);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) {
    return res.status(404).json({
      success: false,
      error: "NOT_FOUND",
      message: "사용자를 찾을 수 없습니다.",
    });
  }

  const ok = await bcrypt.compare(String(currentPassword), user.passwordHash);
  if (!ok) {
    return res.status(401).json({
      success: false,
      error: "INVALID_PASSWORD",
      message: "현재 비밀번호가 올바르지 않습니다.",
    });
  }

  const same = await bcrypt.compare(next, user.passwordHash);
  if (same) {
    return res.status(400).json({
      success: false,
      error: "VALIDATION_ERROR",
      message: "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
    });
  }

  const passwordHash = await bcrypt.hash(next, 12);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return res.json({ success: true, message: "비밀번호가 변경되었습니다." });
}
