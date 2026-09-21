"""임베딩·생성 모델 추상화 계층.

여기서 하는 일은 하나뿐이다: **나머지 코드가 어떤 LLM을 쓰는지 몰라도 되게** 하는 것.
core/rag.py, core/topics.py 는 get_embedder() / get_chat() 만 호출한다.
따라서 Ollama → Upstage → OpenAI 교체는 .env 한 줄 수정으로 끝난다.

기본값은 Ollama(로컬)이다. 학교 매뉴얼 본문이 외부로 나가지 않는다는 요구 때문이다.
"""

from __future__ import annotations

from typing import Iterable, Protocol

import numpy as np
import requests

import config


# ---------------------------------------------------------------------------
# 인터페이스
# ---------------------------------------------------------------------------
class Embedder(Protocol):
    dim: int

    def embed(self, texts: list[str]) -> np.ndarray:
        """**저장할 문서**를 벡터로. (N, dim) float32, L2 정규화."""
        ...

    def embed_query(self, texts: list[str]) -> np.ndarray:
        """**검색할 질문**을 벡터로.

        대부분의 모델(bge-m3, OpenAI)은 문서와 질문을 같은 방식으로 다루므로
        embed() 와 동일하다. 그러나 Upstage 는 embedding-passage / embedding-query 로
        나뉜 비대칭 모델이라 반드시 구분해서 호출해야 검색 성능이 나온다.
        """
        ...


class ChatModel(Protocol):
    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 1024) -> str:
        ...


def _normalize(mat: np.ndarray) -> np.ndarray:
    """코사인 유사도를 내적 한 번으로 계산하기 위해 미리 L2 정규화해 둔다."""
    mat = np.asarray(mat, dtype=np.float32)
    if mat.ndim == 1:
        mat = mat[None, :]
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


def _check_dim(arr: np.ndarray, dim: int) -> None:
    if arr.shape[1] != dim:
        raise ValueError(
            f"임베딩 차원 불일치: 모델이 {arr.shape[1]}차원을 돌려줬는데 "
            f"config.EMBED_DIM 은 {dim} 입니다.\n"
            f"  → .env 에 EMBED_DIM={arr.shape[1]} 로 적고, "
            f"기존 임베딩은 호환되지 않으므로 scripts/ingest_pdf.py --reset 으로 재구축하세요."
        )


# ---------------------------------------------------------------------------
# Ollama (로컬 기본값)
# ---------------------------------------------------------------------------
class OllamaEmbedder:
    def __init__(self, host: str | None = None, model: str | None = None, dim: int | None = None):
        self.host = (host or config.OLLAMA_HOST).rstrip("/")
        self.model = model or config.OLLAMA_EMBED_MODEL
        self.dim = dim or config.EMBED_DIM

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        # /api/embed 는 배치를 받는다 (구버전은 /api/embeddings, 단건).
        res = requests.post(
            f"{self.host}/api/embed",
            json={"model": self.model, "input": texts},
            timeout=300,
        )
        res.raise_for_status()
        vectors = res.json()["embeddings"]
        arr = np.asarray(vectors, dtype=np.float32)
        _check_dim(arr, self.dim)
        return _normalize(arr)

    # bge-m3 는 대칭 모델이라 질문도 같은 방식으로 임베딩한다.
    def embed_query(self, texts: list[str]) -> np.ndarray:
        return self.embed(texts)


class OllamaChat:
    def __init__(self, host: str | None = None, model: str | None = None):
        self.host = (host or config.OLLAMA_HOST).rstrip("/")
        self.model = model or config.OLLAMA_CHAT_MODEL

    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 1024) -> str:
        res = requests.post(
            f"{self.host}/api/chat",
            json={
                "model": self.model,
                "messages": messages,
                "stream": False,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            },
            timeout=600,
        )
        res.raise_for_status()
        return res.json()["message"]["content"].strip()


# ---------------------------------------------------------------------------
# OpenAI 호환 (Upstage / OpenAI) — 외부 전송을 허용할 때만 사용
# ---------------------------------------------------------------------------
class OpenAICompatChat:
    def __init__(self, api_key: str, base_url: str | None, model: str):
        from openai import OpenAI  # 선택 의존성이므로 지연 임포트

        self.client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
        self.model = model

    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 1024) -> str:
        res = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return (res.choices[0].message.content or "").strip()


class OpenAICompatEmbedder:
    """OpenAI 호환 임베딩.

    passage_model / query_model 을 따로 받는다.
      - OpenAI: 둘이 같은 모델 (대칭)
      - Upstage: embedding-passage / embedding-query (비대칭)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str | None,
        passage_model: str,
        dim: int,
        query_model: str | None = None,
    ):
        from openai import OpenAI

        if not api_key:
            raise ValueError("API 키가 비어 있습니다. .env 파일을 확인하세요.")
        self.client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
        self.model = passage_model
        self.query_model = query_model or passage_model
        self.dim = dim

    def _call(self, texts: list[str], model: str) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        res = self.client.embeddings.create(model=model, input=texts)
        # API 가 순서를 보장하지 않는 경우를 대비해 index 로 정렬한다.
        ordered = sorted(res.data, key=lambda d: d.index)
        arr = np.asarray([d.embedding for d in ordered], dtype=np.float32)
        _check_dim(arr, self.dim)
        return _normalize(arr)

    def embed(self, texts: list[str]) -> np.ndarray:
        return self._call(texts, self.model)

    def embed_query(self, texts: list[str]) -> np.ndarray:
        return self._call(texts, self.query_model)


# ---------------------------------------------------------------------------
# 팩토리 — 나머지 코드는 이 두 함수만 쓴다
# ---------------------------------------------------------------------------
_embedder: Embedder | None = None
_chat: ChatModel | None = None


def get_embedder() -> Embedder:
    global _embedder
    if _embedder is not None:
        return _embedder

    p = config.EMBED_PROVIDER.lower()
    if p == "ollama":
        _embedder = OllamaEmbedder()
    elif p == "upstage":
        _embedder = OpenAICompatEmbedder(
            config.UPSTAGE_API_KEY,
            config.UPSTAGE_BASE_URL,
            config.UPSTAGE_EMBED_PASSAGE_MODEL,
            config.EMBED_DIM,
            query_model=config.UPSTAGE_EMBED_QUERY_MODEL,
        )
    elif p == "openai":
        _embedder = OpenAICompatEmbedder(
            config.OPENAI_API_KEY, None, config.OPENAI_EMBED_MODEL, config.EMBED_DIM
        )
    else:
        raise ValueError(f"알 수 없는 EMBED_PROVIDER: {config.EMBED_PROVIDER}")
    return _embedder


def get_chat() -> ChatModel:
    global _chat
    if _chat is not None:
        return _chat

    p = config.CHAT_PROVIDER.lower()
    if p == "ollama":
        _chat = OllamaChat()
    elif p == "upstage":
        _chat = OpenAICompatChat(config.UPSTAGE_API_KEY, config.UPSTAGE_BASE_URL, config.UPSTAGE_CHAT_MODEL)
    elif p == "openai":
        _chat = OpenAICompatChat(config.OPENAI_API_KEY, None, config.OPENAI_CHAT_MODEL)
    else:
        raise ValueError(f"알 수 없는 CHAT_PROVIDER: {config.CHAT_PROVIDER}")
    return _chat


def health() -> dict:
    """서버 기동 시 모델이 실제로 응답하는지 확인한다."""
    status = {"embed": "unknown", "chat": "unknown"}

    warn = config.check_api_key()
    if warn:
        return {"embed": f"error: {warn}", "chat": f"error: {warn}"}

    try:
        emb = get_embedder()
        vec = emb.embed(["연결 확인"])
        emb.embed_query(["연결 확인"])  # 질문용 모델도 실제로 호출해 본다
        status["embed"] = f"ok (dim={vec.shape[1]})"
    except Exception as exc:  # noqa: BLE001 — 진단 목적이라 그대로 노출
        status["embed"] = f"error: {exc}"
    try:
        get_chat().chat([{"role": "user", "content": "OK 한 단어로만 답하세요."}], max_tokens=8)
        status["chat"] = "ok"
    except Exception as exc:  # noqa: BLE001
        status["chat"] = f"error: {exc}"
    return status
