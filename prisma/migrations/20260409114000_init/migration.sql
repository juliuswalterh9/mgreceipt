-- CreateTable
CREATE TABLE `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` VARCHAR(50) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `user_name` VARCHAR(100) NOT NULL,
  `department` VARCHAR(100) NOT NULL,
  `phone` VARCHAR(20) NULL,
  `email` VARCHAR(200) NULL,
  `position` VARCHAR(50) NULL,
  `role` ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  `remark` TEXT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `users_user_id_key`(`user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `receipts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `approved_at` DATETIME(3) NOT NULL,
  `card_number` VARCHAR(20) NOT NULL,
  `amount` BIGINT NOT NULL,
  `business_reg_no` VARCHAR(12) NULL,
  `store_name` VARCHAR(200) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `original_filename` VARCHAR(255) NOT NULL,
  `ocr_raw` JSON NULL,
  `admin_memo` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `receipts_user_id_idx`(`user_id`),
  INDEX `receipts_approved_at_idx`(`approved_at`),
  INDEX `receipts_approved_at_user_id_idx`(`approved_at`, `user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `receipts`
ADD CONSTRAINT `receipts_user_id_fkey`
FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
ON DELETE RESTRICT ON UPDATE CASCADE;
