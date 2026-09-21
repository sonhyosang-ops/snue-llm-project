"""CLI 인제스트 — 초기 구축이나 대량 등록에 쓴다.

    python -m scripts.ingest_pdf  data/raw_pdf
    python -m scripts.ingest_pdf  "C:/매뉴얼/학교안전매뉴얼.pdf"
    python -m scripts.ingest_pdf  data/raw_pdf --reset      (DB 초기화 후 전체 재구축)

웹 업로드와 같은 파이프라인을 쓰므로 결과가 다르지 않다.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import db as db_mod          # noqa: E402
from core import ingest as ingest_mod  # noqa: E402
from core import topics as topics_mod  # noqa: E402
from core.vectorstore import NumpyVectorStore  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="PDF 를 챗봇 데이터셋에 등록합니다.")
    ap.add_argument("path", help="PDF 파일 또는 PDF 가 들어 있는 폴더")
    ap.add_argument("--reset", action="store_true", help="기존 DB 를 지우고 처음부터 구축")
    args = ap.parse_args()

    if args.reset:
        confirm = input("DB 를 모두 지웁니다. 계속할까요? (yes/N) ").strip().lower()
        if confirm != "yes":
            print("취소했습니다.")
            return
        db_mod.reset_db()
    else:
        db_mod.init_db()

    conn = db_mod.connect()
    store = NumpyVectorStore(conn)
    target = Path(args.path)

    if target.is_dir():
        results = ingest_mod.ingest_folder(conn, target, store=store)
    elif target.is_file():
        results = [ingest_mod.ingest_pdf(conn, target, store=store)]
    else:
        print(f"경로를 찾을 수 없습니다: {target}")
        return

    print("\n─── 처리 결과 " + "─" * 40)
    for r in results:
        mark = "✓" if r.ok else "✗"
        print(f" {mark} {r.filename}  (쪽 {r.pages}, 청크 {r.chunks})  {r.message}")

    print("\n─── 분야별 데이터셋 " + "─" * 34)
    for t in topics_mod.list_topics(conn):
        kw = ", ".join(t["keywords"][:8])
        print(f" [{t['id']:>2}] {t['name']}  (문서 {t['doc_count']}, 청크 {t['chunk_count']})")
        if kw:
            print(f"      키워드: {kw}")
        if t["summary"]:
            print(f"      설명  : {t['summary']}")

    pending = conn.execute("SELECT COUNT(*) FROM documents WHERE status='pending'").fetchone()[0]
    if pending:
        print(f"\n 보류 문서 {pending}건 — 문서가 더 모이면 새 분야로 묶입니다.")
    conn.close()


if __name__ == "__main__":
    main()
