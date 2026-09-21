# 학교 매뉴얼 RAG 챗봇 (사내망 전용)

학교의 각종 매뉴얼 PDF를 올리면 **분야별 데이터셋을 자동으로 구성**하고,
질문에 대해 **그 데이터셋 안의 근거만으로** 답하는 챗봇입니다.

- 서버: 개인 PC 1대(Windows) — 같은 사설 네트워크에서만 접속
- 모델: **Upstage API**(기본) 또는 로컬 Ollama — `.env` 한 줄로 교체
- DB: SQLite 파일 1개 — 별도 DB 서버 불필요

---

## 1. 설치 (서버 PC에서 1회)

**① Python 3.11 이상** 설치 (설치 시 "Add to PATH" 체크)

**② 모델 준비** — 둘 중 하나

<details open>
<summary><b>A안 · Upstage API (권장 — 설치가 간단합니다)</b></summary>

1. https://console.upstage.ai 에서 API 키 발급
2. `.env.example` 을 `.env` 로 복사하고 키를 붙여넣기

```ini
EMBED_PROVIDER=upstage
CHAT_PROVIDER=upstage
UPSTAGE_API_KEY=up_xxxxxxxxxxxx
EMBED_DIM=4096
```

사용 모델: 생성 `solar-pro2`, 임베딩 `embedding-passage`(문서용) / `embedding-query`(질문용) — 4096차원

> ⚠ **매뉴얼 본문이 Upstage 서버로 전송됩니다.** 학생 개인정보나 대외비가 포함된
> 문서라면 해당 문서만 제외하거나 B안을 쓰세요. (아래 3절 참고)

</details>

<details>
<summary><b>B안 · 로컬 Ollama (문서가 외부로 나가지 않음)</b></summary>

```bat
:: https://ollama.com/download 설치 후
ollama pull bge-m3            :: 임베딩 (1024차원)
ollama pull exaone3.5:7.8b    :: 생성. 사양이 낮으면 qwen3:4b
```

`.env` 에서 `EMBED_PROVIDER=ollama`, `CHAT_PROVIDER=ollama`, `EMBED_DIM=1024`

</details>

**③ 프로젝트 실행**

```bat
run_server.bat
```

첫 실행 시 가상환경 생성 + 패키지 설치가 자동으로 진행됩니다(수 분 소요).

> **A안 ↔ B안을 바꾸면** 벡터 차원이 달라져 기존 임베딩을 못 씁니다.
> `python -m scripts.ingest_pdf data/raw_pdf --reset` 으로 재구축하세요.

---

## 2. 사용

| 단계 | 방법 |
|---|---|
| 매뉴얼 등록 | 브라우저 왼쪽 아래 **＋ 매뉴얼 PDF 추가** (여러 개 동시 가능) |
| 대량 등록 | `python -m scripts.ingest_pdf "C:/매뉴얼폴더"` |
| 질문 | 오른쪽 채팅창. 왼쪽에서 분야를 고르면 그 분야 안에서만 검색 |
| 분야 재구성 | `python -m scripts.rebuild_topics --threshold 0.68` |

접속 주소

- 서버 PC: `http://localhost:8000`
- 같은 망의 다른 PC: `http://<서버PC IPv4>:8000` (`ipconfig`로 확인)
- API 문서(Swagger): `http://localhost:8000/docs`

> **Windows 방화벽**: 다른 PC에서 접속이 안 되면
> `제어판 → Windows Defender 방화벽 → 고급 설정 → 인바운드 규칙 → 새 규칙 →
> 포트 8000 TCP 허용`, 범위는 **개인 네트워크만**으로 제한하세요.

---

## 3. 동작 원리 (요구사항 대응)

| 요구사항 | 구현 |
|---|---|
| ① PDF 업로드 | `POST /api/documents` → `core/ingest.py` |
| ② 주제별 데이터셋 구성 | 임베딩 → 문서 대표 벡터 → 군집화 → LLM이 분야명 명명 (`core/topics.py`) |
| ② 자연어처리·단어사전 | 한국어 문장 경계 청킹(`core/chunk.py`) + 토픽별 TF-IDF 단어사전(`core/vocab.py`) |
| ③ 새 주제 자동 생성 | 기존 분야 중심과 유사도가 낮으면 **보류** → 보류 문서가 모이면 새 분야 생성 |
| ④ 채팅창 + 주제 패널 | `app/static/` (좌: 분야 목록, 우: 대화) |
| 할루시네이션 최소화 | 근거 하한선·폐쇄형 프롬프트·인용 강제·인용 검증 (`core/rag.py`) |

자세한 설계 근거와 튜닝 포인트는 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** 참고.

### Upstage API를 쓸 때 나가는 것 / 나가지 않는 것

| 전송됨 | 전송 안 됨 |
|---|---|
| 청크 본문 (임베딩 요청) — 등록 시 1회 | PDF 파일 원본 |
| 검색된 근거 + 질문 (생성 요청) — 질문마다 | `data/chatbot.db` 전체 |
| 분야명 명명용 문서 앞부분 (군집당 1회) | 대화 기록 |

즉 **등록한 매뉴얼의 본문은 사실상 전부 한 번은 외부로 나갑니다.**
학생 이름·연락처·생활기록 관련 내용이 든 문서는 등록 전에 제외하거나,
그 문서만 별도로 B안(로컬)에서 다루는 편이 안전합니다.
연구 산출물로 공개할 계획이라면 문서 반출에 대한 학교 측 확인을 먼저 받으시길 권합니다.

---

## 4. 폴더 구조

```
LLM_RAG_PROJECT/
├─ config.py              모든 설정의 단일 출처 (.env 로 덮어쓰기)
├─ run_server.py          서버 진입점
├─ run_server.bat         Windows 원클릭 실행
├─ core/                  도메인 로직 (웹과 무관 → 재사용·테스트 가능)
│  ├─ db.py               SQLite 스키마
│  ├─ providers.py        LLM/임베딩 추상화 (ollama ↔ upstage ↔ openai 교체)
│  ├─ extract.py          PDF → 페이지 텍스트 (머리말·꼬리말 제거)
│  ├─ chunk.py            문장 경계 존중 청킹 + 페이지 추적
│  ├─ vectorstore.py      벡터 검색 (numpy → sqlite-vec → pgvector)
│  ├─ vocab.py            토픽별 단어사전 (TF-IDF)
│  ├─ topics.py           ★ 증분 토픽 배정·발견·LLM 명명
│  ├─ ingest.py           파이프라인 오케스트레이션
│  └─ rag.py              ★ 검색 + 프롬프트 + 인용 검증
├─ app/                   FastAPI + 정적 프런트엔드
├─ scripts/               CLI 도구
└─ data/                  PDF 원본 · chatbot.db  (백업은 이 폴더만 복사)
```

---

## 5. 지금 상태 (비계)

**동작하는 것**: 전체 파이프라인(업로드 → 청킹 → 임베딩 → 토픽 생성 → 질의응답 → 인용 표시)

**의도적으로 비워 둔 것**

1. **스캔본 OCR** — `core/extract.py: ocr_page()` 훅만 있음. 텍스트 레이어 PDF는 정상 동작
2. **스트리밍 응답** — 현재는 완성된 답을 한 번에 반환 (긴 답변에서 체감 대기 발생)
3. **인증** — 지금은 사내망 접근 = 사용 권한. 다중 사용자 단계에서 추가 필요
4. **하이브리드 검색** — 벡터 검색만. 단어사전이 이미 있으므로 BM25 결합은 어렵지 않음
5. **평가 세트** — 정답이 있는 질문 30~50개로 정확도·거절률을 재는 장치 (연구용으로는 필수)

**먼저 해야 할 일**: 실제 학교 매뉴얼 PDF 5~10개를 넣고
`TOPIC_ASSIGN_THRESHOLD`(분야가 잘게 쪼개지는가)와
`RETRIEVE_SCORE_FLOOR`(모르는 걸 모른다고 하는가)를 눈으로 보며 조정하는 것입니다.
