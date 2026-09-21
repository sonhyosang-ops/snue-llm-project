"""토픽 전면 재구성.

임계값(TOPIC_ASSIGN_THRESHOLD)을 바꿔 보거나, 분야가 너무 잘게/뭉뚱그려 나뉘었을 때
임베딩은 그대로 두고 분류만 다시 한다. (재임베딩이 없어 빠르다)

    python -m scripts.rebuild_topics
    python -m scripts.rebuild_topics --threshold 0.70
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config                          # noqa: E402
from core import db as db_mod          # noqa: E402
from core import topics as topics_mod  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=None, help="군집 병합 기준 코사인 유사도")
    ap.add_argument("--keep-names", action="store_true", help="기존 분야명을 유지(미구현: 참고용)")
    args = ap.parse_args()

    if args.threshold is not None:
        config.TOPIC_ASSIGN_THRESHOLD = args.threshold
        print(f"임계값을 {args.threshold} 로 임시 변경합니다.")

    conn = db_mod.connect()

    # 모든 문서를 보류 상태로 되돌리고 기존 토픽을 비운다.
    conn.execute("UPDATE documents SET topic_id=NULL, status='pending', topic_score=0")
    conn.execute("UPDATE chunks SET topic_id=NULL")
    conn.execute("DELETE FROM vocab")
    conn.execute("DELETE FROM topics")
    conn.commit()

    created = topics_mod.discover_topics(conn)
    print(f"\n새 분야 {len(created)}개 생성\n")
    for t in topics_mod.list_topics(conn):
        print(f" [{t['id']:>2}] {t['name']}  문서 {t['doc_count']}  |  {', '.join(t['keywords'][:8])}")
    conn.close()


if __name__ == "__main__":
    main()
