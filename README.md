# 학교 업무 지식 도우미

학교 업무 PDF를 주제(챕터)별로 관리하고, 선택한 주제의 공식 자료를 근거로 질문에 답변하도록 만드는 Next.js 웹 애플리케이션입니다.

## 시작하기

필요한 패키지를 설치한 뒤 개발 서버를 실행합니다.

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 열면 됩니다. 화면 코드는 `app/page.tsx`에서 수정하며, 저장하면 개발 화면에 자동으로 반영됩니다.

## 환경 변수

프로젝트 최상위에 `.env.local` 파일을 만들고 다음 값을 설정합니다.

```env
NEXT_PUBLIC_SUPABASE_URL=https://프로젝트ID.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=Supabase_공개_키
UPSTAGE_API_KEY=Upstage_API_키
```

`UPSTAGE_API_KEY`는 비밀값입니다. GitHub에 올리거나 브라우저에서 사용하는 `NEXT_PUBLIC_` 변수로 만들지 마세요.

## 주요 기능

- `@baegotnuri.es.kr` 및 `snue.ac.kr` 계열 이메일 로그인
- 역할별 접근 권한: 일반 교사, 교감, 교무, 시스템 개발자
- 관리자의 추가 업로드 권한 부여
- PDF 업로드와 챕터별 업무 주제 관리 기반
- 선택한 주제의 근거 자료를 표시하는 질의응답 화면

## 배포

Vercel 프로젝트에 연결되어 있으며, 환경 변수는 Vercel의 Production, Preview, Development 환경에 각각 등록해야 합니다. 배포 전에는 다음 명령으로 프로덕션 빌드를 확인합니다.

```bash
npm run build
```

## 기술 구성

- [Next.js](https://nextjs.org)
- [Supabase](https://supabase.com)
- [Vercel](https://vercel.com)
- Upstage API
