"""분야(토픽) 자동 구성 — 요구사항 2·3의 핵심.

문제: "PDF 를 올리면 주제를 정해 분류하고, 새 주제가 나오면 그때 새 데이터셋을 만든다."
이건 고정된 분류 체계가 없다는 뜻이므로, 미리 정한 카테고리 목록으로는 풀 수 없다.

채택한 방식 — 2단계 증분 클러스터링
  [1단계] 배정(assign)
      새 문서의 대표 벡터를 기존 토픽 중심(centroid)들과 코사인 비교.
      최고 유사도 ≥ TOPIC_ASSIGN_THRESHOLD → 그 토픽에 넣고 중심을 갱신한다.
  [2단계] 발견(discover)
      어디에도 붙지 못한 문서는 status='pending' 으로 남겨 둔다.
      보류 문서가 쌓이면 자기들끼리 군집화하고, 군집마다
      LLM 에게 "이 문서들의 공통 주제를 한국어 명사구로" 라벨을 짓게 해 새 토픽을 만든다.

왜 LDA 가 아니라 임베딩 클러스터링인가
  - LDA 는 문서가 추가될 때마다 전체 재학습이 필요해 '증분 생성'과 잘 안 맞는다.
  - LDA 토픽은 단어 분포라서 사람이 읽을 이름이 바로 나오지 않는다.
  - 다만 LDA 는 해석과 시각화(pyLDAvis)에 좋으므로, 토픽별 키워드는
    core/vocab.py 의 TF-IDF 사전으로 따로 뽑아 보완한다.
"""

from __future__ import annotations

import json
import sqlite3

import numpy as np

import config
from core import vocab as vocab_mod
from core.providers import get_chat
from core.vectorstore import from_blob, to_blob


# ---------------------------------------------------------------------------
# 문서 대표 벡터
# ---------------------------------------------------------------------------
def doc_vector(chunk_vectors: np.ndarray) -> np.ndarray:
    """청크 벡터들의 평균 (정규화). 문서 전체의 '주제 위치'."""
    if chunk_vectors.shape[0] == 0:
        return np.zeros(config.EMBED_DIM, dtype=np.float32)
    v = chunk_vectors.mean(axis=0)
    n = np.linalg.norm(v)
    return (v / n if n else v).astype(np.float32)


def load_topic_centroids(conn: sqlite3.Connection) -> tuple[list[int], np.ndarray]:
    rows = conn.execute(
        "SELECT id, centroid FROM topics WHERE status='active' AND centroid IS NOT NULL ORDER BY id"
    ).fetchall()
    if not rows:
        return [], np.zeros((0, config.EMBED_DIM), dtype=np.float32)
    ids = [r["id"] for r in rows]
    mat = np.vstack([from_blob(r["centroid"], config.EMBED_DIM) for r in rows]).astype(np.float32)
    return ids, mat


# ---------------------------------------------------------------------------
# [1단계] 기존 토픽에 배정
# ---------------------------------------------------------------------------
def assign_document(conn: sqlite3.Connection, doc_id: int, dvec: np.ndarray) -> tuple[int | None, float]:
    """문서를 가장 가까운 토픽에 배정한다. 못 붙이면 (None, 최고유사도)."""
    ids, mat = load_topic_centroids(conn)
    conn.execute("UPDATE documents SET doc_vector = ? WHERE id = ?", (to_blob(dvec), doc_id))

    if not ids:
        conn.execute("UPDATE documents SET status='pending', topic_id=NULL WHERE id=?", (doc_id,))
        conn.commit()
        return None, 0.0

    sims = mat @ dvec
    best = int(np.argmax(sims))
    best_score = float(sims[best])

    if best_score >= config.TOPIC_ASSIGN_THRESHOLD:
        topic_id = ids[best]
        _attach(conn, doc_id, topic_id, best_score)
        return topic_id, best_score

    conn.execute(
        "UPDATE documents SET status='pending', topic_id=NULL, topic_score=? WHERE id=?",
        (best_score, doc_id),
    )
    conn.commit()
    return None, best_score


def _attach(conn: sqlite3.Connection, doc_id: int, topic_id: int, score: float) -> None:
    """문서와 그 청크들을 토픽에 붙이고 중심 벡터를 다시 계산한다."""
    conn.execute(
        "UPDATE documents SET topic_id=?, topic_score=?, status='ready' WHERE id=?",
        (topic_id, score, doc_id),
    )
    conn.execute("UPDATE chunks SET topic_id=? WHERE doc_id=?", (topic_id, doc_id))
    conn.commit()
    recompute_centroid(conn, topic_id)
    vocab_mod.build_topic_vocab(conn, topic_id)


def recompute_centroid(conn: sqlite3.Connection, topic_id: int) -> None:
    """토픽에 속한 문서 벡터의 평균으로 중심을 갱신하고 카운트를 맞춘다.

    누적 평균 대신 매번 전체 평균을 다시 구한다. 문서 수가 수백 단위라 비용이 없고,
    문서를 다른 토픽으로 옮겨도 항상 일관된 값이 나온다.
    """
    rows = conn.execute(
        "SELECT doc_vector FROM documents WHERE topic_id=? AND doc_vector IS NOT NULL", (topic_id,)
    ).fetchall()
    if rows:
        mat = np.vstack([from_blob(r["doc_vector"], config.EMBED_DIM) for r in rows])
        c = mat.mean(axis=0)
        n = np.linalg.norm(c)
        centroid = (c / n if n else c).astype(np.float32)
    else:
        centroid = None

    doc_count = conn.execute("SELECT COUNT(*) FROM documents WHERE topic_id=?", (topic_id,)).fetchone()[0]
    chunk_count = conn.execute("SELECT COUNT(*) FROM chunks WHERE topic_id=?", (topic_id,)).fetchone()[0]
    conn.execute(
        """UPDATE topics SET centroid=?, doc_count=?, chunk_count=?,
                  updated_at=datetime('now','localtime') WHERE id=?""",
        (to_blob(centroid) if centroid is not None else None, doc_count, chunk_count, topic_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# [2단계] 보류 문서에서 새 토픽 발견
# ---------------------------------------------------------------------------
def greedy_cluster(vectors: np.ndarray, threshold: float) -> list[list[int]]:
    """평균연결(average-linkage) 응집 군집화의 간단 구현.

    가장 가까운 두 군집을 반복해서 합치되, 평균 유사도가 threshold 아래면 멈춘다.
    문서 수가 수백 개 수준이라 O(n^3) 이어도 충분하다.
    (수천 개를 넘으면 sklearn AgglomerativeClustering 이나 HDBSCAN 으로 교체할 것)
    """
    n = vectors.shape[0]
    if n == 0:
        return []
    if n == 1:
        return [[0]]

    sim = vectors @ vectors.T
    clusters: list[list[int]] = [[i] for i in range(n)]

    while len(clusters) > 1:
        best_pair, best_sim = None, -1.0
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                s = float(sim[np.ix_(clusters[a], clusters[b])].mean())
                if s > best_sim:
                    best_sim, best_pair = s, (a, b)
        if best_pair is None or best_sim < threshold:
            break
        a, b = best_pair
        clusters[a] = clusters[a] + clusters[b]
        clusters.pop(b)

    return clusters


def discover_topics(
    conn: sqlite3.Connection,
    min_cluster_size: int | None = None,
    allow_singleton: bool = True,
) -> list[int]:
    """보류(pending) 문서들을 군집화해 새 토픽을 만든다. 생성된 topic_id 목록 반환.

    allow_singleton=True 면 문서 1개짜리 군집도 토픽이 된다.
    (학교 매뉴얼은 '급식 위생 매뉴얼' 처럼 문서 하나가 곧 한 분야인 경우가 많다)
    """
    min_cluster_size = min_cluster_size or config.TOPIC_MIN_CLUSTER_SIZE

    rows = conn.execute(
        "SELECT id, filename, doc_vector FROM documents WHERE status='pending' AND doc_vector IS NOT NULL"
    ).fetchall()
    if not rows:
        return []

    doc_ids = [r["id"] for r in rows]
    vectors = np.vstack([from_blob(r["doc_vector"], config.EMBED_DIM) for r in rows]).astype(np.float32)

    clusters = greedy_cluster(vectors, threshold=config.TOPIC_ASSIGN_THRESHOLD)

    created: list[int] = []
    for members in clusters:
        if len(members) < min_cluster_size and not allow_singleton:
            continue
        member_doc_ids = [doc_ids[i] for i in members]
        centroid = vectors[members].mean(axis=0)
        centroid /= np.linalg.norm(centroid) or 1.0

        name, summary = label_topic(conn, member_doc_ids)
        cur = conn.execute(
            "INSERT INTO topics (name, summary, centroid) VALUES (?, ?, ?)",
            (name, summary, to_blob(centroid.astype(np.float32))),
        )
        topic_id = int(cur.lastrowid)
        conn.commit()

        for d in member_doc_ids:
            conn.execute(
                "UPDATE documents SET topic_id=?, status='ready' WHERE id=?", (topic_id, d)
            )
            conn.execute("UPDATE chunks SET topic_id=? WHERE doc_id=?", (topic_id, d))
        conn.commit()

        recompute_centroid(conn, topic_id)
        vocab_mod.build_topic_vocab(conn, topic_id)
        created.append(topic_id)

    return created


# ---------------------------------------------------------------------------
# LLM 라벨링
# ---------------------------------------------------------------------------
LABEL_SYSTEM = """너는 학교 행정 문서를 분류하는 사서다.
주어진 문서 조각들을 읽고, 이 묶음이 어떤 '분야'인지 판단한다.
반드시 아래 JSON 형식만 출력한다. 설명이나 코드블록 표시를 붙이지 않는다.

{"name": "분야 이름(한국어 명사구, 6~15자)", "summary": "이 분야에 어떤 내용이 들어있는지 2문장"}

규칙
- 이름은 학교 구성원이 메뉴에서 보고 바로 이해할 수 있어야 한다. (예: "학교 안전·재난 대응", "급식 위생 관리")
- 문서에 없는 내용을 추측해서 넣지 않는다.
- '문서', '자료', '매뉴얼' 같은 일반 명사만으로 끝내지 않는다."""


def label_topic(conn: sqlite3.Connection, doc_ids: list[int], sample_chars: int = 2500) -> tuple[str, str]:
    """군집에 속한 문서들의 앞부분을 근거로 LLM 이 분야명을 짓는다."""
    samples: list[str] = []
    names: list[str] = []
    for d in doc_ids[:5]:
        row = conn.execute("SELECT filename FROM documents WHERE id=?", (d,)).fetchone()
        if row:
            names.append(row["filename"])
        chunks = conn.execute(
            "SELECT text FROM chunks WHERE doc_id=? ORDER BY ord LIMIT 3", (d,)
        ).fetchall()
        for c in chunks:
            samples.append(c["text"][:600])

    fallback_name = _fallback_name(names)
    if not samples:
        return fallback_name, ""

    prompt = (
        "파일명: " + ", ".join(names) + "\n\n"
        "문서 조각:\n" + "\n---\n".join(samples)[:sample_chars]
    )
    try:
        raw = get_chat().chat(
            [{"role": "system", "content": LABEL_SYSTEM}, {"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=300,
        )
        data = _parse_json(raw)
        name = str(data.get("name", "")).strip() or fallback_name
        summary = str(data.get("summary", "")).strip()
        return name[:40], summary[:300]
    except Exception:  # noqa: BLE001 — LLM 실패가 인제스트를 멈추면 안 된다
        return fallback_name, ""


def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = raw.split("\n", 1)[-1] if "\n" in raw else raw
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1:
        return {}
    return json.loads(raw[start : end + 1])


def _fallback_name(filenames: list[str]) -> str:
    if not filenames:
        return "미분류"
    base = filenames[0].rsplit(".", 1)[0]
    return base[:30] if base else "미분류"


# ---------------------------------------------------------------------------
# 조회용
# ---------------------------------------------------------------------------
def list_topics(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT id, name, summary, keywords, doc_count, chunk_count, updated_at
           FROM topics WHERE status='active' ORDER BY doc_count DESC, id"""
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "summary": r["summary"],
                "keywords": json.loads(r["keywords"] or "[]"),
                "doc_count": r["doc_count"],
                "chunk_count": r["chunk_count"],
                "updated_at": r["updated_at"],
            }
        )
    return out


def route_question(conn: sqlite3.Connection, query_vec: np.ndarray) -> tuple[int | None, float]:
    """질문 벡터와 가장 가까운 토픽 (주제 패널 하이라이트용)."""
    ids, mat = load_topic_centroids(conn)
    if not ids:
        return None, 0.0
    sims = mat @ query_vec
    best = int(np.argmax(sims))
    return ids[best], float(sims[best])
