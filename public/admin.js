const tokenKey = "admin_access_token";

const els = {
  loginCard: document.getElementById("loginCard"),
  adminCard: document.getElementById("adminCard"),
  message: document.getElementById("message"),
  adminMessage: document.getElementById("adminMessage"),
  userId: document.getElementById("userId"),
  password: document.getElementById("password"),
  usersBody: document.getElementById("usersBody"),
  receiptsBody: document.getElementById("receiptsBody"),
  processedBody: document.getElementById("processedBody"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  usersTabBtn: document.getElementById("usersTabBtn"),
  receiptsTabBtn: document.getElementById("receiptsTabBtn"),
  processedTabBtn: document.getElementById("processedTabBtn"),
  usersPanel: document.getElementById("usersPanel"),
  receiptsPanel: document.getElementById("receiptsPanel"),
  processedPanel: document.getElementById("processedPanel"),
};

function getToken() {
  return localStorage.getItem(tokenKey);
}

function setToken(token) {
  localStorage.setItem(tokenKey, token);
}

function clearToken() {
  localStorage.removeItem(tokenKey);
}

function setText(target, text, isError = true) {
  target.style.color = isError ? "#b91c1c" : "#166534";
  target.textContent = text;
}

function showAdminArea() {
  els.loginCard.classList.add("hidden");
  els.adminCard.classList.remove("hidden");
}

function showLoginArea() {
  els.adminCard.classList.add("hidden");
  els.loginCard.classList.remove("hidden");
}

function switchTab(tabName) {
  els.usersTabBtn.classList.toggle("active", tabName === "users");
  els.receiptsTabBtn.classList.toggle("active", tabName === "receipts");
  els.processedTabBtn.classList.toggle("active", tabName === "processed");
  els.usersPanel.classList.toggle("active", tabName === "users");
  els.receiptsPanel.classList.toggle("active", tabName === "receipts");
  els.processedPanel.classList.toggle("active", tabName === "processed");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatAmount(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const numeric = Number(String(value).replace(/,/g, ""));
  if (Number.isNaN(numeric)) {
    return String(value);
  }
  return numeric.toLocaleString("ko-KR");
}

function receiptRowHtml(r, pending) {
  const dlBtn = `<td><button type="button" class="btn-receipt-dl" data-receipt-id="${r.id}">다운로드</button></td>`;
  const confirmCell = pending
    ? `<td><button type="button" class="btn-receipt-confirm" data-receipt-id="${r.id}">확인</button></td>`
    : "";
  const processedCell = pending ? "" : `<td>${formatDateTime(r.adminProcessedAt)}</td>`;
  return `<tr>
    <td>${formatDateTime(r.approvedAt)}</td>
    <td>${r.user?.userName ?? r.userId ?? ""}</td>
    <td>${r.user?.department ?? ""}</td>
    <td>${r.storeName ?? ""}</td>
    <td>${formatAmount(r.amount)}</td>
    <td>${r.cardNumber ?? ""}</td>
    ${processedCell}
    ${dlBtn}
    ${confirmCell}
  </tr>`;
}

function extractFilename(contentDisposition, fallback) {
  if (!contentDisposition) {
    return fallback;
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  if (plainMatch?.[1]) {
    return plainMatch[1];
  }
  return fallback;
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = new Headers(options.headers ?? {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.message ?? "요청 실패";
    throw new Error(message);
  }
  return body;
}

async function login() {
  els.message.textContent = "";
  const user_id = els.userId.value.trim();
  const password = els.password.value;
  if (!user_id || !password) {
    setText(els.message, "아이디와 비밀번호를 입력하세요.");
    return;
  }

  try {
    const result = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, password }),
    });
    const token = result?.data?.accessToken;
    if (!token) {
      throw new Error("토큰이 응답에 없습니다.");
    }
    setToken(token);
    showAdminArea();
    await initializeAdminView();
    setText(els.adminMessage, "로그인 성공", false);
  } catch (error) {
    setText(els.message, error.message || "로그인 실패");
  }
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch (_error) {
    // 서버 세션 정리 실패해도 클라이언트 토큰은 삭제한다.
  } finally {
    clearToken();
    showLoginArea();
    setText(els.message, "로그아웃되었습니다.", false);
  }
}

async function loadUsers() {
  try {
    const result = await apiFetch("/api/admin/users");
    const rows = result?.data ?? [];
    els.usersBody.innerHTML = rows
      .map(
        (u) => `<tr>
          <td>${u.id ?? ""}</td>
          <td>${u.userId ?? ""}</td>
          <td>${u.userName ?? ""}</td>
          <td>${u.department ?? ""}</td>
          <td>${u.role ?? ""}</td>
          <td>${u.isActive ? "Y" : "N"}</td>
        </tr>`
      )
      .join("");
    setText(els.adminMessage, `사용자 ${rows.length}건 조회`, false);
  } catch (error) {
    setText(els.adminMessage, error.message || "사용자 조회 실패");
  }
}

async function loadReceipts(options = {}) {
  const { setMessage = true } = options;
  try {
    const result = await apiFetch("/api/admin/receipts?processed=false");
    const rows = result?.data ?? [];
    els.receiptsBody.innerHTML = rows.map((r) => receiptRowHtml(r, true)).join("");
    if (setMessage) {
      setText(els.adminMessage, `미처리 영수증 ${rows.length}건 조회`, false);
    }
    return rows.length;
  } catch (error) {
    if (setMessage) {
      setText(els.adminMessage, error.message || "영수증 조회 실패");
    }
    throw error;
  }
}

async function loadProcessed(options = {}) {
  const { setMessage = true } = options;
  try {
    const result = await apiFetch("/api/admin/receipts?processed=true");
    const rows = result?.data ?? [];
    els.processedBody.innerHTML = rows.map((r) => receiptRowHtml(r, false)).join("");
    if (setMessage) {
      setText(els.adminMessage, `처리 목록 ${rows.length}건 조회`, false);
    }
    return rows.length;
  } catch (error) {
    if (setMessage) {
      setText(els.adminMessage, error.message || "처리 목록 조회 실패");
    }
    throw error;
  }
}

async function downloadReceiptFile(receiptId) {
  const token = getToken();
  if (!token) {
    throw new Error("로그인이 필요합니다.");
  }

  const response = await fetch(`/api/admin/receipts/${receiptId}/download`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? "영수증 다운로드 실패");
  }

  const blob = await response.blob();
  const filename = extractFilename(
    response.headers.get("content-disposition"),
    `receipt-${receiptId}`
  );
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);
}

async function confirmReceiptById(receiptId) {
  await apiFetch(`/api/admin/receipts/${receiptId}/confirm`, { method: "PUT" });
}

async function onAdminCardClick(event) {
  const dlBtn = event.target.closest("button.btn-receipt-dl");
  if (dlBtn) {
    const receiptId = dlBtn.dataset.receiptId;
    if (!receiptId) return;
    const prevText = dlBtn.textContent;
    dlBtn.disabled = true;
    dlBtn.textContent = "다운로드중...";
    try {
      await downloadReceiptFile(receiptId);
      setText(els.adminMessage, "영수증 다운로드 완료", false);
    } catch (error) {
      setText(els.adminMessage, error.message || "영수증 다운로드 실패");
    } finally {
      dlBtn.disabled = false;
      dlBtn.textContent = prevText;
    }
    return;
  }

  const confirmBtn = event.target.closest("button.btn-receipt-confirm");
  if (confirmBtn) {
    const receiptId = confirmBtn.dataset.receiptId;
    if (!receiptId) return;

    const ok = window.confirm(
      "이 영수증을 처리 목록으로 이동하시겠습니까?\n\n[확인] 처리 완료 · [취소] 아무 작업도 하지 않습니다."
    );
    if (!ok) {
      return;
    }

    const prevText = confirmBtn.textContent;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "처리중...";
    try {
      await confirmReceiptById(receiptId);
      await loadReceipts();
      await loadProcessed();
      window.alert("영수증을 처리 완료!");
      setText(els.adminMessage, "영수증을 처리 완료!", false);
    } catch (error) {
      setText(els.adminMessage, error.message || "확인 처리 실패");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = prevText;
    }
  }
}

async function onUsersTabClick() {
  switchTab("users");
  await loadUsers();
}

async function onReceiptsTabClick() {
  switchTab("receipts");
  await loadReceipts();
}

async function onProcessedTabClick() {
  switchTab("processed");
  await loadProcessed();
}

async function initializeAdminView() {
  switchTab("receipts");
  let pendingCount = 0;
  try {
    pendingCount = await loadReceipts({ setMessage: false });
  } catch (error) {
    setText(els.adminMessage, error.message || "영수증 조회 실패");
    return;
  }
  try {
    const processedCount = await loadProcessed({ setMessage: false });
    setText(
      els.adminMessage,
      `미처리 영수증 ${pendingCount}건 · 처리 목록 ${processedCount}건`,
      false
    );
  } catch (error) {
    setText(els.adminMessage, error.message || "처리 목록 조회 실패");
  }
}

function init() {
  const token = getToken();
  if (token) {
    showAdminArea();
    setText(els.adminMessage, "저장된 토큰으로 접속됨", false);
    initializeAdminView();
  } else {
    showLoginArea();
  }

  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.usersTabBtn.addEventListener("click", onUsersTabClick);
  els.receiptsTabBtn.addEventListener("click", onReceiptsTabClick);
  els.processedTabBtn.addEventListener("click", onProcessedTabClick);
  els.adminCard.addEventListener("click", onAdminCardClick);
}

init();
