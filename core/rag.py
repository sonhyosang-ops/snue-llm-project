"""검색 + 생성 (RAG) — 할루시네이션 억제가 설계의 중심.

이 챗봇의 목적은 "똑똑한 답"이 아니라 "**틀리지 않는 답**"이다.
학교 매뉴얼을 보고 묻는 사람은 규정·절차를 확인하려는 것이므로,
그럴듯한 창작은 도움이 아니라 사고다. 그래서 4겹으로 막는다.

  1) 근거 하한선 : 최고 유사도가 RETRIEVE_SCORE_FLOOR 미만이면 LLM 을 아예 부르지 않고
                   "자료에서 찾지 못했다"로 응답한다. (모르는 걸 모른다고 하게 만드는 가장 확실한 방법)
  2) 폐쇄형 프롬프트 : 제공된 근거 밖의 지식 사용을 금지한다.
  3) 인용 강제 : 모든 사실 문장 끝에 [1] 형태의 근거 번호를 달게 하고, UI 에서 원문을 보여 준다.
  4) 사후 검증(선택) : 생성된 답에 붙은 인용 번호가 실제 제공한 근거 범위 안인지 확인한다.

'2단계 검색'도 쓴다. 사용자가 주제를 고르면 그 분야 데이터셋 안에서만 찾고(topic_id 필터),
고르지 않으면 전체에서 찾은 뒤 어떤 분야를 참고했는지 되돌려 준다.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass

import numpy as np

import config
from core.providers import get_chat, get_embedder
from core.vectorstore import NumpyVectorStore


@dataclass
class Evidence:
    n: int                 # 프롬프트에 붙인 번호 [1], [2] ...
    chunk_id: int
    doc_id: int
    filename: str
    page_from: int
    page_to: int
    heading: str
    text: str
    score: float
    topic_id: int | None
    topic_name: str

    @property
    def label(self) -> str:
        page = f"p.{self.page_from}" if self.page_from == self.page_to else f"p.{self.page_from}-{self.page_to}"
        head = f" · {self.heading}" if self.heading else ""
        return f"{self.filename} {page}{head}"

    def to_dict(self) -> dict:
        return {
            "n": self.n,
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "filename": self.filename,
            "page_from": self.page_from,
            "page_to": self.page_to,
            "heading": self.heading,
            "text": self.text,
            "score": round(self.score, 4),
            "topic_id": self.topic_id,
            "topic_name": self.topic_name,
            "label": self.label,
        }


SYSTEM_PROMPT = """너는 학교 매뉴얼 안내 도우미다.

절대 규칙
1. 아래 <근거>에 있는 내용만으로 답한다. 근거에 없는 사실은 어떤 경우에도 쓰지 않는다.
   일반 상식이나 다른 학교의 관행을 끌어오지 않는다.
2. 근거로 답할 수 없으면 정확히 이렇게만 답한다:
   "제공된 매뉴얼에서 해당 내용을 확인할 수 없습니다."
   그리고 어떤 정보가 있으면 답할 수 있는지 한 문장으로 덧붙인다.
3. 사실을 담은 문장 끝에는 반드시 근거 번호를 [1] 또는 [1][3] 형태로 붙인다.
4. 근거끼리 내용이 다르면 지어내서 합치지 말고, 두 기준이 다르게 적혀 있다고 알린다.
5. 추측·가정·'일반적으로'라는 표현을 쓰지 않는다.

문체
- 한국어 존댓말, 간결하게.
- 절차를 묻는 질문이면 번호 목록으로 단계를 나눈다.
- 답변 끝에 출처를 따로 나열하지 않는다(화면에서 따로 보여 준다)."""


USER_TEMPLATE = """<근거>
{evidence}
</근거>

<질문>
{question}
</질문>

위 근거만 사용해 답하세요."""


# ---------------------------------------------------------------------------
# 검색
# ---------------------------------------------------------------------------
def retrieve(
    conn: sqlite3.Connection,
    store: NumpyVectorStore,
    question: str,
    topic_id: int | None = None,
    top_k: int | None = None,
) -> tuple[list[Evidence], np.ndarray]:
    top_k = top_k or config.RETRIEVE_TOP_K
    # 질문은 반드시 embed_query 로. Upstage 처럼 비대칭 모델에서는
    # 문서용 모델로 질문을 임베딩하면 검색 품질이 눈에 띄게 떨어진다.
    qvec = get_embedder().embed_query([question])[0]

    hits = store.search(qvec, top_k=top_k, topic_id=topic_id)
    if not hits:
        return [], qvec

    ids = [cid for cid, _ in hits]
    score_map = dict(hits)
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""
        SELECT c.id, c.doc_id, c.page_from, c.page_to, c.heading, c.text, c.topic_id,
               d.filename, COALESCE(t.name,'') AS topic_name
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        LEFT JOIN topics t ON t.id = c.topic_id
        WHERE c.id IN ({placeholders})
        """,
        ids,
    ).fetchall()

    # 관련성이 거의 없는 청크는 프롬프트에서 뺀다.
    # 쓸모없는 근거가 섞이면 LLM 이 그걸 '있는 내용'처럼 엮어 답을 만들기 때문이다.
    min_score = config.RETRIEVE_SCORE_FLOOR * 0.7

    by_id = {r["id"]: r for r in rows}
    evidence: list[Evidence] = []
    for cid in ids:
        r = by_id.get(cid)
        if r is None:
            continue
        score = score_map[cid]
        if evidence and score < min_score:  # 1등은 판정용으로 항상 남긴다
            continue
        evidence.append(
            Evidence(
                n=len(evidence) + 1, chunk_id=cid, doc_id=r["doc_id"], filename=r["filename"],
                page_from=r["page_from"] or 0, page_to=r["page_to"] or 0,
                heading=r["heading"] or "", text=r["text"],
                score=score, topic_id=r["topic_id"], topic_name=r["topic_name"],
            )
        )
    return evidence, qvec


def format_evidence(evidence: list[Evidence], max_chars: int = 6000) -> str:
    parts, total = [], 0
    for e in evidence:
        block = f"[{e.n}] ({e.label})\n{e.text}"
        if total + len(block) > max_chars:
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# 생성
# ---------------------------------------------------------------------------
_CITE = re.compile(r"\[(\d{1,2})\]")


def answer(
    conn: sqlite3.Connection,
    store: NumpyVectorStore,
    question: str,
    topic_id: int | None = None,
    top_k: int | None = None,
) -> dict:
    """질문 하나에 대한 최종 응답 딕셔너리."""
    evidence, qvec = retrieve(conn, store, question, topic_id=topic_id, top_k=top_k)

    # 방어선 1 — 근거 부족
    best = evidence[0].score if evidence else 0.0
    if not evidence or best < config.RETRIEVE_SCORE_FLOOR:
        return {
            "answered": False,
            "answer": config.NO_ANSWER_TEXT,
            "evidence": [e.to_dict() for e in evidence[:3]],
            "best_score": round(best, 4),
            "topic_id": topic_id,
            "used_topics": [],
        }

    prompt = USER_TEMPLATE.format(evidence=format_evidence(evidence), question=question)
    text = get_chat().chat(
        [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
        temperature=config.GEN_TEMPERATURE,
        max_tokens=config.GEN_MAX_TOKENS,
    )

    # 방어선 4 — 존재하지 않는 근거 번호를 지어냈는지 확인
    cited = {int(m) for m in _CITE.findall(text)}
    valid = {e.n for e in evidence}
    ghost = sorted(cited - valid)
    for g in ghost:
        text = text.replace(f"[{g}]", "")
    used = [e.to_dict() for e in evidence if e.n in (cited & valid)] or [e.to_dict() for e in evidence[:3]]

    used_topics = []
    seen = set()
    for e in evidence:
        if e.topic_id and e.topic_id not in seen:
            seen.add(e.topic_id)
            used_topics.append({"id": e.topic_id, "name": e.topic_name})

    return {
        "answered": True,
        "answer": text.strip(),
        "evidence": used,
        "all_evidence": [e.to_dict() for e in evidence],
        "best_score": round(best, 4),
        "topic_id": topic_id,
        "used_topics": used_topics,
        "warnings": ([f"모델이 존재하지 않는 근거 번호 {ghost} 를 인용해 제거했습니다."] if ghost else []),
    }


# ---------------------------------------------------------------------------
# 대화 기록
# ---------------------------------------------------------------------------
def save_turn(conn: sqlite3.Connection, session_id: str, question: str, result: dict) -> None:
    conn.execute("INSERT OR IGNORE INTO sessions (id) VALUES (?)", (session_id,))
    conn.execute(
        "INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)",
        (session_id, question),
    )
    conn.execute(
        """INSERT INTO messages (session_id, role, content, topic_id, citations, answered)
           VALUES (?, 'assistant', ?, ?, ?, ?)""",
        (
            session_id,
            result.get("answer", ""),
            result.get("topic_id"),
            json.dumps(result.get("evidence", []), ensure_ascii=False),
            1 if result.get("answered") else 0,
        ),
    )
    conn.commit()
