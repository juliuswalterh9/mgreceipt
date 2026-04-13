-- AlterTable
ALTER TABLE `receipts` ADD COLUMN `admin_processed_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `receipts_admin_processed_at_idx` ON `receipts`(`admin_processed_at`);
