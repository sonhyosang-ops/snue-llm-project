"""토픽별 단어사전 구축 (요구사항 2의 '단어사전').

3주차 강의자료의 흐름(형태소 분석 → 사전 구축 → TF-IDF)을 그대로 쓰되,
KoNLPy(JVM 필요)를 **선택 의존성**으로 둔다. 서버 PC에 Java 가 없어도
정규식 기반 토크나이저로 동작하고, Java 가 있으면 자동으로 Okt 를 쓴다.

이 단어사전의 쓰임
  1) 주제 패널에 보여 줄 대표 키워드
  2) LLM 에게 토픽 이름을 짓게 할 때 주는 힌트
  3) (확장) 키워드 검색과 벡터 검색을 섞는 하이브리드 검색
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import Counter

import config

# 한국어 조사·접속어 등 의미가 옅은 단어
STOPWORDS = {
    "그리고", "그러나", "하지만", "또한", "이후", "경우", "동안", "때문", "관련", "통해",
    "대한", "가지", "정도", "위해", "등의", "및", "또는", "있는", "있다", "한다", "하는",
    "에서", "으로", "이다", "것을", "것이", "수", "때", "중", "내", "년", "월", "일",
    "학교", "학생", "교사",  # 학교 매뉴얼에선 거의 모든 문서에 나와 변별력이 없다
}

_TOKEN = re.compile(r"[가-힣]{2,}|[A-Za-z]{3,}")


def tokenize_ko(text: str) -> list[str]:
    """명사 위주 토큰 리스트. KoNLPy 가 있으면 Okt, 없으면 정규식."""
    tokens = _okt_nouns(text)
    if tokens is None:
        tokens = _TOKEN.findall(text)
    return [t for t in tokens if len(t) > 1 and t not in STOPWORDS]


_okt = None
_okt_tried = False


def _okt_nouns(text: str) -> list[str] | None:
    global _okt, _okt_tried
    if _okt_tried and _okt is None:
        return None
    if _okt is None:
        _okt_tried = True
        try:
            from konlpy.tag import Okt

            _okt = Okt()
        except Exception:  # noqa: BLE001 — Java 미설치 등. 조용히 폴백한다.
            _okt = None
            return None
    try:
        return _okt.nouns(text)
    except Exception:  # noqa: BLE001
        return None


def build_topic_vocab(conn: sqlite3.Connection, topic_id: int, top_n: int | None = None) -> list[str]:
    """한 토픽의 단어사전을 (재)계산해 vocab 테이블에 저장하고 상위 키워드를 돌려준다.

    가중치 = TF × log(전체 토픽 수 / 이 단어가 등장한 토픽 수)
      → 여러 분야에 두루 나오는 단어는 눌리고, 이 분야에만 나오는 단어가 올라온다.
    """
    top_n = top_n or config.TOPIC_KEYWORD_TOP_N

    rows = conn.execute(
        "SELECT doc_id, text FROM chunks WHERE topic_id = ?", (topic_id,)
    ).fetchall()
    if not rows:
        return []

    tf: Counter[str] = Counter()
    doc_terms: dict[int, set[str]] = {}
    for r in rows:
        toks = tokenize_ko(r["text"])
        tf.update(toks)
        doc_terms.setdefault(r["doc_id"], set()).update(toks)

    df: Counter[str] = Counter()
    for terms in doc_terms.values():
        df.update(terms)

    # 토픽 간 IDF: 다른 토픽의 단어사전을 참조한다.
    n_topics = conn.execute("SELECT COUNT(*) FROM topics WHERE status='active'").fetchone()[0] or 1
    topic_df = {
        r["term"]: r["n"]
        for r in conn.execute(
            "SELECT term, COUNT(DISTINCT topic_id) AS n FROM vocab GROUP BY term"
        ).fetchall()
    }

    scored: list[tuple[str, int, int, float]] = []
    for term, count in tf.items():
        if count < 2:
            continue
        other = max(1, topic_df.get(term, 1))
        weight = count * math.log(1 + n_topics / other)
        scored.append((term, count, df[term], weight))

    scored.sort(key=lambda x: -x[3])
    keep = scored[: max(top_n * 10, 200)]  # 사전은 넉넉히, 표시는 top_n 만

    conn.execute("DELETE FROM vocab WHERE topic_id = ?", (topic_id,))
    conn.executemany(
        "INSERT OR REPLACE INTO vocab (topic_id, term, tf, df, weight) VALUES (?, ?, ?, ?, ?)",
        [(topic_id, t, c, d, w) for t, c, d, w in keep],
    )

    keywords = [t for t, _, _, _ in scored[:top_n]]
    conn.execute(
        "UPDATE topics SET keywords = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        (json.dumps(keywords, ensure_ascii=False), topic_id),
    )
    conn.commit()
    return keywords


def top_keywords(conn: sqlite3.Connection, topic_id: int, n: int = 10) -> list[str]:
    rows = conn.execute(
        "SELECT term FROM vocab WHERE topic_id = ? ORDER BY weight DESC LIMIT ?", (topic_id, n)
    ).fetchall()
    return [r["term"] for r in rows]
