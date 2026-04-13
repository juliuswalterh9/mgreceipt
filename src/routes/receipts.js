import { Router } from "express";
import multer from "multer";
import {
  createReceipt,
  myReceipts,
  ocrReceipt,
  receiptById,
  submitReceipt,
} from "../controllers/receiptController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allow = ["image/jpeg", "image/png", "image/heic"].includes(file.mimetype);
    cb(allow ? null : new Error("지원하지 않는 파일 형식입니다."), allow);
  },
});

const router = Router();

router.post("/ocr", authMiddleware, upload.single("image"), ocrReceipt);
router.post("/submit", authMiddleware, upload.single("image"), submitReceipt);
router.post("/", authMiddleware, createReceipt);
router.get("/my", authMiddleware, myReceipts);
router.get("/:id", authMiddleware, receiptById);

export default router;
