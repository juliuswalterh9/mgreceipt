import { Router } from "express";
import {
  confirmReceipt,
  createUser,
  downloadReceipt,
  getUsers,
  listReceipts,
  receiptDetail,
  updateUser,
  updateUserStatus,
} from "../controllers/adminController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { adminMiddleware } from "../middlewares/adminMiddleware.js";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/users", getUsers);
router.post("/users", createUser);
router.put("/users/:id", updateUser);
router.put("/users/:id/status", updateUserStatus);
router.get("/receipts", listReceipts);
router.put("/receipts/:id/confirm", confirmReceipt);
router.get("/receipts/:id", receiptDetail);
router.get("/receipts/:id/download", downloadReceipt);

export default router;
