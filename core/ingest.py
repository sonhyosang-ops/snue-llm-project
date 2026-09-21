"""인제스트 파이프라인 — PDF 1개를 데이터셋에 편입시키는 전 과정.

    PDF ─▶ 텍스트 추출 ─▶ 청킹 ─▶ 임베딩 ─▶ DB 저장 ─▶ 토픽 배정
                                                        └─(실패)─▶ 보류 → discover_topics()

이 모듈은 '순서'만 책임지고 실제 일은 extract/chunk/providers/topics 가 한다.
그래야 나중에 한 단계(예: 청킹 전략)를 바꿀 때 여기를 건드리지 않는다.
"""

from __future__ import annotations

import shutil
import sqlite3
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

import config
from core import chunk as chunk_mod
from core import extract as extract_mod
from core import topics as topics_mod
from core.providers import get_embedder
from core.vectorstore import NumpyVectorStore


@dataclass
class IngestResult:
    ok: bool
    doc_id: int | None
    filename: str
    pages: int = 0
    chunks: int = 0
    topic_id: int | None = None
    topic_name: str = ""
    topic_score: float = 0.0
    is_new_topic: bool = False
    message: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


EMBED_BATCH = config.EMBED_BATCH  # Upstage 는 한 요청당 최대 100건


def ingest_pdf(
    conn: sqlite3.Connection,
    pdf_path: Path | str,
    store: NumpyVectorStore | None = None,
    auto_discover: bool = True,
) -> IngestResult:
    """PDF 한 개를 처리한다."""
    pdf_path = Path(pdf_path)
    filename = pdf_path.name

    # 1) 추출 ---------------------------------------------------------------
    doc = extract_mod.extract_pdf(pdf_path)

    dup = conn.execute("SELECT id FROM documents WHERE sha256=?", (doc.sha256,)).fetchone()
    if dup:
        return IngestResult(
            ok=False, doc_id=dup["id"], filename=filename,
            message="이미 등록된 문서입니다(내용이 동일). 건너뜁니다.",
        )

    if doc.char_count < 200:
        hint = " 스캔본으로 보입니다. OCR 설정이 필요합니다(core/extract.py 참고)." if doc.scanned_ratio > 0.5 else ""
        return IngestResult(ok=False, doc_id=None, filename=filename,
                            message=f"추출된 글자가 너무 적습니다.{hint}")

    # 원본을 data/raw_pdf 로 보관 (출처 확인·재처리용)
    stored = config.RAW_PDF_DIR / filename
    if pdf_path.resolve() != stored.resolve():
        stored = _unique_path(stored)
        shutil.copy2(pdf_path, stored)

    # 2) 청킹 ---------------------------------------------------------------
    chunks = chunk_mod.chunk_pages(doc.pages, headings=doc.headings)
    if not chunks:
        return IngestResult(ok=False, doc_id=None, filename=filename, message="청크를 만들지 못했습니다.")

    # 3) 문서·청크 저장 ------------------------------------------------------
    cur = conn.execute(
        """INSERT INTO documents (filename, stored_path, sha256, page_count, char_count, status)
           VALUES (?, ?, ?, ?, ?, 'pending')""",
        (filename, str(stored), doc.sha256, len(doc.pages), doc.char_count),
    )
    doc_id = int(cur.lastrowid)
    conn.executemany(
        """INSERT INTO chunks (doc_id, ord, page_from, page_to, heading, text, char_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [(doc_id, c.ord, c.page_from, c.page_to, c.heading, c.text, c.char_count) for c in chunks],
    )
    conn.commit()

    chunk_ids = [
        r["id"] for r in conn.execute(
            "SELECT id FROM chunks WHERE doc_id=? ORDER BY ord", (doc_id,)
        ).fetchall()
    ]

    # 4) 임베딩 -------------------------------------------------------------
    embedder = get_embedder()
    vectors: list[np.ndarray] = []
    try:
        for i in range(0, len(chunks), EMBED_BATCH):
            batch = [c.text for c in chunks[i : i + EMBED_BATCH]]
            vectors.append(embedder.embed(batch))
    except Exception as exc:  # noqa: BLE001
        conn.execute("UPDATE documents SET status='failed', error=? WHERE id=?", (str(exc), doc_id))
        conn.commit()
        return IngestResult(ok=False, doc_id=doc_id, filename=filename,
                            message=f"임베딩 실패: {exc}")

    mat = np.vstack(vectors).astype(np.float32)

    store = store or NumpyVectorStore(conn)
    store.add(chunk_ids, mat)
    conn.commit()

    # 5) 토픽 배정 ----------------------------------------------------------
    dvec = topics_mod.doc_vector(mat)
    topic_id, score = topics_mod.assign_document(conn, doc_id, dvec)
    is_new = False

    if topic_id is None and auto_discover:
        created = topics_mod.discover_topics(conn)
        if created:
            row = conn.execute("SELECT topic_id FROM documents WHERE id=?", (doc_id,)).fetchone()
            topic_id = row["topic_id"] if row else None
            is_new = topic_id in created

    store.reload()  # topic_id 가 정해졌으므로 필터용 배열을 다시 채운다

    topic_name = ""
    if topic_id:
        row = conn.execute("SELECT name FROM topics WHERE id=?", (topic_id,)).fetchone()
        topic_name = row["name"] if row else ""

    return IngestResult(
        ok=True, doc_id=doc_id, filename=filename,
        pages=len(doc.pages), chunks=len(chunks),
        topic_id=topic_id, topic_name=topic_name, topic_score=score,
        is_new_topic=is_new,
        message="등록 완료" + (f" · 새 분야 '{topic_name}' 생성" if is_new else ""),
    )


def ingest_folder(conn: sqlite3.Connection, folder: Path | str, store: NumpyVectorStore | None = None) -> list[IngestResult]:
    """폴더 안의 PDF 를 모두 처리한다 (초기 구축용)."""
    folder = Path(folder)
    pdfs = sorted(folder.glob("*.pdf"))
    store = store or NumpyVectorStore(conn)
    results = []
    for p in pdfs:
        # 개별 문서는 보류로 두고, 마지막에 한 번에 군집화해야 토픽이 더 안정적이다.
        results.append(ingest_pdf(conn, p, store=store, auto_discover=False))
    topics_mod.discover_topics(conn)
    store.reload()
    return results


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    i = 2
    while True:
        candidate = path.with_name(f"{stem}_{i}{suffix}")
        if not candidate.exists():
            return candidate
        i += 1
