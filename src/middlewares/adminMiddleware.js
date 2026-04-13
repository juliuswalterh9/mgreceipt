export function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "FORBIDDEN",
      message: "관리자 권한이 필요합니다.",
    });
  }
  next();
}
