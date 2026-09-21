"""API 요청/응답 스키마.

Pydantic 모델을 따로 두면 /docs (Swagger) 가 자동으로 생기고,
나중에 프런트를 Next.js 로 바꿀 때 타입을 그대로 옮길 수 있다.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class AskRequest(BaseModel):
    question: str = Field(..., description="사용자 질문")
    topic_id: int | None = Field(None, description="특정 분야 안에서만 검색할 때 지정")
    session_id: str | None = Field(None, description="대화 세션 id. 없으면 서버가 생성")
    top_k: int | None = Field(None, ge=1, le=20)


class EvidenceOut(BaseModel):
    n: int
    chunk_id: int
    doc_id: int
    filename: str
    page_from: int
    page_to: int
    heading: str = ""
    text: str
    score: float
    topic_id: int | None = None
    topic_name: str = ""
    label: str = ""


class AskResponse(BaseModel):
    answered: bool
    answer: str
    evidence: list[EvidenceOut] = []
    all_evidence: list[EvidenceOut] = []
    best_score: float = 0.0
    topic_id: int | None = None
    used_topics: list[dict[str, Any]] = []
    warnings: list[str] = []
    session_id: str | None = None


class TopicOut(BaseModel):
    id: int
    name: str
    summary: str = ""
    keywords: list[str] = []
    doc_count: int = 0
    chunk_count: int = 0
    updated_at: str | None = None


class TopicList(BaseModel):
    topics: list[TopicOut]


class IngestResponse(BaseModel):
    ok: bool
    doc_id: int | None = None
    filename: str
    pages: int = 0
    chunks: int = 0
    topic_id: int | None = None
    topic_name: str = ""
    topic_score: float = 0.0
    is_new_topic: bool = False
    message: str = ""
