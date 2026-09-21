/* 학교 매뉴얼 RAG 챗봇 — 프런트엔드
 *
 * 의존성 없는 순수 JS. 나중에 Next.js 로 옮길 때도
 * 아래 fetch 호출부(API 계약)만 그대로 가져가면 된다.
 */

const state = {
  topicId: null,      // null = 전체에서 검색
  topicName: "전체 문서",
  sessionId: localStorage.getItem("session_id") || null,
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  topicList: $("#topic-list"),
  topicAll: $("#topic-all"),
  allMeta: $("#all-meta"),
  messages: $("#messages"),
  form: $("#chat-form"),
  input: $("#input"),
  send: $("#send"),
  scopeTitle: $("#scope-title"),
  scopeSub: $("#scope-sub"),
  fileInput: $("#file-input"),
  uploadStatus: $("#upload-status"),
  healthDot: $("#health-dot"),
  healthText: $("#health-text"),
};

/* ── 분야 목록 ─────────────────────────────────────────── */
async function loadTopics(newIds = []) {
  const res = await fetch("/api/topics");
  const { topics } = await res.json();

  el.topicList.innerHTML = "";
  topics.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "topic" + (state.topicId === t.id ? " active" : "");
    btn.dataset.topic = t.id;
    const isNew = newIds.includes(t.id);
    btn.innerHTML = `
      <span class="topic-name">${esc(t.name)}${isNew ? '<span class="badge-new">NEW</span>' : ""}</span>
      <span class="topic-meta">문서 ${t.doc_count} · 조각 ${t.chunk_count}</span>
      ${t.keywords?.length ? `<span class="topic-kw">${esc(t.keywords.slice(0, 6).join(" · "))}</span>` : ""}
    `;
    btn.onclick = () => selectTopic(t.id, t.name);
    el.topicList.appendChild(btn);
  });

  const totalDocs = topics.reduce((s, t) => s + t.doc_count, 0);
  el.allMeta.textContent = `분야 ${topics.length} · 문서 ${totalDocs}`;
}

function selectTopic(id, name) {
  state.topicId = id;
  state.topicName = name || "전체 문서";
  document.querySelectorAll(".topic").forEach((b) => {
    b.classList.toggle("active", (b.dataset.topic || "") === String(id ?? ""));
  });
  el.scopeTitle.textContent = state.topicName;
  el.scopeSub.textContent = id
    ? "이 분야의 문서에서만 근거를 찾습니다"
    : "등록된 매뉴얼 전체에서 근거를 찾습니다";
}
el.topicAll.onclick = () => selectTopic(null, "전체 문서");
$("#btn-refresh").onclick = () => { loadTopics(); loadHealth(); };

/* ── 상태 표시 ─────────────────────────────────────────── */
async function loadHealth() {
  try {
    const h = await (await fetch("/api/health")).json();
    const embedOk = h.providers.embed.startsWith("ok");
    const chatOk = h.providers.chat === "ok";
    el.healthDot.className = "dot " + (embedOk && chatOk ? "ok" : "bad");
    el.healthText.textContent =
      embedOk && chatOk
        ? `${h.config.chat_model} · 문서 ${h.documents}건`
        : `모델 연결 실패 — ${h.providers.chat}`;
  } catch {
    el.healthDot.className = "dot bad";
    el.healthText.textContent = "서버에 연결할 수 없습니다";
  }
}

/* ── 업로드 ────────────────────────────────────────────── */
el.fileInput.onchange = async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const created = [];

  for (const [i, file] of files.entries()) {
    el.uploadStatus.textContent = `(${i + 1}/${files.length}) ${file.name} 처리 중…`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      const r = await res.json();
      el.uploadStatus.textContent = `${file.name}\n→ ${r.message || (r.ok ? "완료" : "실패")}`;
      if (r.is_new_topic && r.topic_id) created.push(r.topic_id);
    } catch (err) {
      el.uploadStatus.textContent = `${file.name}\n→ 오류: ${err}`;
    }
  }
  el.fileInput.value = "";
  await loadTopics(created);
  await loadHealth();
};

/* ── 대화 ──────────────────────────────────────────────── */
el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
});
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.form.requestSubmit(); }
});

el.form.onsubmit = async (e) => {
  e.preventDefault();
  const q = el.input.value.trim();
  if (!q || state.busy) return;

  state.busy = true;
  el.send.disabled = true;
  el.input.value = "";
  el.input.style.height = "auto";

  addUser(q);
  const pending = addTyping();

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, topic_id: state.topicId, session_id: state.sessionId }),
    });
    const data = await res.json();
    if (data.session_id) {
      state.sessionId = data.session_id;
      localStorage.setItem("session_id", data.session_id);
    }
    pending.replaceWith(renderAnswer(data));
  } catch (err) {
    pending.replaceWith(errorBubble(String(err)));
  } finally {
    state.busy = false;
    el.send.disabled = false;
    el.messages.scrollTop = el.messages.scrollHeight;
  }
};

function addUser(text) {
  document.querySelector(".empty")?.remove();
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = text;
  el.messages.appendChild(d);
  el.messages.scrollTop = el.messages.scrollHeight;
}

function addTyping() {
  const d = document.createElement("div");
  d.className = "msg bot";
  d.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  el.messages.appendChild(d);
  el.messages.scrollTop = el.messages.scrollHeight;
  return d;
}

function renderAnswer(data) {
  const d = document.createElement("div");
  d.className = "msg bot" + (data.answered ? "" : " unanswered");

  const body = document.createElement("div");
  body.className = "body";
  body.innerHTML = linkCitations(esc(data.answer));
  d.appendChild(body);

  (data.warnings || []).forEach((w) => {
    const p = document.createElement("div");
    p.className = "warn";
    p.textContent = "⚠ " + w;
    d.appendChild(p);
  });

  const ev = data.evidence || [];
  if (ev.length) {
    const det = document.createElement("details");
    det.className = "sources";
    det.innerHTML =
      `<summary>근거 ${ev.length}건 보기 (최고 유사도 ${data.best_score})</summary>` +
      ev.map((e) => `
        <div class="src" id="src-${e.n}">
          <div class="src-head">[${e.n}] ${esc(e.label)}<span class="src-score">${e.score}</span></div>
          ${esc(e.text.slice(0, 400))}${e.text.length > 400 ? "…" : ""}
        </div>`).join("");
    d.appendChild(det);
  }
  return d;
}

/* 답변 속 [1] 을 눌러 근거로 이동 */
function linkCitations(html) {
  return html.replace(/\[(\d{1,2})\]/g, '<span class="cite" onclick="jumpTo($1)">[$1]</span>');
}
window.jumpTo = (n) => {
  const box = document.querySelector(`#src-${n}`);
  box?.closest("details")?.setAttribute("open", "");
  box?.scrollIntoView({ behavior: "smooth", block: "center" });
};

function errorBubble(msg) {
  const d = document.createElement("div");
  d.className = "msg bot unanswered";
  d.textContent = "요청 처리 중 오류가 발생했습니다: " + msg;
  return d;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ── 시작 ──────────────────────────────────────────────── */
loadTopics();
loadHealth();
