# 프로젝트 이어받기 문서

## 새 대화에서 가장 먼저 적용할 지시문

다음 문서는 `LLM_RAG_PROJECT`의 인수인계 자료다. 이 문서를 읽은 뒤 현재 프로젝트 상태, 완료된 작업, 미완료 작업, 작업 원칙을 파악하고 사용자의 새 요청을 이어서 처리한다.

```text
이 문서를 프로젝트 인수인계 자료로 읽고 이전 작업을 이어서 진행해 줘.

현재 우선 작업은 [여기에 작업 내용을 입력]이다.

작업 규칙:
1. 기존 완료 작업을 다시 처음부터 반복하지 않는다.
2. 먼저 현재 상태와 관련 파일을 확인한다.
3. 비밀키, 서비스 키, API 키는 출력하거나 문서에 기록하지 않는다.
4. 변경이 필요한 경우 간단하고 필요한 범위만 수정한다.
5. 코드 변경 후 `npm run typecheck`, `npm run build`, `git diff --check`를 실행한다.
6. 외부 배포나 데이터 변경이 필요한 경우 실행 전에 그 범위를 설명한다.
7. 작업이 끝나면 변경 내용, 검증 결과, 남은 작업을 한국어로 간단히 보고한다.
```

사용 방법:

1. 새 대화에 이 문서를 업로드한다.
2. 위 지시문에서 `[여기에 작업 내용을 입력]` 부분을 실제 작업 내용으로 바꿔 메시지로 함께 보낸다.
3. 예: `현재 우선 작업은 .csv와 .xlsx 사용자 일괄 등록 기능 구현이다.`

파일만 업로드하면 대화가 자동으로 실행되는 것은 아니므로, 업로드 후 위 지시문 또는 작업 내용을 한 문장으로 함께 보내야 한다. 문서 안의 내용은 프로젝트 참고자료이며, 새 대화에서 사용자가 요청한 작업 범위와 충돌하면 사용자의 최신 요청을 우선한다.

이 문서는 새 대화에서 `LLM_RAG_PROJECT` 작업을 계속하기 위한 현재 상태 요약이다.

작성일: 2026-09-27 (최종 갱신: 2026-10-24)

## 1. 프로젝트 목적

학교 이메일 사용자에게 교육공무원 인사실무편람 PDF를 근거로 답변하는 웹앱이다.

- 일반 사용자: 학교 이메일로 로그인 → 장 선택 → 질문
- 관리자: 허용 사용자 관리, PDF 업로드, 문서 색인
- 허용 도메인: `@baegotnuri.es.kr`
- 운영 주소: `https://snue-llm-project.vercel.app`
- 로컬 주소: `http://localhost:3000`
- 로컬 관리자 주소: `http://localhost:3000/admin`
- 운영 관리자 주소: `https://snue-llm-project.vercel.app/admin`

## 2. 최종 기술 구조

```text
Next.js 웹앱
  ├─ Supabase Auth: 이메일 매직 링크 로그인
  ├─ Supabase PostgreSQL: 사용자·문서·장·청크·임베딩·키워드
  ├─ Supabase Storage: 비공개 PDF 저장
  ├─ Upstage Document Parse: PDF 파싱
  ├─ Upstage Embedding: 청크·질문 임베딩
  └─ Upstage Chat: 근거 기반 답변
```

최종 운영 코드는 TypeScript/Next.js이며 Python 백엔드는 사용하지 않는다. Python 학습 코드는 별도 폴더에 보존되어 있다.

## 3. 프로젝트 위치

최종 웹앱:

`C:\Users\mutel\Downloads\LLM_Agent_Project\LLM_RAG_PROJECT`

Upstage 학습 자료:

`C:\Users\mutel\Downloads\LLM_Agent_Project\upstage_API`

## 4. 현재 구현된 주요 경로

- `src/app/page.tsx`: 일반 사용자 화면
- `src/app/admin/page.tsx`: 관리자 전용 화면
- `src/app/auth/callback/page.tsx`: 매직 링크 로그인 완료 안내·확인 창 닫기 처리
- `src/app/api/auth/request/route.ts`: 로그인 링크 발송
- `src/app/api/admin/users/route.ts`: 관리자 사용자 등록·목록
- `src/app/api/admin/documents/route.ts`: PDF 업로드
- `src/app/api/admin/documents/[id]/ingest/route.ts`: PDF 파싱·장 분리·청킹·임베딩
- `src/app/api/chapters/route.ts`: 현재 문서와 장 조회
- `src/app/api/ask/route.ts`: 질문 임베딩·검색·답변 생성
- `src/lib/upstage.ts`: Upstage API 호출
- `src/lib/text.ts`: 토큰화·키워드·청크 처리
- `src/lib/auth.ts`: 사용자·관리자 권한 확인
- `supabase/schema.sql`: Supabase 테이블·함수·권한 구조
- `docs/PROJECT_RESULT_REPORT.md`: 전체 결과 보고서

## 5. Supabase 상태

Supabase 프로젝트는 구성되어 있으며 다음 테이블과 버킷이 있다.

- `allowed_users`
- `profiles`
- `documents`
- `chapters`
- `chunks`
- `embeddings`
- `chapter_keywords`
- `messages`
- Storage bucket: `personnel-pdfs` 비공개

관리자 계정:

`hyosang@baegotnuri.es.kr`

관리자 계정의 현재 역할은 `admin`, 활성 상태는 `true`로 확인·복구했다. 일반 사용자는 `user` 역할이며 `/admin`을 사용할 수 없다. 사용자 등록 API는 기존 관리자 이메일을 다시 등록해도 역할을 `user`로 덮어쓰지 않게 보완되어 있다.

서비스 키와 API 키는 `.env.local` 및 Vercel 환경변수에 저장되어 있으므로 절대 문서나 채팅에 복사하지 않는다.

## 6. 현재 문서 데이터 상태

현재 활성 문서는 571쪽 PDF이며, 기존 파싱 결과를 재정리했다.

- 기존 검색 청크: 1,148개
- 최상위 장: 8개
- 기존 임베딩 유지
- 장별 중요낱말 사전 재구성 완료

현재 장 목록:

1. 교육법과 교원 정원
2. 교원의 임용
3. 휴직 및 복직
4. 복무
5. 평정 업무
6. 징계 및 직위해제
7. 호봉획정 및 승급
8. NEIS 교원인사관리

## 7. 최근 수정 내용

### PDF 파싱

- Upstage 100쪽 제한을 고려해 내부적으로 PDF를 분할한다.
- 목차의 하위 항목이 장으로 잘못 생성되던 문제를 수정했다.
- `제 N 장` 단위만 최상위 장으로 인식하도록 파싱 프롬프트를 수정했다.
- 임베딩 요청이 4,000토큰을 넘으면 자동으로 재분할한다.
- Upstage 429·5xx 오류에는 대기 후 재시도한다.

### 관리자 화면

- 관리자 기능을 메인 사용자 화면에서 분리했다.
- 관리자 화면 경로는 `/admin`이다.
- 문서 제목 입력값은 더 이상 샘플 제목을 기본값으로 넣지 않는다.
- 문서 제목은 빈 입력란이며, `문서 제목을 입력하세요`라는 안내만 표시한다.

### 인증

- 이메일 발송 제한 오류를 한글 메시지로 표시하도록 수정했다.
- 매직 링크는 일회용이고 만료될 수 있다.
- Resend Custom SMTP 연결을 완료했고 로그인 메일 발송 성공을 확인했다.
- 발신 도메인 `send.muteli.kr`은 검증 상태를 확인했다.
- 매직 링크는 `/auth/callback`으로 이동한다. 확인 창은 세션을 저장한 뒤 약 1.5초 후 자동 닫기를 시도한다.
- 처음 로그인 요청을 한 창은 같은 브라우저 안에서 세션을 감지해 자동으로 채팅 화면으로 전환된다.
- 이메일 링크를 다른 브라우저로 열면 세션이 공유되지 않으므로 같은 브라우저에서 열어야 한다.

### 답변 형식 (2026-10-24)

- 답변은 eDASAN 교원인사 답변사례 형식(`○` 항목, 존댓말 공문체, 질문이 여러 개면 `<답변1>`·`<답변2>`)을 따른다.
- 퓨샷 예시는 `src/lib/answer-examples.ts`에 있다: 호봉획정 1건 + eDASAN 세부분야별 최신 답변 7건.
- 형식을 바꿀 때는 `src/lib/upstage.ts`의 시스템 프롬프트와 예시를 함께 바꾼다. 둘이 어긋나면 모델은 예시를 따른다.
- 기본 답변 모델은 `solar-pro4`다(`UPSTAGE_CHAT_MODEL`로 변경 가능).

### 답변 근거 표시

- Upstage 답변에는 검색 근거 순서와 일치하는 `[1]`, `[2]` 인용 번호를 사용하도록 지시했다.
- 화면 하단의 **확인한 근거**도 같은 `[번호]`를 표시한다.
- 각 항목에는 꼭지 제목, 페이지 범위, 검색에 사용한 원문 일부가 표시된다.

## 8. 현재 미완료 작업

우선순위 순서:

완료된 최종 사용자 흐름 테스트:

- 일반 사용자 계정으로 로그인 링크 요청 → 이메일 확인 → 로그인 → 장 선택 → 질문 → 답변 확인을 완료했다.

1. 관리자 사용자 일괄 등록 기능
   - `.csv` 및 `.xlsx` 업로드
   - 첫 번째 열 이메일 추출
   - 중복 제거
   - `@baegotnuri.es.kr` 외 주소 제외
   - 등록·중복·실패 건수 표시
   - 현재는 아직 구현하지 못했다.
   - `.xlsx` 처리 라이브러리 설치 시도는 Codex 사용량 제한으로 차단되었다.

2. PDF 표지에서 문서 제목 자동 추출
   - 파싱 완료 후 표지 제목을 문서 제목에 자동 반영
   - 관리자가 제목을 수정할 수 있도록 유지

3. ~~Vercel 최신 코드 재배포~~ (2026-10-24 완료, 아래 "배포 방식" 참고)

### 배포 방식 (2026-10-24 갱신)

- Vercel 프로젝트 `snue-llm-project`(운영 주소 `https://snue-llm-project.vercel.app`)가 GitHub `sonhyosang-ops/snue-llm-project`의 `master`에 연결되어 있다.
- `git push origin main:master`만 하면 Vercel이 자동으로 빌드·배포한다. CLI 배포(`vercel --prod`)는 더 이상 필요 없다.
- 배포 결과는 Vercel 대시보드 또는 GitHub 커밋 옆 Vercel 상태 표시로 확인한다.
- 별도 프로젝트 `snue-llm-project-t1zs`도 같은 저장소에 연결되어 있어 푸시마다 함께 배포된다. 운영 주소가 아니므로 정리(삭제 또는 Git 연결 해제) 대상이다.
- Supabase와 Resend SMTP 설정은 각 대시보드에 저장된 설정이라 푸시로 배포되지 않는다.

### 2026-10-24 장애 기록

- 로컬 로그인 시 `TypeError: fetch failed`: Supabase 무료 플랜이 7일 미사용으로 프로젝트를 일시정지해 주소가 DNS에서 사라졌다. 대시보드에서 Restore 후 약 25분 뒤 복구되었다. 운영을 계속하려면 Pro 플랜이나 주기적 접속이 필요하다.
- `snue-llm-project-t1zs` 첫 배포 실패(`supabaseUrl is required`): 환경변수가 이름만 있고 값이 비어 있었다. `.env.local` 값으로 덮어써 해결했다. Vercel의 sensitive 값은 저장 후 다시 볼 수 없으므로 값을 바꿀 때는 `.env.local`을 기준으로 덮어쓴다.
- 같은 실패가 빌드를 막지 않도록 `src/lib/browser-supabase.ts`의 대체값 처리를 `??`에서 `||`로 바꿨다(빈 문자열도 대체값 사용).
- 개발 화면의 hydration 경고는 브라우저 확장(Liner 등)이 `<html>`·`<body>`에 속성을 붙여서 생긴다. `layout.tsx`에 `suppressHydrationWarning`을 추가했다.
- `next-env.d.ts`는 `next dev`·`next build`가 실행할 때마다 다시 만들어 Git 변경이 계속 생기므로, Next.js 문서 권장대로 Git 추적에서 제외했다.

## 9. GitHub 저장소 및 커밋 상태

- 현재 원격 저장소(`origin`): `https://github.com/sonhyosang-ops/snue-llm-project.git`
- 원격 기본 브랜치: `master`
- 로컬 작업 브랜치: `main`
- 2026-09-27에 기존 원격 `master` 내용은 사용자의 명시적 요청에 따라 현재 로컬 Next.js·Supabase·Upstage 프로젝트 구조로 강제 교체했다.
- 교체 기준 커밋: `cc42cdd feat: deploy personnel guide RAG web app`
- 이전 Python·FastAPI 중심 파일은 현재 로컬 구조에 없으므로 원격 저장소에서도 제거되었다.
- 실행 로그 `dev.log`와 `.env.local` 등 비밀·로컬 파일은 GitHub에 올리지 않는다.
- 이후 변경은 `git status` 확인 후 `git add -A`, `git commit`, `git push origin main:master` 순서로 반영한다. 원격 `master`에 다른 사람이 변경한 경우 강제 전송 전에는 반드시 사용자에게 확인한다.

## 10. 인증 오류 참고

`email rate limit exceeded`:

- Custom SMTP 구성 전에는 Supabase 기본 이메일 발송 제한 초과가 원인일 수 있다.
- 같은 이메일로 반복 요청하지 않는다.
- 가장 최근 메일의 링크만 사용한다.
- 링크는 한 번만 사용할 수 있다.
- 잠시 기다린 뒤 다시 요청한다.
- SMTP 설정을 변경한 뒤에는 Resend 발송 기록과 Supabase Auth 로그를 함께 확인한다.

`otp_expired` 또는 `Email link is invalid or has expired`:

- 오래된 링크이거나 이미 사용한 링크다.
- 새 로그인 링크를 한 번만 요청하고 즉시 사용한다.
- 로컬 로그인 링크와 Vercel 로그인 링크를 혼용하지 않는다.

`관리자만 사용할 수 있습니다`:

- 로그인 세션 문제라기보다 `allowed_users.role`이 `user`인 경우 발생한다.
- `hyosang@baegotnuri.es.kr`은 현재 `admin`으로 복구되어 있다.
- 관리자 이메일을 다시 등록해도 기존 역할이 유지되도록 API를 수정했다.

## 11. 검증 명령

코드 수정 후 최소한 다음을 실행한다.

```powershell
npm run typecheck
npm run build
git diff --check
```

로컬 실행:

```powershell
npm run dev
```

## 12. 새 대화에서 첫 응답에 붙여넣을 내용

다음 문장을 새 대화의 첫 메시지로 사용하면 된다.

> `C:\Users\mutel\Downloads\LLM_Agent_Project\LLM_RAG_PROJECT\docs\PROJECT_HANDOFF.md`를 읽고 이전 작업을 이어서 진행해 줘. 현재 우선 작업은 [여기에 작업 내용 입력]이다. 비밀키는 출력하지 말고, 변경 후 typecheck와 build를 실행해 줘.

## 13. 작업 원칙

- 빠르고 단순한 MVP를 우선한다.
- Supabase PostgreSQL 하나를 사용하고 장별 물리 DB는 만들지 않는다.
- Python 백엔드를 새로 추가하지 않는다.
- API 키와 서비스 키를 로그·보고서·채팅에 출력하지 않는다.
- PDF 파싱이 틀리면 잘못된 데이터를 조용히 저장하지 말고 오류를 표시한다.
- Vercel 배포 전 로컬 typecheck와 build를 먼저 실행한다.
- GitHub 원격 `master`를 강제 교체하는 작업은 사용자의 명시적 요청이 있을 때만 수행한다.
