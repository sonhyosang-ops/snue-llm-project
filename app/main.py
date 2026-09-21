"""FastAPI 서버 — 사내망(인트라넷) 전용.

실행:  python run_server.py       또는  run_server.bat
접속:  서버 PC        → http://localhost:8000
       같은 망의 PC  → http://<서버PC의 사설IP>:8000

왜 FastAPI + 정적 HTML 인가
  - Node/빌드 도구 없이 파이썬 하나로 끝난다 (Windows, Docker 없음 조건).
  - 그런데도 /api/* 는 표준 REST 라, 나중에 프런트만 Next.js 로 갈아끼워도
    백엔드를 그대로 쓸 수 있다. (Streamlit 은 이 전환이 불가능하다)
"""

from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
from app.schemas import AskRequest, AskResponse, IngestResponse, TopicList
from core import db as db_mod
from core import ingest as ingest_mod
from core import rag as rag_mod
from core import topics as topics_mod
from core import vocab as vocab_mod
from core.providers import health as provider_health
from core.vectorstore import get_store

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="학교 매뉴얼 RAG 챗봇", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 전역 자원 — 사용자가 소수이므로 커넥션·벡터스토어를 하나씩만 둔다.
db_mod.init_db()
conn = db_mod.connect()
store = get_store(conn)


# ---------------------------------------------------------------------------
# 상태
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "config": config.describe(),
        "providers": provider_health(),
        "documents": conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
        "chunks": conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
        "topics": conn.execute("SELECT COUNT(*) FROM topics WHERE status='active'").fetchone()[0],
        "pending_documents": conn.execute(
            "SELECT COUNT(*) FROM documents WHERE status='pending'"
        ).fetchone()[0],
    }


# ---------------------------------------------------------------------------
# 주제(분야) — 화면 왼쪽 패널
# ---------------------------------------------------------------------------
@app.get("/api/topics", response_model=TopicList)
def get_topics():
    return {"topics": topics_mod.list_topics(conn)}


@app.get("/api/topics/{topic_id}")
def get_topic(topic_id: int):
    row = conn.execute("SELECT * FROM topics WHERE id=?", (topic_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "해당 분야가 없습니다.")
    docs = conn.execute(
        "SELECT id, filename, page_count, topic_score, created_at FROM documents WHERE topic_id=? ORDER BY id",
        (topic_id,),
    ).fetchall()
    return {
        "id": row["id"],
        "name": row["name"],
        "summary": row["summary"],
        "keywords": vocab_mod.top_keywords(conn, topic_id, 20),
        "doc_count": row["doc_count"],
        "chunk_count": row["chunk_count"],
        "documents": [dict(d) for d in docs],
    }


@app.post("/api/topics/{topic_id}/rename")
def rename_topic(topic_id: int, name: str = Query(..., min_length=1, max_length=40)):
    """LLM 이 지은 분야명을 사람이 고칠 수 있게 한다 (실무에서 꼭 필요)."""
    cur = conn.execute(
        "UPDATE topics SET name=?, updated_at=datetime('now','localtime') WHERE id=?", (name, topic_id)
    )
    conn.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "해당 분야가 없습니다.")
    return {"ok": True, "id": topic_id, "name": name}


# ---------------------------------------------------------------------------
# 문서 업로드 · 인제스트
# ---------------------------------------------------------------------------
@app.post("/api/documents", response_model=IngestResponse)
async def upload_document(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "PDF 파일만 업로드할 수 있습니다.")

    tmp_dir = Path(tempfile.mkdtemp())
    tmp_path = tmp_dir / file.filename
    try:
        with tmp_path.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        result = ingest_mod.ingest_pdf(conn, tmp_path, store=store)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return result.to_dict()


@app.get("/api/documents")
def list_documents():
    rows = conn.execute(
        """SELECT d.id, d.filename, d.page_count, d.char_count, d.status, d.topic_id,
                  COALESCE(t.name,'') AS topic_name, d.topic_score, d.created_at
           FROM documents d LEFT JOIN topics t ON t.id = d.topic_id
           ORDER BY d.id DESC"""
    ).fetchall()
    return {"documents": [dict(r) for r in rows]}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int):
    row = conn.execute("SELECT topic_id FROM documents WHERE id=?", (doc_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "문서가 없습니다.")
    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))  # chunks/embeddings 는 CASCADE
    conn.commit()
    if row["topic_id"]:
        topics_mod.recompute_centroid(conn, row["topic_id"])
    store.reload()
    return {"ok": True}


@app.post("/api/topics/discover")
def discover():
    """보류 중인 문서들을 다시 군집화해 새 분야를 만든다 (수동 트리거)."""
    created = topics_mod.discover_topics(conn)
    store.reload()
    return {"created": created, "topics": topics_mod.list_topics(conn)}


# ---------------------------------------------------------------------------
# 질의응답
# ---------------------------------------------------------------------------
@app.post("/api/ask", response_model=AskResponse)
def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(400, "질문이 비어 있습니다.")
    session_id = req.session_id or str(uuid.uuid4())
    result = rag_mod.answer(conn, store, req.question, topic_id=req.topic_id, top_k=req.top_k)
    rag_mod.save_turn(conn, session_id, req.question, result)
    result["session_id"] = session_id
    return result


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    rows = conn.execute(
        "SELECT role, content, citations, answered, created_at FROM messages WHERE session_id=? ORDER BY id",
        (session_id,),
    ).fetchall()
    return {"session_id": session_id, "messages": [dict(r) for r in rows]}


# ---------------------------------------------------------------------------
# 정적 파일 (채팅 UI)
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
