import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import { isClovaReceiptOcrConfigured, tryClovaReceiptOcr } from "./clovaReceiptOcr.js";
import {
  extractReceiptByOllamaFromText,
  extractReceiptByOllamaFromClovaText,
  mergeClovaTrustedWithLlm,
  isOllamaReceiptOcrEnabled,
} from "./llmReceiptOcr.js";

function sanitizeCardValue(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[^0-9A-Za-z*#\- ]/g, "")
    .trim()
    .slice(0, 20);
}

/** @type {import('tesseract.js').Worker | null} */
let workerInstance = null;
let workerInitPromise = null;

/** 직렬화: Tesseract Worker는 동시 recognize에 안전하지 않음 */
let ocrChain = Promise.resolve();

function runOcrExclusive(task) {
  const run = ocrChain.then(() => task());
  ocrChain = run.catch(() => {});
  return run;
}

async function getWorker() {
  if (workerInstance) return workerInstance;
  if (!workerInitPromise) {
    workerInitPromise = (async () => {
      const w = await createWorker("kor+eng", 1, {
        logger: () => {},
      });
      await w.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
      workerInstance = w;
      return w;
    })();
  }
  return workerInitPromise;
}

/**
 * HEIC/대용량 이미지를 OCR에 맞게 JPEG 버퍼로 변환
 */
export async function prepareImageForOcr(buffer, mimetype) {
  const lower = (mimetype || "").toLowerCase();
  const pipeline = sharp(buffer, {
    failOnError: false,
    unlimited: true,
  })
    .rotate()
    .resize({
      width: 2400,
      height: 2400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true });

  try {
    return await pipeline.toBuffer();
  } catch (first) {
    if (lower.includes("heic") || lower.includes("heif")) {
      try {
        return await sharp(buffer).rotate().jpeg({ quality: 88 }).toBuffer();
      } catch {
        throw new Error(
          "HEIC 이미지 변환에 실패했습니다. 가능하면 JPG 또는 PNG로 저장 후 다시 시도해 주세요."
        );
      }
    }
    throw new Error(
      first instanceof Error ? first.message : "이미지를 읽을 수 없습니다. JPG/PNG 형식을 권장합니다."
    );
  }
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 라벨 비교용 (공백 제거·소문자) */
function normalizeKvLabel(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .toLowerCase();
}

/** 줄 단위 `이름: 값` (전각 콜론 허용) */
function matchKeyValueLine(line) {
  const m = String(line).match(/^(.{1,48}?)\s*[:：]\s*(.+)$/);
  if (!m) return null;
  return { label: m[1].trim(), value: m[2].trim() };
}

function parseAmountFromLabeledValue(value) {
  const re = /(\d{1,3}(?:,\d{3})+|\d{4,})/;
  const m = String(value).match(re);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  if (Number.isNaN(n) || n < 100 || n >= 1e12) return 0;
  return n;
}

/**
 * 카드번호: 숫자4 + 마스킹(2~6) + 마스킹(2~6) + 숫자4 (*, X, #, ＊ 등)
 * @param {string} value
 */
export function extractMaskedCardNumber(value) {
  const compact = String(value || "").replace(/\s/g, "");
  const full = compact.match(/^(\d{4})[-]?([*＊Xx#●○]{2,6})[-]?([*＊Xx#●○]{2,6})[-]?(\d{4})(?!\d)/);
  if (!full) return null;
  const v = sanitizeCardValue(`${full[1]}-${full[2]}-${full[3]}-${full[4]}`);
  return v.length >= 8 ? v : null;
}

/** 라벨 옆 값만 파싱 — 매칭 실패 시 null (현재 시각으로 채우지 않음) */
export function tryParseApprovedAtStrict(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  const patterns = [
    /(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})[일]?\s*[T\s]?(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /승인\s*(?:일시|시각|날짜)?\s*[:\s]*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/,
    /(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let y;
    let mo;
    let d;
    let h = 12;
    let min = 0;
    if (re.source.startsWith("(\\d{2})")) {
      y = 2000 + Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
      h = Number(m[4]);
      min = Number(m[5]);
    } else {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
      if (m[4] != null && m[4] !== undefined && m[4] !== "") {
        h = Number(m[4]);
        min = Number(m[5] ?? 0);
      }
    }
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    const dt = new Date(y, mo - 1, d, h, min, 0, 0);
    if (Number.isNaN(dt.getTime())) continue;
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  }
  return null;
}

function parseCardFromLabeledValue(value) {
  const raw = String(value || "").trim();
  const masked = extractMaskedCardNumber(raw);
  if (masked) return masked;
  return extractCardNumber(raw.replace(/\s+/g, " "));
}

/**
 * 명시적 `이름: 값` 줄에서 승인일시·승인금액·카드번호·상호(사용처) 등 추출
 * (CLOVA General 등 줄 단위로 잘 나올 때 우선)
 */
function extractLabeledReceiptFields(lines) {
  /** @type {{ approvedAt?: string, amount?: number, cardNumber?: string, storeName?: string, businessRegNo?: string | null }} */
  const out = {};
  let amountBest = 0;
  let amountScore = -1;

  const amountLabelScore = (nl) => {
    if (/승인금액/.test(nl)) return 5;
    if (/결제금액/.test(nl)) return 4;
    if (/청구금액/.test(nl)) return 3;
    if (/합계|총액/.test(nl)) return 2;
    if (/판매합계|거래금액/.test(nl)) return 2;
    if (/금액/.test(nl)) return 1;
    return 0;
  };

  for (const line of lines) {
    const kv = matchKeyValueLine(line);
    if (!kv) continue;
    const nl = normalizeKvLabel(kv.label);
    const v = kv.value;

    if (
      /^(승인일시|승인시각|승인날짜|거래일시|승인\s*일시|승인\s*시각)$/.test(nl) ||
      /^승인일시/.test(nl) ||
      /^승인시각/.test(nl)
    ) {
      const at = tryParseApprovedAtStrict(v);
      if (at) out.approvedAt = at;
    }

    if (
      /승인금액|결제금액|청구금액|합계|총액|판매합계|거래금액/.test(nl) ||
      (/금액/.test(nl) && !/단가|수량|부가세|vat/.test(nl))
    ) {
      const n = parseAmountFromLabeledValue(v);
      const sc = amountLabelScore(nl);
      if (n > 0 && sc >= amountScore) {
        amountScore = sc;
        amountBest = n;
      }
    }

    if (/카드번호|카드no|cardno|cardnumber/.test(nl)) {
      const c = parseCardFromLabeledValue(v);
      if (c && c !== "미인식") out.cardNumber = c;
    }

    if (
      /^상호$/.test(nl) ||
      /가맹점명?/.test(nl) ||
      /^매장명/.test(nl) ||
      /^사용처/.test(nl) ||
      /^점포/.test(nl)
    ) {
      const name = v.split(/[\n\r|]/)[0].trim();
      if (name.length >= 2 && name.length <= 80) out.storeName = name.slice(0, 80);
    }

    if (/사업자등록번호|사업자번호|등록번호/.test(nl)) {
      const biz = extractBusinessRegNo(v);
      if (biz) out.businessRegNo = biz;
    }
  }

  if (amountBest > 0) out.amount = amountBest;

  return out;
}

function isStoreLineCandidate(line) {
  const skip =
    /^(영\s*수\s*증|거\s*래\s*명\s*세|카\s*드\s*매\s*출|승\s*인|합\s*계|총\s*액|vat|부가세|tel|fax|www\.|http|사업자등록번호|주소|전화|고객용)/i;
  const isAddressLike = (ln) => {
    if (/([가-힣]{2,}\s*){1,2}[가-힣]{1,}(시|도)\s+.*(구|군)\s+.*(로|길)\s*\d+/.test(ln)) return true;
    if (/서울\s+.*구\s+.*(로|길)\s*\d+/.test(ln)) return true;
    if (/(시|도)\s+.*(구|군)\s+.*(로|길)\s*\d+/.test(ln)) return true;
    if (/[가-힣0-9]+\s*(로|길)\s*\d+/.test(ln)) return true;
    if (/[가-힣0-9]+\s*동\s*\d+/.test(ln)) return true;
    return false;
  };
  return (
    line.length >= 2 &&
    line.length <= 60 &&
    !skip.test(line) &&
    !isAddressLike(line) &&
    !/^\d+[\s,원]*$/.test(line) &&
    !/^\d{3}-\d{2}-\d{5}$/.test(line) &&
    !/^\d{2,4}[.\-/]\d/.test(line)
  );
}

/** 상호 라벨이 없을 때: 첫 파싱된 줄 목록에서 두 번째 줄을 사용처로 */
function extractStoreNameSecondLine(lines, text, originalFilename) {
  if (lines.length >= 2) {
    const second = lines[1].trim();
    if (isStoreLineCandidate(second) && !/(고객용|매\s*출\s*전\s*표|카\s*드\s*전\s*표)/i.test(second)) {
      return second.slice(0, 80);
    }
  }
  return extractStoreName(text, lines, originalFilename);
}

/**
 * 다양한 한국 영수증/카드전표 날짜 패턴 → datetime-local 문자열 (YYYY-MM-DDTHH:mm)
 */
function extractApprovedAt(text) {
  const t = text.replace(/\s+/g, " ");

  const patterns = [
    /(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})[일]?\s*[T\s]?(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /승인\s*(?:일시|시각|날짜)?\s*[:\s]*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/,
    /(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let y;
    let mo;
    let d;
    let h = 12;
    let min = 0;
    if (re.source.startsWith("(\\d{2})")) {
      y = 2000 + Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
      h = Number(m[4]);
      min = Number(m[5]);
    } else {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = Number(m[3]);
      if (m[4] != null && m[4] !== undefined && m[4] !== "") {
        h = Number(m[4]);
        min = Number(m[5] ?? 0);
      }
    }
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    const dt = new Date(y, mo - 1, d, h, min, 0, 0);
    if (Number.isNaN(dt.getTime())) continue;
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  }

  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function extractAmount(text, lines) {
  const joined = lines.join("\n");
  const keywordRegex = /(합계|결제\s*금액|승인\s*금액|청구\s*금액|총\s*액|판매\s*합계|거래\s*금액|결제금액)/;
  const keywordIdx = lines.findIndex((line) => keywordRegex.test(line));
  const keywordLine = keywordIdx >= 0 ? lines[keywordIdx] : undefined;
  const candidates = [];

  const tryLine = (line) => {
    if (!line) return;
    const re = /(\d{1,3}(?:,\d{3})+|\d{4,})(?:\s*원)?/g;
    let mm;
    while ((mm = re.exec(line)) !== null) {
      const n = Number(mm[1].replace(/,/g, ""));
      if (n >= 1000 && n < 1e12) candidates.push(n);
    }
  };

  // 1) "합계" 키워드가 있는 줄 자체에서 금액 추출
  tryLine(keywordLine);
  if (candidates.length) return Math.max(...candidates);

  // 2) "합계" 다음 줄에서 금액 추출 (요청 규칙 반영)
  if (keywordIdx >= 0 && lines[keywordIdx + 1]) {
    tryLine(lines[keywordIdx + 1]);
    if (candidates.length) return Math.max(...candidates);
  }

  // 3) "합계" 다음 2줄 범위에서 금액 패턴을 우선 탐색
  if (keywordIdx >= 0) {
    const nearLines = lines.slice(keywordIdx + 1, keywordIdx + 3);
    for (const line of nearLines) {
      tryLine(line);
    }
    if (candidates.length) return Math.max(...candidates);
  }

  const reGlobal = /(\d{1,3}(?:,\d{3})+|\d{4,})(?:\s*원)?/g;
  let m;
  while ((m = reGlobal.exec(joined)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1000 && n < 1e12) candidates.push(n);
  }
  const reWonPrefix = /원\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d{4,})/g;
  while ((m = reWonPrefix.exec(joined)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1000 && n < 1e12) candidates.push(n);
  }

  if (candidates.length) return Math.max(...candidates);
  return 0;
}

function extractCardNumber(text) {
  const lineByLine = text.split("\n").map((v) => v.trim());
  const keywordIdx = lineByLine.findIndex((line) =>
    /(카드\s*번호|card\s*no|card\s*number)/i.test(line)
  );

  const looksLikeCardValue = (v) => {
    if (!v) return false;
    const compact = v.replace(/\s/g, "");
    if (/^\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}$/.test(compact)) return true;
    if (/^\d{4}[- ]?(\*{2,}|X{2,})[- ]?(\*{2,}|X{2,})[- ]?\d{4}$/i.test(compact)) return true;
    if (/^\d{16}$/.test(compact)) return true;
    return false;
  };

  const pickCardPattern = (chunk) => {
    if (!chunk) return null;
    const masked = extractMaskedCardNumber(chunk);
    if (masked) return masked;
    const patterns = [
      /(?<!\d)(\d{4})[\s-]*(\*{2,}|X{2,})[\s-]*(\*{2,}|X{2,})[\s-]*(\d{4})(?!\d)/i,
      /(?<!\d)(\d{4})[\s-]+(\d{4})[\s-]+(\d{4})[\s-]+(\d{4})(?!\d)/,
      /(?<!\d)(\d{4})(\d{4})(\d{4})(\d{4})(?!\d)/,
    ];
    for (const re of patterns) {
      const m = chunk.match(re);
      if (m) {
        const v = sanitizeCardValue(m.slice(1).join("-"));
        if (looksLikeCardValue(v)) return v;
      }
    }
    return null;
  };

  if (keywordIdx >= 0) {
    // "카드번호" 줄 + 다음 2줄까지 우선 탐색 (현장 전표에서 값이 다음 줄로 내려가는 경우 대응)
    const near = lineByLine.slice(keywordIdx, keywordIdx + 3).join(" ");
    const m = near.match(
      /(?:카드\s*번호|card\s*no|card\s*number)\s*[:：]?\s*([0-9Xx*#\- ]{14,40})/i
    );
    if (m) {
      const v = sanitizeCardValue(m[1]);
      if (looksLikeCardValue(v)) return v;
    }
    const picked = pickCardPattern(near);
    if (picked) return picked;
  }

  const fallbackPicked = pickCardPattern(text);
  if (fallbackPicked) return fallbackPicked;

  return "미인식";
}

function extractBusinessRegNo(text) {
  const m = text.match(/(\d{3})[\s-]*(\d{2})[\s-]*(\d{5})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function extractStoreName(text, lines, originalFilename) {
  const labelPatterns = [
    /상\s*호\s*[:\s：]+(.{2,80})/,
    /가맹점\s*명?\s*[:\s：]+(.{2,80})/,
    /매장\s*명\s*[:\s：]+(.{2,80})/,
    /사업자\s*명\s*[:\s：]+(.{2,80})/,
    /점\s*포\s*[:\s：]+(.{2,80})/,
  ];
  for (const re of labelPatterns) {
    const m = text.match(re);
    if (m) {
      const name = m[1].split(/[\n\r|]/)[0].trim();
      if (name.length >= 2 && name.length <= 80) return name.slice(0, 80);
    }
  }

  const skip = /^(영\s*수\s*증|거\s*래\s*명\s*세|카\s*드\s*매\s*출|승\s*인|합\s*계|총\s*액|vat|부가세|tel|fax|www\.|http|사업자등록번호|주소|전화|고객용)/i;
  const isAddressLike = (line) => {
    // 예: "서울 강남구 테헤란로 33", "서울 **구 **로 33" 같은 주소 라인은 매장명 후보에서 제외
    if (/([가-힣]{2,}\s*){1,2}[가-힣]{1,}(시|도)\s+.*(구|군)\s+.*(로|길)\s*\d+/.test(line)) return true;
    if (/서울\s+.*구\s+.*(로|길)\s*\d+/.test(line)) return true;
    if (/(시|도)\s+.*(구|군)\s+.*(로|길)\s*\d+/.test(line)) return true;
    if (/[가-힣0-9]+\s*(로|길)\s*\d+/.test(line)) return true;
    if (/[가-힣0-9]+\s*동\s*\d+/.test(line)) return true;
    return false;
  };

  const isStoreCandidate = (line) =>
    line.length >= 2 &&
    line.length <= 60 &&
    !skip.test(line) &&
    !isAddressLike(line) &&
    !/^\d+[\s,원]*$/.test(line) &&
    !/^\d{3}-\d{2}-\d{5}$/.test(line) &&
    !/^\d{2,4}[.\-/]\d/.test(line);

  // 첫 줄은 주로 "영수증"이므로 제외하고, 다음 줄부터 상단 우선
  const firstLineCandidate = lines
    .slice(1, 5)
    .find(
      (line) => isStoreCandidate(line) && !/(고객용|매\s*출\s*전\s*표|카\s*드\s*전\s*표)/i.test(line)
    );
  if (firstLineCandidate) {
    return firstLineCandidate.slice(0, 80);
  }

  // 사업자등록번호 라인이 있는 경우, 그 바로 앞 1~2줄을 매장명으로 우선 검토
  const bizIdx = lines.findIndex((line) => /(사업자\s*등록\s*번호|사업자번호|등록번호|\d{3}\s*-\s*\d{2}\s*-\s*\d{5})/i.test(line));
  if (bizIdx > 0) {
    for (let i = Math.max(0, bizIdx - 2); i < bizIdx; i += 1) {
      const candidate = lines[i];
      if (isStoreCandidate(candidate) && !/(고객용|매\s*출\s*전\s*표|카\s*드\s*전\s*표)/i.test(candidate)) {
        return candidate.slice(0, 80);
      }
    }
  }

  const candidates = lines.slice(1, 14).filter((line) => isStoreCandidate(line));

  if (candidates.length) {
    const scored = candidates
      .map((line) => {
        const letters = (line.match(/[A-Za-z가-힣]/g) || []).length;
        const digits = (line.match(/\d/g) || []).length;
        const penalty = /(주문|포스|단말기|카드|승인|번호|거래)/.test(line) ? 3 : 0;
        const score = letters * 2 - digits - penalty;
        return { line, score };
      })
      .sort((a, b) => b.score - a.score);

    if (scored[0]?.line) {
      return scored[0].line.slice(0, 80);
    }
  }

  const base = originalFilename.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base.length >= 2 ? base.slice(0, 80) : "매장명 미인식";
}

/**
 * 스텁: 파일명 기반 (OCR 실패 시 폴백)
 */
export function parseReceiptFields(originalFilename) {
  const now = new Date();
  return {
    approvedAt: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    cardNumber: "미인식",
    amount: 0,
    businessRegNo: null,
    storeName: originalFilename.replace(/\.[^/.]+$/, "") || "매장명 미인식",
    user: null,
    recognizedText: "",
    confidence: 0,
    ocrEngine: "fallback",
  };
}

export function parseReceiptFromText(fullText, originalFilename = "") {
  const text = normalizeText(fullText);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const labeled = extractLabeledReceiptFields(lines);

  const approvedAt = labeled.approvedAt ?? extractApprovedAt(text);

  const amount =
    labeled.amount != null && labeled.amount > 0
      ? labeled.amount
      : extractAmount(text, lines) || 0;

  const cardNumber =
    labeled.cardNumber && labeled.cardNumber !== "미인식"
      ? labeled.cardNumber
      : extractCardNumber(text);

  const businessRegNo = labeled.businessRegNo ?? extractBusinessRegNo(text);

  let storeName;
  if (labeled.storeName && labeled.storeName.length >= 2) {
    storeName = labeled.storeName;
  } else {
    storeName = extractStoreNameSecondLine(lines, text, originalFilename);
  }

  return {
    approvedAt,
    cardNumber,
    amount: amount || 0,
    businessRegNo,
    storeName,
    user: null,
  };
}

/**
 * 이미지 버퍼에서 OCR 후 필드 추출
 */
export async function extractReceiptFromImage(buffer, mimetype, originalFilename = "") {
  const jpegBuffer = await prepareImageForOcr(buffer, mimetype);
  const baseName =
    path.basename(originalFilename || "receipt", path.extname(originalFilename || "")) || "receipt";
  const clovaOnlyMode = String(process.env.FORCE_CLOVA_OCR ?? "false").toLowerCase() === "true";

  try {
    const clova = await tryClovaReceiptOcr(jpegBuffer, baseName);
    if (clova) {
      const ocrText = String(clova.recognizedText || "").trim();
      if (
        isOllamaReceiptOcrEnabled() &&
        ocrText.length >= 10 &&
        String(process.env.CLOVA_OCR_LLM_REFINE ?? "true").toLowerCase() !== "false"
      ) {
        try {
          const trusted = {
            cardNumber: clova.cardNumber,
            approvedAt: clova.approvedAt,
            amount: clova.amount,
            businessRegNo: clova.businessRegNo,
            storeName: clova.storeName,
          };
          const llm = await extractReceiptByOllamaFromClovaText(ocrText, trusted);
          return mergeClovaTrustedWithLlm(trusted, llm, clova);
        } catch (e) {
          console.warn(
            "[OCR] CLOVA→LLM 후처리 실패, CLOVA 원본 반환:",
            e instanceof Error ? e.message : e
          );
          return {
            ...clova,
            ocrWarning: `LLM 사용처 보정 실패: ${
              e instanceof Error ? e.message : "Ollama 오류"
            }`,
          };
        }
      }
      return clova;
    }
    if (clovaOnlyMode) {
      if (!isClovaReceiptOcrConfigured()) {
        throw new Error(
          "CLOVA OCR 고정 모드입니다. CLOVA_OCR_SECRET, CLOVA_OCR_RECEIPT_URL을 .env에 설정해 주세요."
        );
      }
      throw new Error("CLOVA OCR 처리 결과가 유효하지 않습니다. 키/도메인/이미지 품질을 확인해 주세요.");
    }
  } catch (e) {
    if (clovaOnlyMode) {
      if (e?.statusCode === 401 || e?.statusCode === 403) {
        throw new Error(
          "CLOVA OCR 인증 실패: CLOVA_OCR_SECRET 또는 CLOVA_OCR_RECEIPT_URL이 잘못되었습니다."
        );
      }
      throw e;
    }
  }

  if (isOllamaReceiptOcrEnabled()) {
    // LLM 환각을 줄이기 위해: 이미지 -> Tesseract 텍스트 -> LLM 구조화로 처리
    const { text, confidence } = await runOcrExclusive(async () => {
      const worker = await getWorker();
      const {
        data: { text: rawText, confidence: conf },
      } = await worker.recognize(jpegBuffer);
      return { text: rawText || "", confidence: typeof conf === "number" ? conf : 0 };
    });
    const trimmedText = normalizeText(text);
    if (!trimmedText || trimmedText.length < 3) {
      const fallback = parseReceiptFields(originalFilename);
      return {
        ...fallback,
        recognizedText: trimmedText.slice(0, 4000),
        confidence: confidence || 0,
        ocrEngine: "tesseract",
        ocrWarning: "텍스트를 거의 읽지 못했습니다. 조명·초점을 확인하거나 JPG로 다시 촬영해 보세요.",
      };
    }

    try {
      const llm = await extractReceiptByOllamaFromText(trimmedText);
      // 핵심 필드가 비정상일 때는 기존 규칙 기반 파서로 폴백
      const parsedRule = parseReceiptFromText(trimmedText, originalFilename);
      // 핵심 3개 필드는 규칙 파서를 우선 사용해 환각/오인식을 차단
      const finalCard = parsedRule.cardNumber !== "미인식" ? parsedRule.cardNumber : llm.cardNumber;
      const finalAmount = Number(parsedRule.amount) > 0 ? parsedRule.amount : llm.amount;
      const finalStore = parsedRule.storeName !== "매장명 미인식" ? parsedRule.storeName : llm.storeName;

      return {
        ...llm,
        cardNumber: finalCard,
        amount: Number(finalAmount) > 0 ? Number(finalAmount) : 0,
        storeName: finalStore || "매장명 미인식",
        businessRegNo: parsedRule.businessRegNo ?? llm.businessRegNo ?? null,
        recognizedText: trimmedText.slice(0, 4000),
        ocrEngine: "ollama+rules",
        ocrWarning: "핵심 필드(카드번호/금액/사용처)는 규칙 기반으로 우선 보정했습니다.",
      };
    } catch (e) {
      const parsedRule = parseReceiptFromText(trimmedText, originalFilename);
      return {
        ...parsedRule,
        recognizedText: trimmedText.slice(0, 4000),
        confidence: confidence || 0,
        ocrEngine: "tesseract",
        ocrWarning: `Ollama OCR 실패로 규칙 기반 추출로 전환: ${
          e instanceof Error ? e.message : "로컬 LLM OCR 추출 실패"
        }`,
      };
    }
  }

  const { text, confidence } = await runOcrExclusive(async () => {
    const worker = await getWorker();
    const {
      data: { text: rawText, confidence: conf },
    } = await worker.recognize(jpegBuffer);
    return { text: rawText || "", confidence: typeof conf === "number" ? conf : 0 };
  });

  const trimmedText = normalizeText(text);
  if (!trimmedText || trimmedText.length < 3) {
    const fallback = parseReceiptFields(originalFilename);
    return {
      ...fallback,
      recognizedText: trimmedText.slice(0, 4000),
      confidence: confidence || 0,
      ocrEngine: "tesseract",
      ocrWarning: "텍스트를 거의 읽지 못했습니다. 조명·초점을 확인하거나 JPG로 다시 촬영해 보세요.",
    };
  }

  const parsed = parseReceiptFromText(text, originalFilename);
  return {
    ...parsed,
    recognizedText: trimmedText.slice(0, 4000),
    confidence: confidence || 0,
    ocrEngine: "tesseract",
  };
}
