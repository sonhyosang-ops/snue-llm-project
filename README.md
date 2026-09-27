# 교육공무원 인사실무편람 RAG

등록된 학교 구성원이 편람의 장을 선택해, 해당 장의 PDF 근거 안에서 질문할 수 있는 경량 웹앱입니다.

## 기능

- `@baegotnuri.es.kr` 도메인 + 관리자 사전 등록 사용자만 로그인
- 관리자가 PDF를 업로드하면 Upstage가 문서를 파싱하고 목차 장을 인식
- 장 내부에서만 청킹·임베딩·핵심어 사전 생성
- 사용자가 선택한 장에서만 검색·답변
- 관련 핵심어가 다른 장에 있을 때만 장 변경 여부 확인
- 답변에 PDF 페이지 근거 표시

## 처음 한 번 설정

1. Supabase에서 새 프로젝트를 만들고 `supabase/schema.sql`을 SQL Editor에서 실행합니다.
2. `personnel-pdfs` Storage 버킷이 생성됐는지 확인합니다.
3. `allowed_users`에 첫 관리자를 추가합니다.

```sql
insert into public.allowed_users (email, role)
values ('관리자아이디@baegotnuri.es.kr', 'admin');
```

4. `.env.example`을 `.env.local`로 복사하고 Supabase·Upstage 키를 채웁니다.
5. 의존성을 설치하고 앱을 실행합니다.

```powershell
npm install
npm run dev
```

## 관리자 사용 순서

1. 학교 이메일로 로그인합니다.
2. 허용 사용자 이메일을 등록합니다.
3. `2025 교육공무원 인사실무편람(초등·유아)` PDF를 업로드합니다.
4. 업로드 및 색인을 누릅니다.
5. 목차 장 단위로 생성된 버튼이 사용자 화면에 보이는지 확인합니다.

첫 버전은 30MB 이하의 단일 편람을 대상으로 합니다. 문서 처리 중에는 화면을 유지해야 하며, 대형 문서·다수 문서 처리가 필요해질 때만 비동기 작업 큐를 추가합니다.

## 배포

Vercel 프로젝트에 이 저장소를 연결한 뒤 `.env.local`의 모든 값을 Vercel 환경 변수에도 등록합니다.
배포 전 Supabase Auth의 로그인 리디렉션 URL에 Vercel 주소와 로컬 주소를 추가합니다.

설계의 세부 사항은 [ARCHITECTURE.md](docs/ARCHITECTURE.md)에 있습니다.
