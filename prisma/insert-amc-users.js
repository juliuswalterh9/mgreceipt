/**
 * AMC 사용자 일괄 등록/갱신
 * 기본 비밀번호: mg1234! (bcrypt 12 rounds, bcryptjs)
 * 실행: node prisma/insert-amc-users.js
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = "mg1234!";

const RAW = `
이민영	이민영	AMC1	admin
장유진	장유진	AMC4	admin
장유진	장유진	AMC4	admin
이승현	이승현	AMC1	user
정재진	정재진	AMC1	user
권태화	권태화	AMC1	user
김용우	김용우	AMC1	user
신상일	신상일	AMC1	user
김정현A	김정현A	AMC1	user
민성진	민성진	AMC1	user
이강보	이강보	AMC1	user
김지원	김지원	AMC1	user
정영훈	정영훈	AMC1	user
임세훈	임세훈	AMC1	user
민경은	민경은	AMC1	user
하동훈	하동훈	AMC1	user
양재용	양재용	AMC1	user
이수빈A	이수빈A	AMC1	user
안용민	안용민	AMC1	user
이원희	이원희	AMC1	user
정민성	정민성	AMC1	user
정순혁	정순혁	AMC1	user
강민경	강민경	AMC1	user
김재현B	김재현B	AMC1	user
김정규	김정규	AMC1	user
이정민	이정민	AMC1	user
조정국	조정국	AMC2	user
홍종현	홍종현	AMC2	user
황수익	황수익	AMC2	user
김택근	김택근	AMC2	user
이한기	이한기	AMC2	user
박혁	박혁	AMC2	user
이성란	이성란	AMC2	user
임영진	임영진	AMC2	user
이학영	이학영	AMC2	user
김민정B	김민정B	AMC2	user
김승수	김승수	AMC2	user
박성광	박성광	AMC2	user
안별	안별	AMC2	user
장솔	장솔	AMC2	user
김진호	김진호	AMC2	user
설영훈	설영훈	AMC2	user
박상민	박상민	AMC2	user
정자영	정자영	AMC2	user
이태형	이태형	AMC2	user
이희창	이희창	AMC2	user
전상연	전상연	AMC2	user
황선환	황선환	AMC2	user
박상철	박상철	AMC4	user
강재환	강재환	AMC4	user
윤성민A	윤성민A	AMC4	user
김영갑	김영갑	AMC4	user
김용재	김용재	AMC4	user
신원균	신원균	AMC4	user
이주영	이주영	AMC4	user
이준훈	이준훈	AMC4	user
윤성민B	윤성민B	AMC4	user
오세현	오세현	AMC4	user
`.trim();

function parseRows() {
  const seen = new Set();
  const out = [];
  for (const line of RAW.split("\n")) {
    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [userId, userName, department, roleRaw] = parts;
    if (!userId || !["user", "admin"].includes(roleRaw)) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, userName, department, role: roleRaw });
  }
  return out;
}

async function main() {
  const rows = parseRows();
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  for (const r of rows) {
    await prisma.user.upsert({
      where: { userId: r.userId },
      create: {
        userId: r.userId,
        passwordHash,
        userName: r.userName,
        department: r.department,
        role: r.role,
        isActive: true,
        phone: null,
        email: null,
        position: null,
        remark: null,
      },
      update: {
        passwordHash,
        userName: r.userName,
        department: r.department,
        role: r.role,
        isActive: true,
      },
    });
  }

  console.log(`AMC users upserted: ${rows.length} (duplicate user_id lines skipped)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
