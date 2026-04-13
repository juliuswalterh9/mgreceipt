const TOKEN_KEY = "receipt_access_token";
/** /health 실패 시 표시 (package.json 과 맞출 것) */
const APP_VERSION_FALLBACK = "v1.2.0";

const $ = (id) => document.getElementById(id);

const els = {
  loginCard: $("loginCard"),
  mainCard: $("mainCard"),
  userId: $("userId"),
  password: $("password"),
  loginBtn: $("loginBtn"),
  loginMsg: $("loginMsg"),
  logoutBtn: $("logoutBtn"),
  userLabel: $("userLabel"),
  previewImg: $("previewImg"),
  previewPlaceholder: $("previewPlaceholder"),
  fileCamera: $("fileCamera"),
  fileGallery: $("fileGallery"),
  pickCameraBtn: $("pickCameraBtn"),
  pickGalleryBtn: $("pickGalleryBtn"),
  approvedAt: $("approvedAt"),
  cardNumber: $("cardNumber"),
  amount: $("amount"),
  storeName: $("storeName"),
  businessRegNo: $("businessRegNo"),
  appVersion: $("appVersion"),
  ocrBtn: $("ocrBtn"),
  submitBtn: $("submitBtn"),
  mainMsg: $("mainMsg"),
};

let selectedFile = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function showMsg(el, text, type) {
  el.innerHTML = "";
  if (!text) return;
  const div = document.createElement("div");
  const cls = type === "ok" ? "ok" : type === "info" ? "info" : "error";
  div.className = `msg ${cls}`;
  div.textContent = text;
  el.appendChild(div);
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.message ?? `오류 (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function setPreview(file) {
  selectedFile = file;
  els.submitBtn.disabled = !file;
  if (!file) {
    els.previewImg.classList.add("hidden");
    els.previewPlaceholder.classList.remove("hidden");
    els.previewImg.removeAttribute("src");
    return;
  }
  const url = URL.createObjectURL(file);
  els.previewImg.onload = () => URL.revokeObjectURL(url);
  els.previewImg.src = url;
  els.previewImg.classList.remove("hidden");
  els.previewPlaceholder.classList.add("hidden");
}

/** 저장 후 또는 초기화: 입력·파일·미리보기 리셋 (로그인 상태 유지) */
function resetReceiptForm() {
  selectedFile = null;
  if (els.fileCamera) els.fileCamera.value = "";
  if (els.fileGallery) els.fileGallery.value = "";
  setPreview(null);
  els.approvedAt.value = "";
  els.cardNumber.value = "";
  els.amount.value = "";
  els.storeName.value = "";
  els.businessRegNo.value = "";
  els.ocrBtn.disabled = false;
  els.submitBtn.disabled = true;
}

function fillFromOcr(data) {
  if (!data) return;
  if (data.approvedAt) {
    let v = String(data.approvedAt);
    if (v.includes(" ") && !v.includes("T")) {
      v = v.replace(" ", "T");
    }
    els.approvedAt.value = v.slice(0, 16);
  }
  if (data.cardNumber != null) els.cardNumber.value = data.cardNumber;
  if (data.amount != null && data.amount !== "") {
    const n = Number(data.amount);
    els.amount.value = n > 0 ? String(data.amount) : "";
  }
  if (data.storeName != null) els.storeName.value = data.storeName;
  if (data.businessRegNo != null) els.businessRegNo.value = data.businessRegNo;
}

async function login() {
  showMsg(els.loginMsg, "");
  const user_id = els.userId.value.trim();
  const password = els.password.value;
  if (!user_id || !password) {
    showMsg(els.loginMsg, "아이디와 비밀번호를 입력하세요.", "err");
    return;
  }
  try {
    const result = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, password }),
    });
    const token = result?.data?.accessToken;
    if (!token) throw new Error("토큰이 없습니다.");
    setToken(token);
    els.loginCard.classList.add("hidden");
    els.mainCard.classList.remove("hidden");
    els.userLabel.textContent = `${user_id}님 · `;
    showMsg(els.mainMsg, "로그인되었습니다.", "ok");
  } catch (e) {
    showMsg(els.loginMsg, e.message || "로그인 실패", "err");
  }
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  clearToken();
  selectedFile = null;
  setPreview(null);
  els.mainCard.classList.add("hidden");
  els.loginCard.classList.remove("hidden");
  showMsg(els.loginMsg, "로그아웃했습니다.", "ok");
}

async function runOcrInternal({ successMessage } = {}) {
  const file = selectedFile;
  if (!file) {
    showMsg(els.mainMsg, "먼저 이미지를 선택해 주세요.", "err");
    return;
  }
  showMsg(els.mainMsg, "OCR로 필드를 분석하는 중…", "info");
  els.ocrBtn.disabled = true;
  els.submitBtn.disabled = true;
  const fd = new FormData();
  fd.append("image", file, file.name);
  try {
    const result = await apiFetch("/api/receipts/ocr", {
      method: "POST",
      body: fd,
    });
    fillFromOcr(result?.data);
    const warn = result?.data?.ocrWarning;
    const conf = typeof result?.data?.confidence === "number" ? result.data.confidence : null;
    let msg = successMessage ?? "OCR로 입력했습니다. 내용을 꼭 확인해 주세요.";
    if (conf != null && conf > 0 && conf < 55) {
      msg = `인식 신뢰도 ${Math.round(conf)}% — ${msg}`;
    }
    if (warn) {
      msg = `${warn}\n${msg}`;
    }
    showMsg(els.mainMsg, msg, warn || (conf != null && conf < 55) ? "info" : "ok");
  } catch (e) {
    showMsg(els.mainMsg, e.message || "OCR 실패", "err");
  } finally {
    els.ocrBtn.disabled = false;
    els.submitBtn.disabled = !selectedFile;
  }
}

async function handleImageSelected(file) {
  setPreview(file);
  await runOcrInternal({
    successMessage: "OCR로 입력했습니다. 내용을 확인한 뒤 저장하세요.",
  });
}

async function runOcr() {
  showMsg(els.mainMsg, "");
  await runOcrInternal();
}

async function submit() {
  showMsg(els.mainMsg, "");
  if (!selectedFile) {
    showMsg(els.mainMsg, "이미지를 선택해 주세요.", "err");
    return;
  }
  const fd = new FormData();
  fd.append("image", selectedFile, selectedFile.name);
  fd.append("approvedAt", els.approvedAt.value);
  fd.append("cardNumber", els.cardNumber.value.trim());
  fd.append("amount", els.amount.value.trim());
  fd.append("storeName", els.storeName.value.trim());
  const br = els.businessRegNo.value.trim();
  if (br) fd.append("businessRegNo", br);

  if (!els.approvedAt.value || !els.cardNumber.value.trim() || !els.amount.value.trim() || !els.storeName.value.trim()) {
    showMsg(els.mainMsg, "승인일시, 카드번호, 금액, 매장명을 모두 입력해 주세요.", "err");
    return;
  }

  els.submitBtn.disabled = true;
  try {
    await apiFetch("/api/receipts/submit", {
      method: "POST",
      body: fd,
    });
    showMsg(els.mainMsg, "영수증 처리 완료", "ok");
    resetReceiptForm();
  } catch (e) {
    showMsg(els.mainMsg, e.message || "저장 실패", "err");
  } finally {
    els.submitBtn.disabled = !selectedFile;
  }
}

async function loadAppVersion() {
  if (!els.appVersion) return;
  try {
    const r = await fetch("/health");
    const j = await r.json().catch(() => ({}));
    if (j?.version) {
      els.appVersion.textContent = `v${j.version}`;
      return;
    }
  } catch {
    /* ignore */
  }
  els.appVersion.textContent = APP_VERSION_FALLBACK;
}

function init() {
  void loadAppVersion();

  els.pickCameraBtn.addEventListener("click", () => els.fileCamera.click());
  els.pickGalleryBtn.addEventListener("click", () => els.fileGallery.click());
  els.fileCamera.addEventListener("change", () => {
    const f = els.fileCamera.files?.[0];
    if (f) void handleImageSelected(f);
  });
  els.fileGallery.addEventListener("change", () => {
    const f = els.fileGallery.files?.[0];
    if (f) void handleImageSelected(f);
  });

  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.ocrBtn.addEventListener("click", runOcr);
  els.submitBtn.addEventListener("click", submit);

  if (getToken()) {
    els.loginCard.classList.add("hidden");
    els.mainCard.classList.remove("hidden");
    els.userLabel.textContent = "";
    apiFetch("/api/auth/me")
      .then((r) => {
        const uid = r?.data?.userId ?? "사용자";
        els.userLabel.textContent = `${uid}님 · `;
      })
      .catch(() => {
        clearToken();
        els.mainCard.classList.add("hidden");
        els.loginCard.classList.remove("hidden");
        showMsg(els.loginMsg, "다시 로그인해 주세요.", "err");
      });
  }
}

init();
