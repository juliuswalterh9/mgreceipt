import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const adminUserId = process.env.SEED_ADMIN_USER_ID ?? "admin";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin1234!";
  const adminName = process.env.SEED_ADMIN_NAME ?? "시스템관리자";
  const adminDept = process.env.SEED_ADMIN_DEPARTMENT ?? "IT 전략팀";

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
    where: { userId: adminUserId },
    update: {
      passwordHash,
      userName: adminName,
      department: adminDept,
      role: "admin",
      isActive: true,
    },
    create: {
      userId: adminUserId,
      passwordHash,
      userName: adminName,
      department: adminDept,
      role: "admin",
      isActive: true,
      email: null,
      phone: null,
      position: null,
      remark: "seed로 생성된 기본 관리자 계정",
    },
  });

  const demoUserId = process.env.SEED_USER_USER_ID ?? "user01";
  const demoPassword = process.env.SEED_USER_PASSWORD ?? "1";
  const demoName = process.env.SEED_USER_NAME ?? "일반사용자";
  const demoDept = process.env.SEED_USER_DEPARTMENT ?? "일반";

  const demoHash = await bcrypt.hash(demoPassword, 12);

  await prisma.user.upsert({
    where: { userId: demoUserId },
    update: {
      passwordHash: demoHash,
      userName: demoName,
      department: demoDept,
      role: "user",
      isActive: true,
    },
    create: {
      userId: demoUserId,
      passwordHash: demoHash,
      userName: demoName,
      department: demoDept,
      role: "user",
      isActive: true,
      email: null,
      phone: null,
      position: null,
      remark: "seed로 생성된 일반 사용자",
    },
  });

  console.log("Seed complete: admin + demo user upserted");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
