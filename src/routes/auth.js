import { Router } from "express";
import {
  changePassword,
  login,
  logout,
  me,
  refresh,
  register,
} from "../controllers/authController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", authMiddleware, me);
router.post("/change-password", authMiddleware, changePassword);

export default router;
