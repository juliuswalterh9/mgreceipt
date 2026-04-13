import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization ?? "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      error: "UNAUTHORIZED",
      message: "인증 토큰이 필요합니다.",
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (_e) {
    return res.status(401).json({
      success: false,
      error: "TOKEN_EXPIRED_OR_INVALID",
      message: "토큰이 유효하지 않습니다.",
    });
  }
}
