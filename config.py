"""프로젝트 전역 설정.

모든 설정은 여기 한 곳에서만 읽는다. 값은 .env 로 덮어쓸 수 있고,
.env 가 없으면 아래 기본값으로 동작한다(= 설치 직후 바로 실행 가능).

설계 원칙
  1) 문서 내용은 사내망 밖으로 나가지 않는다 → 임베딩/생성 기본값은 Ollama(로컬).
  2) 나중에 클라우드(Upstage/OpenAI)나 pgvector 로 갈아탈 수 있도록
     '무엇을 쓸지'는 전부 문자열 설정으로만 표현한다.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _env(key: str, default: str) -> str:
    return os.getenv(key, default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# 경로
# ---------------------------------------------------------------------------
DATA_DIR = BASE_DIR / "data"
RAW_PDF_DIR = DATA_DIR / "raw_pdf"          # 업로드된 PDF 원본 보관
EXTRACT_DIR = DATA_DIR / "extracted"        # 추출된 텍스트(디버깅·재현용)
DB_PATH = DATA_DIR / "chatbot.db"

for _d in (DATA_DIR, RAW_PDF_DIR, EXTRACT_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# 모델 제공자 (provider)
#   EMBED_PROVIDER / CHAT_PROVIDER : "ollama" | "upstage" | "openai"
# ---------------------------------------------------------------------------
EMBED_PROVIDER = _env("EMBED_PROVIDER", "ollama")
CHAT_PROVIDER = _env("CHAT_PROVIDER", "ollama")

# Ollama (로컬). 서버 PC에서 `ollama serve` 가 떠 있어야 한다.
OLLAMA_HOST = _env("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_EMBED_MODEL = _env("OLLAMA_EMBED_MODEL", "bge-m3")          # 다국어·한국어 강함, 1024차원
OLLAMA_CHAT_MODEL = _env("OLLAMA_CHAT_MODEL", "exaone3.5:7.8b")    # 한국어 특화. qwen3:8b 등으로 교체 가능

# Upstage (OpenAI 호환 API). 문서 내용이 Upstage 서버로 전송된다.
UPSTAGE_API_KEY = _env("UPSTAGE_API_KEY", "")
UPSTAGE_BASE_URL = _env("UPSTAGE_BASE_URL", "https://api.upstage.ai/v1")
UPSTAGE_CHAT_MODEL = _env("UPSTAGE_CHAT_MODEL", "solar-pro2")
# Upstage 임베딩은 '비대칭'이다 — 저장할 문서와 검색할 질문에 다른 모델을 쓴다.
# 두 모델은 같은 벡터 공간을 공유하므로 서로 비교할 수 있고, 이렇게 써야 검색 성능이 나온다.
UPSTAGE_EMBED_PASSAGE_MODEL = _env("UPSTAGE_EMBED_PASSAGE_MODEL", "embedding-passage")
UPSTAGE_EMBED_QUERY_MODEL = _env("UPSTAGE_EMBED_QUERY_MODEL", "embedding-query")

OPENAI_API_KEY = _env("OPENAI_API_KEY", "")
OPENAI_CHAT_MODEL = _env("OPENAI_CHAT_MODEL", "gpt-4o-mini")
OPENAI_EMBED_MODEL = _env("OPENAI_EMBED_MODEL", "text-embedding-3-small")

# 모델별 차원 — 바꾸면 기존 임베딩과 호환되지 않으므로 반드시 재구축해야 한다.
#   bge-m3(ollama) = 1024 | Upstage embedding-* = 4096 | text-embedding-3-small = 1536
_DEFAULT_DIM = {"ollama": 1024, "upstage": 4096, "openai": 1536}
EMBED_DIM = _env_int("EMBED_DIM", _DEFAULT_DIM.get(EMBED_PROVIDER.lower(), 1024))

# Upstage 는 한 번에 최대 100건까지 임베딩을 받는다.
EMBED_BATCH = _env_int("EMBED_BATCH", 32)

# ── Upstage Document Digitization (OCR) ─────────────────────────────────
# 스캔본 PDF 를 텍스트로 바꾼다. CHAT/EMBED 를 upstage 로 쓰는 경우에만 의미가 있다.
USE_UPSTAGE_OCR = _env("USE_UPSTAGE_OCR", "false").lower() in ("1", "true", "yes")
UPSTAGE_OCR_URL = _env("UPSTAGE_OCR_URL", "https://api.upstage.ai/v1/document-digitization")


# ---------------------------------------------------------------------------
# 벡터 저장소
#   "numpy"      : 임베딩을 SQLite BLOB 에 넣고 메모리에서 코사인 계산 (기본, 의존성 0)
#   "sqlite-vec" : sqlite-vec 확장 사용 (수십만 청크 이상일 때)
#   "pgvector"   : 추후 Postgres/Supabase 이전용 (미구현 자리)
# ---------------------------------------------------------------------------
VECTOR_BACKEND = _env("VECTOR_BACKEND", "numpy")


# ---------------------------------------------------------------------------
# 청킹 (한국어 기준, 글자 수)
# ---------------------------------------------------------------------------
CHUNK_SIZE = _env_int("CHUNK_SIZE", 700)        # 청크 목표 길이(자)
CHUNK_OVERLAP = _env_int("CHUNK_OVERLAP", 120)  # 앞 청크와 겹치는 길이(자)
MIN_CHUNK_SIZE = _env_int("MIN_CHUNK_SIZE", 80) # 이보다 짧은 조각은 앞 청크에 합침


# ---------------------------------------------------------------------------
# 토픽(분야) 자동 분류
#   새 PDF → 문서벡터를 기존 토픽 중심(centroid)과 비교
#     sim >= TOPIC_ASSIGN_THRESHOLD      → 기존 토픽에 배정
#     TOPIC_NEW_THRESHOLD <= sim < 위    → 애매 → 보류(pending)
#     sim <  TOPIC_NEW_THRESHOLD         → 보류(pending)
#   보류 문서가 TOPIC_MIN_CLUSTER_SIZE 이상 모이면 군집화 → 새 토픽 생성 + LLM 라벨링
# ---------------------------------------------------------------------------
TOPIC_ASSIGN_THRESHOLD = _env_float("TOPIC_ASSIGN_THRESHOLD", 0.62)
TOPIC_NEW_THRESHOLD = _env_float("TOPIC_NEW_THRESHOLD", 0.45)
TOPIC_MIN_CLUSTER_SIZE = _env_int("TOPIC_MIN_CLUSTER_SIZE", 2)
TOPIC_KEYWORD_TOP_N = _env_int("TOPIC_KEYWORD_TOP_N", 15)


# ---------------------------------------------------------------------------
# 검색 · 생성 (할루시네이션 억제 파라미터)
# ---------------------------------------------------------------------------
RETRIEVE_TOP_K = _env_int("RETRIEVE_TOP_K", 6)
# 이 유사도에 못 미치는 근거뿐이면 답하지 않고 "자료에 없음"으로 돌려준다.
RETRIEVE_SCORE_FLOOR = _env_float("RETRIEVE_SCORE_FLOOR", 0.35)
GEN_TEMPERATURE = _env_float("GEN_TEMPERATURE", 0.1)
GEN_MAX_TOKENS = _env_int("GEN_MAX_TOKENS", 1024)
NO_ANSWER_TEXT = _env(
    "NO_ANSWER_TEXT",
    "업로드된 학교 매뉴얼에서 해당 내용을 찾지 못했습니다. "
    "질문을 조금 더 구체적으로 적어 주시거나, 관련 문서를 추가로 등록해 주세요.",
)


# ---------------------------------------------------------------------------
# 서버 (사내망 전용)
#   HOST=0.0.0.0 이면 같은 공유기/사내망 PC에서 http://<서버IP>:8000 으로 접속 가능.
#   외부 노출을 막는 것은 공유기/방화벽 설정의 몫이다(README 참고).
# ---------------------------------------------------------------------------
HOST = _env("HOST", "0.0.0.0")
PORT = _env_int("PORT", 8000)
ALLOWED_ORIGINS = [o for o in _env("ALLOWED_ORIGINS", "*").split(",") if o]


_EMBED_NAMES = {
    "ollama": lambda: OLLAMA_EMBED_MODEL,
    "upstage": lambda: f"{UPSTAGE_EMBED_PASSAGE_MODEL} / {UPSTAGE_EMBED_QUERY_MODEL}",
    "openai": lambda: OPENAI_EMBED_MODEL,
}
_CHAT_NAMES = {
    "ollama": lambda: OLLAMA_CHAT_MODEL,
    "upstage": lambda: UPSTAGE_CHAT_MODEL,
    "openai": lambda: OPENAI_CHAT_MODEL,
}


def describe() -> dict:
    """현재 설정 요약 (서버 기동 로그·/api/health 에서 사용)."""
    return {
        "embed_provider": EMBED_PROVIDER,
        "embed_model": _EMBED_NAMES.get(EMBED_PROVIDER.lower(), lambda: "?")(),
        "chat_provider": CHAT_PROVIDER,
        "chat_model": _CHAT_NAMES.get(CHAT_PROVIDER.lower(), lambda: "?")(),
        "embed_dim": EMBED_DIM,
        "vector_backend": VECTOR_BACKEND,
        "ocr": "upstage" if USE_UPSTAGE_OCR else "off (텍스트 레이어만)",
        "db_path": str(DB_PATH),
    }


def check_api_key() -> str | None:
    """외부 API 를 쓰는데 키가 없으면 안내 문구를 돌려준다."""
    providers = {EMBED_PROVIDER.lower(), CHAT_PROVIDER.lower()}
    if "upstage" in providers and not UPSTAGE_API_KEY:
        return "UPSTAGE_API_KEY 가 없습니다. .env 파일에 키를 넣어 주세요. (https://console.upstage.ai)"
    if "openai" in providers and not OPENAI_API_KEY:
        return "OPENAI_API_KEY 가 없습니다. .env 파일에 키를 넣어 주세요."
    return None
