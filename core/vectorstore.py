"""벡터 검색 계층.

지금은 numpy 백엔드 하나로 충분하다.
  - 매뉴얼 100권 × 200쪽 ≈ 청크 5만 개, 1024차원 float32 → 약 200MB.
  - 전수 내적(brute-force)은 5만 개 기준 수 ms. 소수 사용자 환경에서 체감 지연 없음.
규모가 커지면 SqliteVecStore 로 바꾸고, 클라우드로 가면 PgVectorStore 를 구현한다.
인터페이스(add/search/reload)만 지키면 나머지 코드는 손대지 않는다.
"""

from __future__ import annotations

import sqlite3
from typing import Sequence

import numpy as np

import config


def to_blob(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def from_blob(blob: bytes, dim: int | None = None) -> np.ndarray:
    arr = np.frombuffer(blob, dtype=np.float32)
    if dim is not None and arr.size != dim:
        raise ValueError(f"벡터 차원 불일치: {arr.size} != {dim}")
    return arr


class NumpyVectorStore:
    """SQLite embeddings 테이블을 메모리에 올려 두고 내적으로 검색한다.

    벡터는 저장 시점에 이미 L2 정규화되어 있으므로 내적 = 코사인 유사도다.
    """

    def __init__(self, conn: sqlite3.Connection, dim: int | None = None):
        self.conn = conn
        self.dim = dim or config.EMBED_DIM
        self.ids: np.ndarray = np.zeros(0, dtype=np.int64)
        self.mat: np.ndarray = np.zeros((0, self.dim), dtype=np.float32)
        self.topic_ids: np.ndarray = np.zeros(0, dtype=np.int64)
        self.reload()

    # -- 적재 -------------------------------------------------------------
    def reload(self) -> None:
        rows = self.conn.execute(
            """
            SELECT e.chunk_id, e.vec, COALESCE(c.topic_id, -1) AS topic_id
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            ORDER BY e.chunk_id
            """
        ).fetchall()
        if not rows:
            self.ids = np.zeros(0, dtype=np.int64)
            self.mat = np.zeros((0, self.dim), dtype=np.float32)
            self.topic_ids = np.zeros(0, dtype=np.int64)
            return
        self.ids = np.array([r["chunk_id"] for r in rows], dtype=np.int64)
        self.topic_ids = np.array([r["topic_id"] for r in rows], dtype=np.int64)
        self.mat = np.vstack([from_blob(r["vec"], self.dim) for r in rows]).astype(np.float32)

    # -- 쓰기 -------------------------------------------------------------
    def add(self, chunk_ids: Sequence[int], vectors: np.ndarray) -> None:
        """임베딩을 DB에 넣는다. 커밋과 reload 는 호출자가 책임진다."""
        payload = [(int(cid), self.dim, to_blob(v)) for cid, v in zip(chunk_ids, vectors)]
        self.conn.executemany(
            "INSERT OR REPLACE INTO embeddings (chunk_id, dim, vec) VALUES (?, ?, ?)", payload
        )

    # -- 검색 -------------------------------------------------------------
    def search(
        self,
        query_vec: np.ndarray,
        top_k: int = 6,
        topic_id: int | None = None,
    ) -> list[tuple[int, float]]:
        """(chunk_id, score) 리스트를 유사도 내림차순으로 돌려준다.

        topic_id 를 주면 해당 분야 데이터셋 안에서만 찾는다
        (= 사용자가 왼쪽 주제 패널에서 분야를 고른 경우).
        """
        if self.mat.shape[0] == 0:
            return []

        q = np.asarray(query_vec, dtype=np.float32).reshape(-1)
        mask = np.ones(self.mat.shape[0], dtype=bool) if topic_id is None else (self.topic_ids == topic_id)
        if not mask.any():
            return []

        scores = self.mat[mask] @ q
        idx_pool = np.nonzero(mask)[0]
        k = min(top_k, scores.size)
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [(int(self.ids[idx_pool[i]]), float(scores[i])) for i in top]


class SqliteVecStore(NumpyVectorStore):
    """sqlite-vec 확장 백엔드 (자리만 마련).

    구현 시 할 일
      1) pip install sqlite-vec
      2) conn.enable_load_extension(True); sqlite_vec.load(conn)
      3) CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, vec float[1024])
      4) search() 를 `SELECT chunk_id, distance FROM vec_chunks WHERE vec MATCH ? ORDER BY distance LIMIT k` 로 교체
    """


def get_store(conn: sqlite3.Connection) -> NumpyVectorStore:
    backend = config.VECTOR_BACKEND.lower()
    if backend == "numpy":
        return NumpyVectorStore(conn)
    if backend == "sqlite-vec":
        return SqliteVecStore(conn)
    raise ValueError(
        f"VECTOR_BACKEND={config.VECTOR_BACKEND} 는 아직 구현되지 않았습니다. "
        "현재는 'numpy' 를 사용하세요."
    )
