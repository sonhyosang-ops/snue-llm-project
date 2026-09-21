"""PDF → 페이지별 텍스트.

학교 매뉴얼 PDF 는 두 종류로 나뉜다.
  (1) 텍스트 레이어가 있는 PDF (한글/워드에서 '다른 이름으로 저장') → PyMuPDF 로 바로 추출.
  (2) 스캔본 이미지 PDF → OCR 필요.
사내망 전용이므로 (2)는 로컬 OCR(Tesseract 등)을 붙여야 한다. 지금은 감지해서
경고만 남기고, ocr_page() 훅을 비워 둔다. 대부분의 공문·매뉴얼은 (1)이다.

헤더/푸터 제거는 week3 강의자료의 아이디어를 일반화했다:
페이지 수의 일정 비율 이상에서 반복되는 줄은 머리말/꼬리말로 보고 지운다.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Page:
    number: int          # 1부터
    text: str
    is_scanned: bool = False


@dataclass
class ExtractedDoc:
    filename: str
    sha256: str
    pages: list[Page] = field(default_factory=list)
    headings: dict[int, str] = field(default_factory=dict)  # 페이지 → 추정 제목

    @property
    def char_count(self) -> int:
        return sum(len(p.text) for p in self.pages)

    @property
    def scanned_ratio(self) -> float:
        if not self.pages:
            return 0.0
        return sum(1 for p in self.pages if p.is_scanned) / len(self.pages)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# 정리 도구
# ---------------------------------------------------------------------------
_PAGE_NUM = re.compile(r"^[\-–—\s]*\d{1,4}[\-–—\s]*$")
_MULTI_WS = re.compile(r"[ \t ]+")


def _clean_line(line: str) -> str:
    return _MULTI_WS.sub(" ", line).strip()


def strip_headers_footers(pages: list[Page], min_ratio: float = 0.5) -> list[Page]:
    """여러 페이지에서 반복되는 짧은 줄(머리말·꼬리말·쪽번호)을 제거한다."""
    if len(pages) < 4:
        return pages

    counter: Counter[str] = Counter()
    for p in pages:
        seen = set()
        for line in p.text.splitlines():
            line = _clean_line(line)
            if line and len(line) <= 40 and line not in seen:
                counter[line] += 1
                seen.add(line)

    threshold = max(3, int(len(pages) * min_ratio))
    repeated = {line for line, n in counter.items() if n >= threshold}

    cleaned: list[Page] = []
    for p in pages:
        kept = []
        for raw in p.text.splitlines():
            line = _clean_line(raw)
            if not line:
                continue
            if line in repeated:
                continue
            if _PAGE_NUM.match(line):
                continue
            kept.append(line)
        cleaned.append(Page(number=p.number, text="\n".join(kept), is_scanned=p.is_scanned))
    return cleaned


# ---------------------------------------------------------------------------
# 제목 추정 — 인용을 "매뉴얼.pdf p.12 (2. 화재 대피 절차)" 처럼 친절하게 만들기 위함
# ---------------------------------------------------------------------------
_HEADING_PATTERNS = [
    re.compile(r"^제\s*\d+\s*[장절조]"),          # 제3장, 제12조
    re.compile(r"^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.．]"),      # Ⅲ.
    re.compile(r"^[가-힣]\s*[.．]\s*\S"),          # 가. 나.
    re.compile(r"^\d+(\.\d+)*\s*[.．]?\s*\S"),     # 1. / 2.3
    re.compile(r"^[□■◆●○▶]\s*\S"),
]


def guess_heading(line: str) -> bool:
    line = line.strip()
    if not (2 <= len(line) <= 60):
        return False
    return any(p.match(line) for p in _HEADING_PATTERNS)


# ---------------------------------------------------------------------------
# 본체
# ---------------------------------------------------------------------------
def extract_pdf(path: Path | str, remove_headers: bool = True) -> ExtractedDoc:
    """PDF 를 페이지 단위 텍스트로 추출한다."""
    import pymupdf  # PyMuPDF. 지연 임포트로 임포트 비용을 미룬다.

    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"PDF 를 찾을 수 없습니다: {path}")

    doc = pymupdf.open(path)
    pages: list[Page] = []
    try:
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text") or ""
            # 텍스트가 거의 없는데 이미지가 있으면 스캔본으로 본다.
            is_scanned = len(text.strip()) < 30 and bool(page.get_images(full=True))
            if is_scanned:
                text = ocr_page(page) or text
            pages.append(Page(number=i, text=text, is_scanned=is_scanned))
    finally:
        doc.close()

    if remove_headers:
        pages = strip_headers_footers(pages)

    headings: dict[int, str] = {}
    for p in pages:
        for line in p.text.splitlines():
            if guess_heading(line):
                headings[p.number] = line.strip()
                break

    return ExtractedDoc(
        filename=path.name,
        sha256=file_sha256(path),
        pages=pages,
        headings=headings,
    )


def ocr_page(page) -> str:  # noqa: ANN001 — pymupdf.Page
    """스캔 PDF 한 쪽을 텍스트로.

    - config.USE_UPSTAGE_OCR=true 이면 Upstage Document Digitization 을 호출한다.
      (해당 쪽을 PNG 로 떠서 보내므로 이미지가 Upstage 서버로 전송된다)
    - 아니면 빈 문자열을 돌려주고, 로컬 OCR 은 아래 주석대로 붙이면 된다:
        pip install pytesseract pillow  +  Tesseract 설치 + kor.traineddata
        pix = page.get_pixmap(dpi=300)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        return pytesseract.image_to_string(img, lang="kor+eng")
    """
    import config

    if not config.USE_UPSTAGE_OCR or not config.UPSTAGE_API_KEY:
        return ""

    import requests

    try:
        pix = page.get_pixmap(dpi=200)
        res = requests.post(
            config.UPSTAGE_OCR_URL,
            headers={"Authorization": f"Bearer {config.UPSTAGE_API_KEY}"},
            files={"document": ("page.png", pix.tobytes("png"), "image/png")},
            data={"model": "ocr"},
            timeout=120,
        )
        res.raise_for_status()
        return _pick_text(res.json())
    except Exception:  # noqa: BLE001 — OCR 실패가 전체 인제스트를 막으면 안 된다
        return ""


def _pick_text(data) -> str:
    """중첩된 OCR 응답 JSON 에서 텍스트를 재귀적으로 꺼낸다."""
    if isinstance(data, dict):
        for key in ("text", "content", "result", "output", "ocr_text"):
            if key in data:
                found = _pick_text(data[key])
                if found:
                    return found
        for value in data.values():
            found = _pick_text(value)
            if found:
                return found
    elif isinstance(data, list):
        parts = [_pick_text(item) for item in data]
        return "\n".join(p for p in parts if p)
    elif isinstance(data, str):
        return data.strip()
    return ""
