"""문서를 검색 단위(청크)로 나눈다.

왜 그냥 N글자씩 자르지 않는가
  - 매뉴얼은 "절차"가 핵심이다. 문장 중간에서 잘리면 "① 먼저 …" 다음 단계가 사라져
    LLM이 앞뒤를 지어내기 쉬워진다(= 할루시네이션).
  - 그래서 문단 → 문장 순으로 경계를 존중하며 목표 길이에 맞춰 채운다.
  - 겹침(overlap)을 두어 경계에 걸친 내용이 양쪽 청크에 모두 남게 한다.

페이지 정보를 끝까지 들고 가는 이유: 답변에 "안전매뉴얼.pdf p.12" 같은 인용을
붙이기 위해서다. 출처 없는 문장을 금지하는 것이 할루시네이션 억제의 핵심이다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import config

# 문장 끝: 마침표/물음표/느낌표 + 공백, 또는 '다.' '요.' 같은 한국어 종결
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|(?<=[다요]\.)\s+|\n{2,}")


@dataclass
class Chunk:
    ord: int
    text: str
    page_from: int
    page_to: int
    heading: str = ""

    @property
    def char_count(self) -> int:
        return len(self.text)


def _split_sentences(text: str) -> list[str]:
    parts = [s.strip() for s in _SENT_SPLIT.split(text) if s and s.strip()]
    return parts


def chunk_pages(
    pages: list,            # list[extract.Page]
    headings: dict[int, str] | None = None,
    size: int | None = None,
    overlap: int | None = None,
    min_size: int | None = None,
) -> list[Chunk]:
    """페이지 리스트를 청크 리스트로 변환한다."""
    size = size or config.CHUNK_SIZE
    overlap = overlap or config.CHUNK_OVERLAP
    min_size = min_size or config.MIN_CHUNK_SIZE
    headings = headings or {}

    # (문장, 페이지번호) 스트림으로 평탄화 — 청크가 페이지를 넘어가도 출처를 안다.
    stream: list[tuple[str, int]] = []
    for page in pages:
        for sent in _split_sentences(page.text):
            stream.append((sent, page.number))

    chunks: list[Chunk] = []
    buf: list[tuple[str, int]] = []
    buf_len = 0

    def flush() -> None:
        nonlocal buf, buf_len
        if not buf:
            return
        text = " ".join(s for s, _ in buf).strip()
        if not text:
            buf, buf_len = [], 0
            return
        p_from = min(p for _, p in buf)
        p_to = max(p for _, p in buf)
        # 이 청크가 시작된 페이지의 제목을 붙인다 (없으면 그 앞 페이지에서 찾음).
        heading = ""
        for pno in range(p_from, 0, -1):
            if pno in headings:
                heading = headings[pno]
                break
        chunks.append(
            Chunk(ord=len(chunks), text=text, page_from=p_from, page_to=p_to, heading=heading)
        )
        # 겹침: 뒤쪽 문장들을 overlap 길이만큼 다음 버퍼로 넘긴다.
        carry: list[tuple[str, int]] = []
        carry_len = 0
        for sent, pno in reversed(buf):
            if carry_len >= overlap:
                break
            carry.insert(0, (sent, pno))
            carry_len += len(sent)
        buf = carry
        buf_len = carry_len

    for sent, pno in stream:
        # 한 문장이 목표 길이를 통째로 넘으면(표·목록이 한 덩어리로 붙은 경우) 강제 분할
        if len(sent) > size * 1.5:
            flush()
            for i in range(0, len(sent), size):
                piece = sent[i : i + size]
                if len(piece) < min_size and chunks:
                    chunks[-1].text += " " + piece
                    continue
                heading = headings.get(pno, "")
                chunks.append(
                    Chunk(ord=len(chunks), text=piece, page_from=pno, page_to=pno, heading=heading)
                )
            continue

        buf.append((sent, pno))
        buf_len += len(sent) + 1
        if buf_len >= size:
            flush()

    flush()

    # 너무 짧은 꼬리 청크는 앞에 합친다.
    merged: list[Chunk] = []
    for c in chunks:
        if merged and c.char_count < min_size:
            merged[-1].text += " " + c.text
            merged[-1].page_to = max(merged[-1].page_to, c.page_to)
            continue
        c.ord = len(merged)
        merged.append(c)
    return merged
