import { randomUUID } from "node:crypto";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function nowAsLocalDateTime() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(
    now.getHours()
  )}:${pad2(now.getMinutes())}`;
}

function sanitizeCardValue(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[^0-9A-Za-z*#\- ]/g, "")
    .trim()
    .slice(0, 20);
}

function sanitizeBusinessRegNo(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
  return null;
}

function normalizeApprovedAt(raw) {
  const v = String(raw || "").trim();
  if (!v) return nowAsLocalDateTime();
  const basic = v.replace(" ", "T");
  const m = basic.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:T(\d{1,2}):(\d{2}))?/);
  if (!m) return nowAsLocalDateTime();
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? 12);
  const minute = Number(m[5] ?? 0);
  if (
    year < 1990 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return nowAsLocalDateTime();
  }
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

function buildVisionPrompt() {
  return [
    "당신은 한국 카드 영수증 OCR 추출기입니다.",
    "이미지에서 아래 필드를 추출해 JSON만 반환하세요.",
    "규칙:",
    "1) 응답은 JSON 객체 하나만 반환 (설명 문장 금지).",
    "2) 카드번호는 원문 최대한 유지(마스킹/하이픈 포함 가능), 20자 이내.",
    "3) 승인일시는 YYYY-MM-DDTHH:mm 형식.",
    "4) amount는 숫자만 (원 단위 정수).",
    "5) storeName은 사용처(상호). '영수증', '고객용', 주소 라인 제외.",
    "6) businessRegNo는 123-45-67890 형식 또는 null.",
    "7) confidence는 0~100 숫자.",
    "필드 스키마:",
    "{",
    '  "approvedAt": "YYYY-MM-DDTHH:mm",',
    '  "cardNumber": "string",',
    '  "amount": 0,',
    '  "businessRegNo": "123-45-67890" or null,',
    '  "storeName": "string",',
    '  "confidence": 0,',
    '  "recognizedText": "근거 텍스트 요약"',
    "}",
  ].join("\n");
}

function buildTextPrompt(recognizedText) {
  return [
    "당신은 한국 카드 영수증 정보 추출기입니다.",
    "아래 OCR 텍스트에서만 근거를 찾아 JSON 하나만 반환하세요.",
    "텍스트에 없는 정보는 추측하지 말고 null 또는 '미인식'을 사용하세요.",
    "규칙:",
    "1) 카드번호는 OCR 원문을 유지(하이픈/마스킹 포함), 최대 20자.",
    "   - 반드시 '카드번호' 키워드 근처에서 우선 찾는다.",
    "   - 보통 4자리 4블록(중간 마스킹 포함) 패턴을 우선한다.",
    "2) 승인일시는 YYYY-MM-DDTHH:mm 형식. 없으면 null.",
    "3) 금액은 '합계' 다음 줄/근처 값을 우선해 숫자만.",
    "4) storeName은 상호. '영수증', '고객용', 주소 라인 제외.",
    "5) businessRegNo는 123-45-67890 형식 또는 null.",
    "6) confidence는 0~100.",
    "출력 JSON 스키마:",
    '{"approvedAt": null, "cardNumber":"미인식", "amount":0, "businessRegNo": null, "storeName":"매장명 미인식", "confidence":0, "recognizedText":"근거 요약"}',
    "OCR_TEXT_BEGIN",
    recognizedText,
    "OCR_TEXT_END",
  ].join("\n");
}

/**
 * CLOVA OCR 텍스트 + 이미 신뢰하는 필드(카드·승인일시 등)를 넣고 LLM으로 사용처(상호) 위주 보정
 * @param {string} recognizedText
 * @param {{ cardNumber: string, approvedAt: string, amount?: number, businessRegNo?: string | null, storeName?: string }} trusted
 */
function buildClovaAssistedPrompt(recognizedText, trusted) {
  const amt = Number(trusted.amount);
  const amtHint = Number.isFinite(amt) && amt > 0 ? String(amt) : "0 (텍스트에서 합계·승인금액을 찾을 것)";
  const bizHint = trusted.businessRegNo
    ? `참고로 CLOVA가 인식한 사업자번호: ${trusted.businessRegNo} (텍스트와 일치하면 그대로 사용)`
    : "사업자번호는 텍스트에 XXX-XX-XXXXX 형태가 있으면 추출, 없으면 null.";
  return [
    "당신은 한국 카드 영수증 OCR 후처리기입니다.",
    "아래 CLOVA OCR 전체 텍스트만 근거로 판단하세요. 추측으로 값을 만들지 마세요.",
    "",
    "[이미 정확히 텍스트화된 값 — JSON에 아래 문자열과 완전히 동일하게 넣을 것, 절대 변경 금지]",
    `- cardNumber: ${trusted.cardNumber}`,
    `- approvedAt: ${trusted.approvedAt}`,
    "",
    "[금액 amount]",
    `- 숫자(원 단위 정수). 텍스트에 합계·승인금액·결제금액이 분명하면 그 값.`,
    `- 애매하면 우선 참고: ${amtHint}`,
    "",
    "[사업자번호 businessRegNo]",
    bizHint,
    "",
    "[사용처 storeName — 가장 중요]",
    "한국 영수증 상단은 보통 다음이 한 덩어리로 구성되는 경우가 많습니다:",
    "- '상호' 또는 가맹점명 라벨과 그 값",
    "- '사업자등록번호' 또는 10자리 숫자(XXX-XX-XXXXX)",
    "- '대표' 또는 대표자 성명",
    "storeName에는 위 블록에서 **상호(가맹점·매장 이름)**에 해당하는 문자열만 넣으세요.",
    "'영수증', '고객용', 주소만 있는 줄, 전화/FAX만 있는 줄은 제외하세요.",
    "대표자 개인 이름만 단독으로 나온 경우를 storeName으로 선택하지 마세요(상호가 따로 있으면 상호만).",
    trusted.storeName && trusted.storeName !== "매장명 미인식"
      ? `CLOVA 초기 추정 상호(참고): ${trusted.storeName}`
      : "",
    "",
    "응답은 JSON 하나만. 설명 문장 금지.",
    "스키마:",
    '{"approvedAt":"위 고정값과 동일","cardNumber":"위 고정값과 동일","amount":0,"businessRegNo":null,"storeName":"","confidence":0,"recognizedText":"상호 판단 근거 한 줄"}',
    "",
    "OCR_TEXT_BEGIN",
    String(recognizedText || "").slice(0, 8000),
    "OCR_TEXT_END",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 모델이 코드펜스/부연설명을 붙이는 경우를 대비해 첫 JSON 블록 추출
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = raw.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function isOllamaReceiptOcrEnabled() {
  return String(process.env.USE_OLLAMA_RECEIPT_OCR ?? "false").toLowerCase() === "true";
}

async function callOllamaGenerate({ model, prompt, images }) {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        images: images ?? [],
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
        },
      }),
    });
  } finally {
    clearTimeout(tid);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama OCR 호출 실패 (${response.status}): ${bodyText.slice(0, 180)}`);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error("Ollama OCR 응답 파싱 실패");
  }

  return body;
}

function normalizeResult(parsed, responseText, model) {
  return {
    approvedAt: parsed.approvedAt ? normalizeApprovedAt(parsed.approvedAt) : null,
    cardNumber: sanitizeCardValue(parsed.cardNumber) || "미인식",
    amount: Number(String(parsed.amount ?? "0").replace(/\D/g, "")) || 0,
    businessRegNo: sanitizeBusinessRegNo(parsed.businessRegNo),
    storeName: String(parsed.storeName || "").trim().slice(0, 80) || "매장명 미인식",
    user: null,
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence ?? 65) || 65)),
    recognizedText: String(parsed.recognizedText || responseText || "").slice(0, 4000),
    ocrEngine: "ollama",
    ollamaMeta: {
      model,
      requestId: randomUUID(),
    },
  };
}

export async function extractReceiptByOllama(buffer) {
  const model = process.env.OLLAMA_OCR_MODEL?.trim() || "llava:13b";
  const body = await callOllamaGenerate({
    model,
    prompt: buildVisionPrompt(),
    images: [buffer.toString("base64")],
  });
  const parsed = extractJsonObject(body?.response);
  if (!parsed) {
    throw new Error("Ollama OCR 결과에서 JSON 필드를 읽지 못했습니다.");
  }
  return normalizeResult(parsed, body?.response, model);
}

export async function extractReceiptByOllamaFromText(recognizedText) {
  const model = process.env.OLLAMA_OCR_MODEL?.trim() || "llama3.1:latest";
  const body = await callOllamaGenerate({
    model,
    prompt: buildTextPrompt(String(recognizedText || "").slice(0, 8000)),
  });
  const parsed = extractJsonObject(body?.response);
  if (!parsed) {
    throw new Error("Ollama 텍스트 추출 결과에서 JSON 필드를 읽지 못했습니다.");
  }
  return normalizeResult(parsed, body?.response, model);
}

/**
 * CLOVA OCR 텍스트를 LLM에 넣어 사용처(상호) 보정. 카드·승인일시는 trusted로 병합 시 고정.
 * @param {string} recognizedText
 * @param {{ cardNumber: string, approvedAt: string, amount?: number, businessRegNo?: string | null, storeName?: string }} trusted
 */
export async function extractReceiptByOllamaFromClovaText(recognizedText, trusted) {
  const model = process.env.OLLAMA_OCR_MODEL?.trim() || "llama3.1:latest";
  const body = await callOllamaGenerate({
    model,
    prompt: buildClovaAssistedPrompt(String(recognizedText || ""), trusted),
  });
  const parsed = extractJsonObject(body?.response);
  if (!parsed) {
    throw new Error("Ollama(CLOVA 보조) 결과에서 JSON 필드를 읽지 못했습니다.");
  }
  return normalizeResult(parsed, body?.response, model);
}

/**
 * LLM 출력과 CLOVA 신뢰 필드를 합침 — 카드번호·승인일시는 항상 CLOVA 우선
 * @param {{ cardNumber: string, approvedAt: string, amount?: number, businessRegNo?: string | null, storeName?: string }} trusted
 * @param {Awaited<ReturnType<typeof normalizeResult>>} llmNormalized
 * @param {Record<string, unknown>} clovaFull — recognizedText, confidence, clovaMeta 보존용
 */
export function mergeClovaTrustedWithLlm(trusted, llmNormalized, clovaFull) {
  const llmStore = String(llmNormalized.storeName || "").trim();
  const fallbackStore = String(trusted.storeName || "").trim();
  const storeName =
    llmStore && llmStore !== "매장명 미인식"
      ? llmStore.slice(0, 80)
      : fallbackStore.slice(0, 80) || "매장명 미인식";

  const ta = Number(trusted.amount);
  const amount =
    Number.isFinite(ta) && ta > 0 ? ta : Number(llmNormalized.amount) || 0;

  const trustedBiz =
    trusted.businessRegNo != null && String(trusted.businessRegNo).trim() !== ""
      ? sanitizeBusinessRegNo(trusted.businessRegNo)
      : null;
  const biz = trustedBiz ?? llmNormalized.businessRegNo;

  const cc = Number(clovaFull?.confidence);
  const lc = Number(llmNormalized.confidence);
  const confidence = Math.max(
    Number.isFinite(cc) ? cc : 0,
    Number.isFinite(lc) ? lc : 0,
    65
  );

  return {
    ...llmNormalized,
    approvedAt: normalizeApprovedAt(trusted.approvedAt),
    cardNumber: sanitizeCardValue(trusted.cardNumber) || llmNormalized.cardNumber,
    amount,
    businessRegNo: biz,
    storeName,
    recognizedText: String(clovaFull?.recognizedText ?? llmNormalized.recognizedText ?? "").slice(
      0,
      4000
    ),
    confidence: Math.min(100, confidence),
    ocrEngine: "clova+ollama",
    clovaMeta: clovaFull?.clovaMeta,
    ollamaMeta: llmNormalized.ollamaMeta,
  };
}
