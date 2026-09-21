"""SQLite 스키마와 연결 관리.

왜 SQLite 인가
  - 서버가 개인 PC 1대(Windows, Docker 없음)이고 사용자가 소수 → 별도 DB 서버가 과함.
  - 파일 하나(data/chatbot.db)라 백업·이전이 복사 한 번으로 끝난다.
  - 나중에 Postgres/Supabase 로 옮길 때도 아래 테이블 정의가 거의 그대로 간다
    (embeddings.vec BLOB → vector(1024) 로만 바꾸면 됨).

스키마 한눈에 보기
  documents  : PDF 1개 = 1행. 어떤 토픽에 속하는지(topic_id)를 가진다.
  chunks     : 검색 단위. documents 1 : N chunks.
  embeddings : chunks 1 : 1. float32 벡터를 BLOB 으로 저장.
  topics     : 분야별 데이터셋. centroid(중심벡터)로 새 문서의 소속을 판단한다.
  vocab      : 토픽별 단어사전(명사 + TF-IDF 가중치). 키워드 표시·검색 보강용.
  sessions / messages : 대화 기록(추후 로그 분석용).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import config

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 분야별 데이터셋 --------------------------------------------------------
CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,              -- LLM이 붙인 한국어 주제명 (예: "학교 안전·재난 대응")
    summary     TEXT    DEFAULT '',            -- 2~3문장 설명
    keywords    TEXT    DEFAULT '[]',          -- JSON 배열
    centroid    BLOB,                          -- float32 중심 벡터 (문서벡터 평균)
    doc_count   INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    status      TEXT    DEFAULT 'active',      -- active | archived
    created_at  TEXT    DEFAULT (datetime('now','localtime')),
    updated_at  TEXT    DEFAULT (datetime('now','localtime'))
);

-- 원본 문서 --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL,
    stored_path TEXT    NOT NULL,
    sha256      TEXT    NOT NULL UNIQUE,       -- 같은 PDF 재업로드 방지
    page_count  INTEGER DEFAULT 0,
    char_count  INTEGER DEFAULT 0,
    topic_id    INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    topic_score REAL    DEFAULT 0,             -- 배정 당시 코사인 유사도 (추적용)
    doc_vector  BLOB,                          -- 문서 대표 벡터(청크 평균)
    status      TEXT    DEFAULT 'pending',     -- pending(토픽 미정) | ready | failed
    error       TEXT    DEFAULT '',
    created_at  TEXT    DEFAULT (datetime('now','localtime'))
);

-- 검색 단위 --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,              -- 문서 내 순번
    page_from   INTEGER,
    page_to     INTEGER,
    heading     TEXT    DEFAULT '',            -- 추정된 상위 제목(있으면 인용이 친절해짐)
    text        TEXT    NOT NULL,
    char_count  INTEGER DEFAULT 0,
    topic_id    INTEGER REFERENCES topics(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc   ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_topic ON chunks(topic_id);

-- 임베딩 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    dim      INTEGER NOT NULL,
    vec      BLOB    NOT NULL                  -- np.float32 정규화 벡터의 raw bytes
);

-- 토픽별 단어사전 --------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocab (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    term     TEXT    NOT NULL,
    tf       INTEGER DEFAULT 0,                -- 토픽 내 등장 횟수
    df       INTEGER DEFAULT 0,                -- 등장 문서 수
    weight   REAL    DEFAULT 0,                -- TF-IDF 가중치
    UNIQUE(topic_id, term)
);
CREATE INDEX IF NOT EXISTS idx_vocab_topic ON vocab(topic_id, weight DESC);

-- 대화 기록 --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,               -- uuid4
    title      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,                  -- user | assistant
    content    TEXT NOT NULL,
    topic_id   INTEGER,                        -- 이 턴에서 실제로 참조한 토픽
    citations  TEXT DEFAULT '[]',              -- JSON: [{doc, page, chunk_id, score}]
    answered   INTEGER DEFAULT 1,              -- 0이면 '자료에 없음'으로 응답한 턴
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
"""


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    """딕셔너리처럼 접근 가능한 커넥션을 돌려준다."""
    path = Path(db_path or config.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path | str | None = None) -> None:
    """테이블이 없으면 만든다 (여러 번 호출해도 안전)."""
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def reset_db(db_path: Path | str | None = None) -> None:
    """개발 중 전체 초기화. 데이터가 모두 사라지므로 주의."""
    path = Path(db_path or config.DB_PATH)
    if path.exists():
        path.unlink()
    for suffix in ("-wal", "-shm"):
        side = path.with_name(path.name + suffix)
        if side.exists():
            side.unlink()
    init_db(path)
