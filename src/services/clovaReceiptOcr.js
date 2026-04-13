import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAppVersion } from "../lib/version.js";
import { extractMaskedCardNumber, tryParseApprovedAtStrict } from "./ocrService.js";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function sanitizeCardValue(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[^0-9A-Za-z*#\- ]/g, "")
    .trim()
    .slice(0, 20);
}

function fieldText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const v = obj.formatted?.value ?? obj.text;
  return v != null ? String(v).trim() : "";
}

/** Document `totalPrice.price` 등 숫자/문자 혼합 금액 → 양의 정수 */
function parseAmountFromPriceObject(priceObj) {
  if (!priceObj || typeof priceObj !== "object") return 0;
  const raw = priceObj.formatted?.value ?? priceObj.text ?? fieldText(priceObj);
  const n = Number(String(raw).replace(/,/g, "").replace(/\D/g, ""));
  if (Number.isNaN(n) || n <= 0) return 0;
  return n;
}

function isClovaReceiptOnlyMode() {
  return String(process.env.CLOVA_OCR_RECEIPT_ONLY ?? "true").toLowerCase() === "true";
}

function fieldConfidence(obj) {
  if (!obj || typeof obj !== "object") return null;
  const c = obj.confidenceScore;
  return typeof c === "number" ? c : null;
}

export function isClovaReceiptOcrConfigured() {
  const secret = process.env.CLOVA_OCR_SECRET?.trim();
  const url = process.env.CLOVA_OCR_RECEIPT_URL?.trim();
  return Boolean(secret && url);
}

/** OCR/템플릿에서 섞인 HTML·각괄호 태그·불필요 공백 제거 */
function stripOcrNoise(s) {
  return String(s || "")
    .replace(/<[/]?[a-zA-Z][^>]*>/g, "")
    .replace(/<\/?>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pushIf(lines, line) {
  const t = String(line || "").trim();
  if (t) lines.push(t);
}

function pushNv(lines, name, value) {
  const v = value != null ? stripOcrNoise(String(value)) : "";
  if (v) lines.push(`${name}: ${v}`);
}

function clovaInvokePathHint() {
  const u = process.env.CLOVA_OCR_RECEIPT_URL?.trim();
  if (!u) return "(CLOVA_OCR_RECEIPT_URL unset)";
  try {
    return new URL(u).pathname || u;
  } catch {
    return u;
  }
}

/** `receipt.result` (Document) → 디버그용 `경로: 값` 줄 */
function documentResultToFlatNameValueLines(rec) {
  const lines = [];
  const si = rec.storeInfo || {};
  pushNv(lines, "receipt.result.storeInfo.name", fieldText(si.name));
  pushNv(lines, "receipt.result.storeInfo.subName", fieldText(si.subName));
  pushNv(lines, "receipt.result.storeInfo.bizNum", fieldText(si.bizNum));
  const pi = rec.paymentInfo || {};
  const df = pi.date?.formatted;
  if (df && typeof df === "object") {
    pushNv(lines, "receipt.result.paymentInfo.date.formatted.year", df.year);
    pushNv(lines, "receipt.result.paymentInfo.date.formatted.month", df.month);
    pushNv(lines, "receipt.result.paymentInfo.date.formatted.day", df.day);
  }
  const tf = pi.time?.formatted;
  if (tf && typeof tf === "object") {
    pushNv(lines, "receipt.result.paymentInfo.time.formatted.hour", tf.hour);
    pushNv(lines, "receipt.result.paymentInfo.time.formatted.minute", tf.minute);
    pushNv(lines, "receipt.result.paymentInfo.time.formatted.second", tf.second);
  }
  pushNv(lines, "receipt.result.paymentInfo.cardInfo.company", fieldText(pi.cardInfo?.company));
  pushNv(lines, "receipt.result.paymentInfo.cardInfo.number", fieldText(pi.cardInfo?.number));
  pushNv(lines, "receipt.result.paymentInfo.confirmNum", fieldText(pi.confirmNum));
  const tp = rec.totalPrice?.price;
  if (tp) {
    pushNv(lines, "receipt.result.totalPrice.price.text", tp.text);
    if (tp.formatted?.value != null) {
      pushNv(lines, "receipt.result.totalPrice.price.formatted.value", String(tp.formatted.value));
    }
  }
  return lines;
}

/** General `fields` → `이름: inferText` (트리 순회) */
function generalFieldsToNameValueLines(fields, base = "images[0].fields") {
  const lines = [];
  const walk = (arr, prefix) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      if (!f || typeof f !== "object") continue;
      const label = String(f.name ?? f.type ?? f.fieldType ?? "").trim() || `i${i}`;
      const raw = f.inferText ?? f.text ?? "";
      const text = stripOcrNoise(raw != null ? String(raw) : "");
      const p = `${prefix}[${i}]`;
      if (text) lines.push(`${p}.${label}: ${text}`);
      if (Array.isArray(f.subFields) && f.subFields.length) walk(f.subFields, `${p}.subFields`);
    }
  };
  walk(fields, base);
  return lines;
}

/** 콘솔·디버그용: 한 줄에 `key: value` 형태로만 출력 */
function buildClovaDebugKeyValueBlock(json) {
  const lines = [];
  const push = (key, value) => {
    if (value === undefined || value === null) return;
    const s = stripOcrNoise(String(value));
    if (s === "") return;
    lines.push(`${key}: ${s}`);
  };

  push("response.version", json?.version);
  push("response.requestId", json?.requestId);

  const img = json?.images?.[0];
  if (!img) {
    lines.push("(error): no images[0]");
    return lines.join("\n");
  }

  push("images[0].inferResult", img.inferResult);
  push("images[0].message", img.message);
  push("images[0].name", img.name);
  if (img.uid != null) push("images[0].uid", img.uid);

  const rec = img.receipt?.result;
  if (rec && typeof rec === "object") {
    lines.push("--- receipt.result (document flat) ---");
    lines.push(...documentResultToFlatNameValueLines(rec));
    const mapped = mapClovaReceiptResponse(json);
    if (mapped) {
      lines.push("--- app mapping ---");
      push("app.approvedAt", mapped.approvedAt);
      push("app.storeName", mapped.storeName);
      push("app.amount", mapped.amount);
      push("app.cardNumber", mapped.cardNumber);
      push("app.businessRegNo", mapped.businessRegNo);
      push("app.confidence", mapped.confidence);
      push("app.ocrEngine", mapped.ocrEngine);
    }
  } else {
    push("images[0].receipt.result", "(없음 — Document 아님 또는 실패)");
  }

  if (Array.isArray(img.fields) && img.fields.length > 0) {
    lines.push("--- general fields (optional) ---");
    lines.push(...generalFieldsToNameValueLines(img.fields));
  }

  return lines.length ? lines.join("\n") : "(empty debug payload)";
}

/**
 * CLOVA 응답 → 사람이 읽기 쉬운 Markdown (의미 없는 태그·빈 값 제거, JSON 원문 미포함)
 */
function clovaResponseToMarkdown(json, imageLabel) {
  const lines = [];
  const iso = new Date().toISOString();
  pushIf(lines, `## CLOVA OCR`);
  pushIf(lines, `- **시각**: ${iso}`);
  pushIf(lines, `- **앱 버전**: ${getAppVersion()} (package.json)`);
  pushIf(lines, `- **파일**: ${imageLabel}`);
  pushIf(lines, `- **CLOVA 응답 version**: ${json?.version ?? "—"}`);
  if (json?.requestId != null) pushIf(lines, `- **requestId**: ${json.requestId}`);
  pushIf(lines, `- **Invoke 경로**: \`${clovaInvokePathHint()}\``);

  const img = json?.images?.[0];
  if (!img) {
    pushIf(lines, `\n*(images 없음)*\n`);
    return lines.join("\n");
  }

  pushIf(lines, `\n### 상태`);
  pushIf(lines, `- inferResult: \`${img.inferResult ?? "—"}\``);
  if (img.message) pushIf(lines, `- message: ${stripOcrNoise(img.message)}`);
  if (img.name) pushIf(lines, `- name: ${stripOcrNoise(img.name)}`);
  const hasDoc = Boolean(img.receipt?.result && typeof img.receipt.result === "object");
  pushIf(lines, `- hasReceipt.result (Document): \`${hasDoc}\``);

  const rec = img.receipt?.result;
  if (rec && typeof rec === "object") {
    pushIf(lines, `\n### Document name:value (receipt.result)`);
    pushIf(lines, "```");
    const docFlat = documentResultToFlatNameValueLines(rec);
    lines.push(docFlat.length ? docFlat.join("\n") : "(receipt.result 있으나 추출 값 없음)");
    pushIf(lines, "```");

    const mapped = mapClovaReceiptResponse(json);
    if (mapped) {
      pushIf(lines, `\n### 앱 매핑 결과 (mapClovaReceiptResponse)`);
      pushIf(lines, "```");
      pushNv(lines, "approvedAt", mapped.approvedAt);
      pushNv(lines, "storeName", mapped.storeName);
      pushNv(lines, "amount", mapped.amount);
      pushNv(lines, "cardNumber", mapped.cardNumber);
      if (mapped.businessRegNo) pushNv(lines, "businessRegNo", mapped.businessRegNo);
      pushIf(lines, "```");
    }

    pushIf(lines, `\n### 매장·결제 (Document 요약)`);
    const si = rec.storeInfo || {};
    const pick = (o) => stripOcrNoise(fieldText(o));
    const n = pick(si.name);
    const sub = pick(si.subName);
    const biz = pick(si.bizNum);
    if (n || sub) pushIf(lines, `- **상호**: ${[n, sub].filter(Boolean).join(" / ")}`);
    if (biz) pushIf(lines, `- **사업자번호**: ${biz}`);

    const pi = rec.paymentInfo || {};
    const d = pi.date?.formatted;
    const t = pi.time?.formatted;
    if (d && typeof d === "object") {
      const ds = [d.year, d.month, d.day].filter((x) => x != null && x !== "").join("-");
      if (ds) pushIf(lines, `- **날짜**: ${ds}`);
    }
    if (t && typeof t === "object") {
      const ts = [t.hour, t.minute].filter((x) => x != null && x !== "").join(":");
      if (ts) pushIf(lines, `- **시각**: ${ts}`);
    }
    const card = pick(pi.cardInfo?.number);
    if (card) pushIf(lines, `- **카드번호**: ${card}`);

    const tp = rec.totalPrice?.price;
    if (tp) {
      const priceStr = stripOcrNoise(
        tp.formatted?.value != null ? String(tp.formatted.value) : fieldText(tp)
      );
      if (priceStr) pushIf(lines, `- **금액**: ${priceStr}`);
    }
    const lang = img.receipt?.meta?.estimatedLanguage;
    if (lang) pushIf(lines, `- **언어추정**: ${lang}`);
  }

  // General / Template — fields 트리
  if (Array.isArray(img.fields) && img.fields.length > 0) {
    pushIf(lines, `\n### General name:value (fields)`);
    pushIf(lines, "```");
    const genFlat = generalFieldsToNameValueLines(img.fields);
    lines.push(genFlat.length ? genFlat.join("\n") : "(필드 없음)");
    pushIf(lines, "```");

    pushIf(lines, `\n### 인식 필드 (General 트리)`);
    const walk = (fields, depth) => {
      const indent = "  ".repeat(depth);
      for (const f of fields) {
        if (!f || typeof f !== "object") continue;
        const rawText = f.inferText ?? f.text;
        const text = stripOcrNoise(rawText != null ? String(rawText) : "");
        const label = stripOcrNoise(f.name ?? f.type ?? f.fieldType ?? "");
        const conf = f.inferConfidence ?? f.confidence;
        const confStr = typeof conf === "number" ? ` _(${Math.round(conf * 1000) / 1000})_` : "";

        if (text) {
          if (label) {
            pushIf(lines, `${indent}- **${label}**${confStr}: ${text}`);
          } else {
            pushIf(lines, `${indent}- ${text}${confStr}`);
          }
        }
        if (Array.isArray(f.subFields) && f.subFields.length) walk(f.subFields, depth + 1);
      }
    };
    walk(img.fields, 0);
  }

  // 원문에 가까운 연속 텍스트 (General 요약)
  const { text: flatText } = extractClovaGeneralFullText(json);
  if (flatText && !img.receipt?.result) {
    pushIf(lines, `\n### 추출 텍스트 (연속)`);
    pushIf(lines, "```");
    lines.push(flatText.split("\n").map((ln) => stripOcrNoise(ln)).filter(Boolean).join("\n"));
    pushIf(lines, "```");
  }

  pushIf(lines, `\n---\n`);
  return lines.join("\n");
}

/**
 * 서비스 홈(process.cwd()) 아래 debug/clova-YYYY-MM-DD.md 에 Markdown append
 * CLOVA_OCR_DEBUG_SAVE=false 로 비활성화
 */
async function saveClovaResponseToDailyDebugFile(imageLabel, json) {
  if (String(process.env.CLOVA_OCR_DEBUG_LOG ?? "false").toLowerCase() === "true") {
    const kv = buildClovaDebugKeyValueBlock(json);
    console.info(
      `[Clova OCR debug v${getAppVersion()}] ${imageLabel}\n${kv.replace(/^/gm, "  ")}\n`
    );
  }
  if (String(process.env.CLOVA_OCR_DEBUG_SAVE ?? "true").toLowerCase() === "false") {
    return;
  }
  try {
    const debugDir = path.join(process.cwd(), "debug");
    await fs.mkdir(debugDir, { recursive: true });
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const filePath = path.join(debugDir, `clova-${dateStr}.md`);
    const md = clovaResponseToMarkdown(json, imageLabel);
    await fs.appendFile(filePath, md, "utf8");
  } catch (e) {
    console.warn("[Clova] debug 파일 저장 실패:", e instanceof Error ? e.message : e);
  }
}

/**
 * NCP Clova Document OCR — 영수증 API 응답 → 앱 필드
 * @see https://api.ncloud-docs.com/docs/ai-application-service-ocr-ocrdocumentocr-receipt
 */
/** General/Template OCR: images[].fields → inferText 수집 (subFields 재귀) */
function collectGeneralFieldTexts(fields, acc) {
  if (!Array.isArray(fields)) return;
  for (const f of fields) {
    if (f == null || typeof f !== "object") continue;
    const t = f.inferText ?? f.text;
    if (t != null && String(t).trim()) {
      acc.texts.push(String(t).trim());
      const c = f.inferConfidence ?? f.confidence;
      if (typeof c === "number") acc.confs.push(c);
    }
    if (Array.isArray(f.subFields)) collectGeneralFieldTexts(f.subFields, acc);
  }
}

/** General fields → `이름: 값` 줄(파싱용), name 없으면 값만 */
function collectClovaFieldKvLinesForParse(img) {
  const lines = [];
  const walk = (fields) => {
    if (!Array.isArray(fields)) return;
    for (const f of fields) {
      if (!f || typeof f !== "object") continue;
      const name = String(f.name ?? f.type ?? f.fieldType ?? "").trim();
      const raw = f.inferText ?? f.text ?? "";
      const v = String(raw).trim();
      if (name && v) lines.push(`${name}: ${v}`);
      else if (v) lines.push(v);
      if (Array.isArray(f.subFields)) walk(f.subFields);
    }
  };
  walk(img?.fields);
  return lines.join("\n");
}

/**
 * General(Template) OCR 응답 → 전체 텍스트 + 평균 신뢰도(0~1)
 */
export function extractClovaGeneralFullText(json) {
  const img = json?.images?.[0];
  if (!img || img.inferResult !== "SUCCESS") {
    return { text: "", avgConfidence: null };
  }
  const acc = { texts: [], confs: [] };
  collectGeneralFieldTexts(img.fields, acc);
  const text = acc.texts.join("\n").trim();
  const avgConfidence =
    acc.confs.length > 0 ? acc.confs.reduce((a, b) => a + b, 0) / acc.confs.length : null;
  return { text, avgConfidence };
}

/** images[].fields 등에서 name이 승인일시·카드번호인 inferText 우선 */
function extractLabelOverridesFromClovaFields(img) {
  let approvedAtFromLabel = null;
  let cardFromLabel = null;

  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, "")
      .replace(/[：:]/g, "")
      .toLowerCase();

  const walk = (fields) => {
    if (!Array.isArray(fields)) return;
    for (const f of fields) {
      if (!f || typeof f !== "object") continue;
      const nl = norm(f.name ?? f.type ?? f.fieldType ?? "");
      const chunk = String(f.inferText ?? f.text ?? "").trim();
      if (chunk && (/^승인일시/.test(nl) || /^승인시각/.test(nl) || /^거래일시/.test(nl))) {
        const at = tryParseApprovedAtStrict(chunk);
        if (at) approvedAtFromLabel = at;
      }
      if (chunk && /카드번호/.test(nl)) {
        const c = extractMaskedCardNumber(chunk) ?? sanitizeCardValue(chunk);
        if (c && c.length >= 8 && c !== "미인식") cardFromLabel = c.slice(0, 20);
      }
      if (Array.isArray(f.subFields)) walk(f.subFields);
    }
  };

  walk(img?.fields);
  return { approvedAtFromLabel, cardFromLabel };
}

export function mapClovaReceiptResponse(json) {
  const img = json?.images?.[0];
  if (!img || img.inferResult !== "SUCCESS" || !img.receipt?.result) {
    return null;
  }

  const result = img.receipt.result;
  const si = result.storeInfo || {};
  const name = fieldText(si.name);
  const sub = fieldText(si.subName);
  const storeName = [name, sub].filter(Boolean).join(" ").trim() || "매장명 미인식";

  const bizRaw = fieldText(si.bizNum);
  let businessRegNo = null;
  const bizDigits = bizRaw.replace(/\D/g, "");
  if (bizDigits.length === 10) {
    businessRegNo = `${bizDigits.slice(0, 3)}-${bizDigits.slice(3, 5)}-${bizDigits.slice(5)}`;
  }

  const pi = result.paymentInfo || {};
  const dateF = pi.date?.formatted;
  const timeF = pi.time?.formatted;
  let approvedAtApi;
  if (dateF?.year && dateF?.month != null && dateF?.day != null) {
    const y = String(dateF.year);
    const mo = pad2(Number(dateF.month));
    const d = pad2(Number(dateF.day));
    const h = timeF?.hour != null && timeF.hour !== "" ? pad2(Number(timeF.hour)) : "12";
    const mi = timeF?.minute != null && timeF.minute !== "" ? pad2(Number(timeF.minute)) : "00";
    approvedAtApi = `${y}-${mo}-${d}T${h}:${mi}`;
  } else {
    const now = new Date();
    approvedAtApi = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }

  const { approvedAtFromLabel, cardFromLabel } = extractLabelOverridesFromClovaFields(img);
  const approvedAt = approvedAtFromLabel ?? approvedAtApi;

  const cardRaw = fieldText(pi.cardInfo?.number);
  let cardNumberApi;
  if (cardRaw.length >= 4) {
    cardNumberApi = sanitizeCardValue(cardRaw);
  } else {
    cardNumberApi = "미인식";
  }
  const cardNumber = cardFromLabel ?? cardNumberApi;

  /** 승인·합계 금액: `totalPrice.price`(카드 매출전표의 합계·승인액에 해당) */
  const priceObj = result.totalPrice?.price;
  let amount = parseAmountFromPriceObject(priceObj);

  const confidences = [
    fieldConfidence(si.name),
    fieldConfidence(si.bizNum),
    fieldConfidence(pi.date),
    fieldConfidence(pi.time),
    fieldConfidence(pi.cardInfo?.number),
    fieldConfidence(priceObj),
  ].filter((c) => c != null);
  const confidence =
    confidences.length > 0
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100)
      : 75;

  const lines = [
    `상호: ${storeName}`,
    businessRegNo ? `사업자번호: ${businessRegNo}` : null,
    `승인일시: ${approvedAt.replace("T", " ")}`,
    `카드번호: ${cardNumber}`,
    amount ? `금액: ${amount}원` : null,
  ].filter(Boolean);

  return {
    approvedAt,
    cardNumber,
    amount,
    businessRegNo,
    storeName,
    user: null,
    recognizedText: lines.join("\n").slice(0, 4000),
    confidence,
    ocrEngine: "clova-receipt",
    clovaMeta: {
      inferResult: img.inferResult,
      message: img.message,
      estimatedLanguage: img.receipt?.meta?.estimatedLanguage,
      /** CLOVA Document 영수증 API 필드 ↔ 앱 필드 (NCP 스키마 기준) */
      documentFields: {
        approvedAt: "paymentInfo.date.formatted + paymentInfo.time.formatted → approvedAt",
        storeName: "storeInfo.name + storeInfo.subName → storeName (사용처)",
        amount: "totalPrice.price → amount (승인·합계 금액)",
        cardNumber: "paymentInfo.cardInfo.number → cardNumber",
      },
    },
  };
}

/**
 * @param {Buffer} jpegBuffer — prepareImageForOcr 결과 (JPEG)
 * @param {string} imageBaseName — 확장자 없는 파일명
 */
export async function callClovaReceiptApi(jpegBuffer, imageBaseName = "receipt") {
  const secret = process.env.CLOVA_OCR_SECRET?.trim();
  const apiUrl = process.env.CLOVA_OCR_RECEIPT_URL?.trim();
  if (!secret || !apiUrl) {
    throw new Error("CLOVA OCR 환경변수가 설정되지 않았습니다.");
  }

  const safeName = String(imageBaseName || "receipt").replace(/[^\w가-힣.-]/g, "_").slice(0, 64) || "receipt";
  const message = {
    version: "V2",
    requestId: randomUUID(),
    timestamp: Date.now(),
    images: [{ format: "jpg", name: safeName }],
  };

  const form = new FormData();
  form.append("message", JSON.stringify(message));
  const blob = new Blob([jpegBuffer], { type: "image/jpeg" });
  form.append("file", blob, `${safeName}.jpg`);

  const timeoutMs = Number(process.env.CLOVA_OCR_TIMEOUT_MS ?? 90000);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "X-OCR-SECRET": secret,
      },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(tid);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(`Clova OCR 응답 파싱 실패: ${text.slice(0, 200)}`);
    err.statusCode = res.status;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(
      json?.message || json?.error?.message || `Clova OCR HTTP ${res.status}`
    );
    err.statusCode = res.status;
    err.body = json;
    throw err;
  }

  await saveClovaResponseToDailyDebugFile(`file=${safeName}.jpg`, json);
  return json;
}

/**
 * Clova 설정됨 + 호출 성공 + inferResult SUCCESS 일 때만 결과 반환, 아니면 null
 */
export async function tryClovaReceiptOcr(jpegBuffer, imageBaseName) {
  if (!isClovaReceiptOcrConfigured()) return null;
  try {
    const json = await callClovaReceiptApi(jpegBuffer, imageBaseName);
    const receipt = mapClovaReceiptResponse(json);
    if (receipt) return receipt;

    if (isClovaReceiptOnlyMode()) {
      return null;
    }

    const img0 = json?.images?.[0];
    const kvBlock = collectClovaFieldKvLinesForParse(img0);
    const { text, avgConfidence } = extractClovaGeneralFullText(json);
    const combined = [kvBlock, text].filter((s) => String(s || "").trim()).join("\n");
    if (combined.trim().length >= 3) {
      const { parseReceiptFromText } = await import("./ocrService.js");
      const parsed = parseReceiptFromText(combined, imageBaseName);
      const confidence =
        avgConfidence != null ? Math.round(avgConfidence * 100) : 70;
      return {
        ...parsed,
        recognizedText: combined.slice(0, 4000),
        confidence,
        ocrEngine: "clova-general",
        clovaMeta: {
          inferResult: json?.images?.[0]?.inferResult,
          message: json?.images?.[0]?.message,
          mode: "general-template",
        },
      };
    }
    return null;
  } catch (e) {
    if (e?.statusCode === 401 || e?.statusCode === 403) {
      throw e;
    }
    if (e?.name === "AbortError") {
      console.warn("[Clova OCR] timeout");
    } else {
      console.warn("[Clova OCR]", e instanceof Error ? e.message : e);
    }
    return null;
  }
}
