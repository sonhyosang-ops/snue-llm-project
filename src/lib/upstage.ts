// ─────────────────────────────────────────────────────────────────────────────
// upstage.ts — Upstage AI API 호출 모음 (RAG 파이프라인에서 "AI 모델"이 하는 일 전부)
//
//   색인 단계(관리자가 PDF를 올릴 때)
//     parsePdf              : PDF → 쪽별 텍스트 (Document Parse, OCR 포함)
//     detectChapterHeadings : 목차에서 최상위 "제 N 장"과 시작 쪽 찾기 (Chat 모델)
//     selectTopicTerms      : 장별 핵심어 후보 중 장 주제에 속하는 명사 고르기 (Chat 모델)
//     embed                 : 청크 본문 → 의미 벡터 (Embedding, passage 모델)
//   질문 단계(사용자가 질문할 때)
//     embed                 : 질문 → 의미 벡터 (Embedding, query 모델)
//     answerWithSources     : 검색된 근거만으로 답변 생성 (Chat 모델 + 퓨샷 예시)
//
// 모델 이름은 환경 변수(UPSTAGE_*_MODEL)로 바꿀 수 있고, 없으면 코드의 기본값을 쓴다.
// 임베딩 모델을 바꾸면 기존 벡터와 비교할 수 없으므로 문서를 다시 색인해야 한다.
// ─────────────────────────────────────────────────────────────────────────────
import { ANSWER_EXAMPLES } from "@/lib/answer-examples";

// PDF 파싱 결과의 한 쪽. page는 원본 PDF 기준 쪽 번호다.
export type ParsedPage = { page: number; text: string };
// 목차에서 찾은 장 하나. pageFrom은 그 장이 시작하는 PDF 쪽 번호다.
export type ChapterHeading = { title: string; chapterNumber: string; pageFrom: number };

const baseUrl = "https://api.upstage.ai/v1";

// API 키는 서버 환경 변수에서만 읽는다. 이 파일은 서버(API 라우트)에서만 쓰이므로
// 키가 브라우저로 전달되지 않는다. 키가 없으면 원인이 바로 보이도록 오류를 낸다.
function apiKey() {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new Error("UPSTAGE_API_KEY 환경 변수가 없습니다.");
  return key;
}

// HTML 태그를 지우고 공백을 하나로 모은다. 표(table)처럼 HTML로 돌아오는 요소를 평문으로 바꿀 때 쓴다.
function textFromHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Document Parse가 돌려주는 요소(문단, 제목, 표, 그림 등) 하나에서 글자만 꺼낸다.
// 요소마다 markdown / text / html 중 일부만 들어 있을 수 있어 순서대로 찾아본다.
// 주의: 그림·화면 캡처 요소에는 모델이 만든 영어 설명문이 들어올 수 있다.
//       이 설명은 청크에 그대로 남지만, 핵심어 사전에서는 tokens()(text.ts)가 영어를 걸러 낸다.
function elementText(element: Record<string, unknown>) {
  const content = element.content as Record<string, unknown> | undefined;
  const value = content?.markdown ?? content?.text ?? content?.html ?? element.text;
  if (typeof value !== "string") return "";
  return value.includes("<") ? textFromHtml(value) : value.trim();
}

// [색인 1단계] PDF를 Upstage Document Parse로 보내 쪽별 텍스트를 받는다.
//   - pdf        : 파싱할 PDF(최대 100쪽 단위로 잘라서 보낸다. ingest/route.ts의 parseRange 참고)
//   - pageOffset : 잘라 낸 조각의 1쪽이 원본에서 몇 쪽 뒤인지. 결과 쪽 번호를 원본 기준으로 되돌리는 데 쓴다.
// mode/ocr를 "auto"로 두면 글자 레이어가 없는 스캔 쪽은 자동으로 OCR(글자 인식)을 한다.
// 서버 오류(5xx)는 일시적일 수 있어 1.5초, 3초 간격으로 최대 3번 시도하고,
// 요청 자체가 잘못된 경우(4xx)는 다시 시도해도 같으므로 바로 오류를 낸다.
export async function parsePdf(pdf: Blob, filename: string, pageOffset = 0): Promise<ParsedPage[]> {
  let payload: { elements?: Record<string, unknown>[] } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const form = new FormData();
    form.append("model", process.env.UPSTAGE_PARSE_MODEL ?? "document-parse");
    form.append("document", new File([pdf], filename, { type: "application/pdf" }));
    form.append("mode", "auto");
    form.append("ocr", "auto");
    form.append("coordinates", "false");
    form.append("output_formats", "['markdown']");
    const response = await fetch(`${baseUrl}/document-digitization`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
    });
    if (response.ok) {
      payload = await response.json() as { elements?: Record<string, unknown>[] };
      break;
    }
    const error = await response.text();
    if (response.status < 500 || attempt === 2) throw new Error(`PDF 파싱 실패 (${filename}): ${error}`);
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1500));
  }
  if (!payload) throw new Error(`PDF 파싱 결과를 받지 못했습니다 (${filename}).`);
  // 요소들은 쪽 정보(page)를 하나씩 갖고 있다. 같은 쪽의 요소를 모아 쪽 단위 텍스트로 합친다.
  const grouped = new Map<number, string[]>();
  for (const element of payload.elements ?? []) {
    const page = typeof element.page === "number" ? element.page : 1;
    const text = elementText(element);
    if (text) grouped.set(page, [...(grouped.get(page) ?? []), text]);
  }
  const pages = [...grouped.entries()].sort(([a], [b]) => a - b).map(([page, values]) => ({ page: page + pageOffset, text: values.join("\n") }));
  if (!pages.length) throw new Error("PDF 파싱 결과에서 본문을 찾지 못했습니다.");
  return pages;
}

// Chat 모델 공통 호출 함수. 대화 메시지 배열을 보내고 모델의 답변 글자만 돌려준다.
//   - system    : 모델의 역할과 규칙
//   - user      : 사용자 입력(질문과 근거 등)
//   - assistant : 모델이 했던 답. 퓨샷 예시처럼 "이런 질문엔 이렇게 답한다"를 보여 줄 때 쓴다.
// temperature 0.1: 답변이 매번 크게 달라지지 않도록 무작위성을 낮게 둔다(근거 기반 답변에 적합).
async function chat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.UPSTAGE_CHAT_MODEL ?? "solar-pro4", temperature: 0.1, messages }),
  });
  if (!response.ok) throw new Error(`Upstage 답변 생성 실패: ${await response.text()}`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

// [색인 2단계] 문서 앞부분(목차)을 모델에 보여 주고 최상위 장 목록을 JSON으로 받는다.
// 장은 이 앱에서 "검색 범위"의 단위다. 사용자는 장을 고른 뒤 그 장 안에서만 답을 찾는다.
// 앞 15쪽만, 쪽마다 2,200자까지만 보내는 이유: 목차는 보통 앞부분에 있고, 너무 길게 보내면 비용과 오류가 늘어난다.
// 모델 출력은 그대로 믿지 않고 검사한다: 제목이 비었거나 쪽 번호가 문서 범위를 벗어난 항목은 버리고,
// 같은 장 번호가 두 번 나오면(하위 항목을 장으로 착각한 경우) 잘못된 데이터를 저장하지 않도록 오류를 낸다.
export async function detectChapterHeadings(pages: ParsedPage[], totalPages: number): Promise<ChapterHeading[]> {
  const preview = pages.slice(0, 15).map((page) => `[${page.page}쪽]\n${page.text.slice(0, 2200)}`).join("\n\n");
  const raw = await chat([
    { role: "system", content: "당신은 PDF 목차 분석기입니다. 제공된 문서 앞부분의 목차에서 최상위 '제 N 장'만 찾으세요. 하위 번호(1., 2., 3. 등)는 절대로 반환하지 마세요. chapterNumber마다 정확히 한 항목만 반환합니다. 목차가 두 칼럼으로 추출되어 장 제목이 여러 줄에 흩어질 수 있습니다. 예를 들어 '제 1 장', '교육법과 2. ...', '교원 정원 3. ...'이면 title은 '교육법과 교원 정원'입니다. pageFrom은 해당 장의 첫 하위 항목에 적힌 실제 PDF 시작 쪽입니다. JSON 배열만 반환하세요. 각 항목은 title, chapterNumber, pageFrom만 가지며, title에는 제N장 표기를 넣지 않습니다." },
    { role: "user", content: preview },
  ]);
  // 모델이 JSON 앞뒤에 설명을 붙일 수 있으므로, 응답에서 [ ... ] 부분만 찾아 해석한다.
  const match = raw.match(/\[[\s\S]*\]/);
  let headings: { title?: string; chapterNumber?: string; pageFrom?: number }[] = [];
  try { headings = match ? JSON.parse(match[0]) : []; } catch { headings = []; }
  const normalized = headings
    .map((item) => ({ title: String(item.title ?? "").trim(), chapterNumber: String(item.chapterNumber ?? "").trim(), pageFrom: Number(item.pageFrom) }))
    .filter((item) => item.title && Number.isInteger(item.pageFrom) && item.pageFrom >= 1 && item.pageFrom <= totalPages)
    .sort((a, b) => a.pageFrom - b.pageFrom);
  const numbers = new Set<string>();
  for (const heading of normalized) {
    if (numbers.has(heading.chapterNumber)) throw new Error("목차에서 같은 장이 여러 번 감지되었습니다. 장 제목을 다시 확인해 주세요.");
    numbers.add(heading.chapterNumber);
  }
  return normalized;
}

// [색인 4단계] 장별 핵심어 후보(text.ts의 chapterKeywordCandidates) 중에서 장 주제에 속하는 명사만 고른다.
//   - chapterTitle : 대상 장 제목
//   - otherTitles  : 다른 장 제목들. "이 낱말은 다른 장 주제에 더 가깝다"를 판단하게 하려고 함께 보낸다.
//   - candidates   : 본문에서 뽑은 후보 낱말(최대 300개)
//
// 설계 원칙 — 본문에 없는 낱말은 절대 사전에 들어가지 않는다.
//   모델에게 "골라 달라"고 하면 후보에 없는 유의어를 만들어 낼 수 있다. 그래서 모델에게는 후보마다
//   "주제 / 다른장 / 제외" 꼬리표만 붙이게 하고, 코드는 후보 목록(batch)을 기준으로 "주제" 꼬리표가 붙은 것만 남긴다.
//   모델이 후보에 없는 낱말을 응답에 넣어도 batch에 없으므로 결과에 들어올 수 없다.
//
// 60개씩 나누어 묻는 이유: 300개를 한 번에 주면 모델이 일부를 빠뜨리거나 판단이 들쭉날쭉해진다.
// 응답을 JSON으로 읽지 못하면 최대 3번 다시 묻고, 그래도 안 되면 잘못된 사전을 조용히 저장하지 않도록 오류를 낸다.
export async function selectTopicTerms(chapterTitle: string, otherTitles: string[], candidates: string[]) {
  const picked: string[] = [];
  for (let index = 0; index < candidates.length; index += 60) {
    const batch = candidates.slice(index, index + 60);
    let labels: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 3 && !labels; attempt += 1) {
      const raw = await chat([
        { role: "system", content: "당신은 교육공무원 인사실무편람의 장별 핵심어 사전을 만드는 분류기입니다. 후보 낱말은 대상 장 본문에서 추출한 것입니다. 후보마다 다음 중 하나로 분류하세요.\n- \"주제\": 대상 장 제목이 가리키는 주제나 그 하위 주제에 직접 속하는 명사(복합명사 포함)\n- \"다른장\": 다른 장 제목이 가리키는 주제에 더 가까운 명사\n- \"제외\": 동사·형용사·부사, 어미나 조사가 붙은 말('휴직하였던', '위반한', '직을'), 어느 장에나 나오는 일반 행정어('사항', '경우', '규정', '소속'), 단위, 주제와 무관한 고유명사·기관명, 글자 인식 오류로 보이는 말\n예: 대상 장이 '휴직 및 복직'이면 '육아휴직', '복직원', '진단서'는 주제, '연가'는 다른장, '휴직중인', '사항'은 제외입니다.\n후보 낱말을 키로, 분류를 값으로 하는 JSON 객체만 반환하세요. 키는 후보의 글자를 그대로 씁니다." },
        { role: "user", content: `대상 장: ${chapterTitle}\n다른 장: ${otherTitles.join(", ")}\n후보: ${batch.join(", ")}` },
      ]);
      const match = raw.match(/\{[\s\S]*\}/);
      try { labels = match ? JSON.parse(match[0]) : null; } catch { labels = null; }
    }
    if (!labels) throw new Error(`'${chapterTitle}' 장의 핵심어 분류 결과를 읽지 못했습니다.`);
    // 후보(batch)를 기준으로 걸러 내므로, 모델이 지어낸 낱말은 여기서 자동으로 빠진다.
    picked.push(...batch.filter((term) => labels[term] === "주제"));
  }
  return picked;
}

// [색인 3단계 / 질문 단계] 글을 "의미 벡터(임베딩)"로 바꾼다.
// 임베딩은 글의 의미를 숫자 배열로 나타낸 것으로, 뜻이 비슷한 글일수록 벡터 사이의 거리가 가깝다.
// 그래서 낱말이 정확히 같지 않아도("육아휴직 기간" ↔ "아이를 키우려고 쉬는 기간") 관련 청크를 찾을 수 있다.
//   - 청크 본문은 passage 모델(embedding-passage), 질문은 query 모델(embedding-query)로 만든다.
//     Upstage는 문서용·질문용 모델을 한 쌍으로 학습시켰기 때문에 반드시 짝을 맞춰 써야 한다.
//   - 16개씩 묶어 보내고 묶음 사이에 0.25초 쉬어 요청 한도(429)에 덜 걸리게 한다.
export async function embed(texts: string[], model: string) {
  // 묶음 하나를 보내는 내부 함수. 실패 유형에 따라 다르게 대응한다.
  const requestBatch = async (input: string[]): Promise<number[][]> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input }),
      });
      if (response.ok) {
        // 응답 순서가 입력 순서와 다를 수 있으므로 index로 정렬해 청크와 벡터의 짝을 맞춘다.
        const payload = await response.json() as { data?: { index: number; embedding: number[] }[] };
        return (payload.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
      }
      const error = await response.text();
      // 묶음 전체가 모델의 최대 입력 길이(약 4,000토큰)를 넘으면 묶음을 반으로 나눠 다시 보낸다(재귀).
      if (response.status === 400 && error.includes("maximum context length") && input.length > 1) {
        const middle = Math.ceil(input.length / 2);
        return [...await requestBatch(input.slice(0, middle)), ...await requestBatch(input.slice(middle))];
      }
      // 요청 한도 초과(429)나 서버 오류(5xx)는 잠시 뒤 다시 시도하면 풀리는 경우가 많다. 점점 길게 기다린다.
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`임베딩 생성 실패: ${error}`);
    }
    throw new Error("임베딩 생성 재시도 횟수를 초과했습니다.");
  };

  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += 16) {
    vectors.push(...await requestBatch(texts.slice(index, index + 16)));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // 벡터 수가 청크 수와 다르면 청크와 벡터의 짝이 어긋난 것이므로 저장하지 않고 멈춘다.
  if (vectors.length !== texts.length) throw new Error("임베딩 결과 수가 청크 수와 다릅니다.");
  return vectors;
}

// [질문 단계 마지막] 검색으로 찾은 근거(청크)만 보고 답변을 만든다. RAG의 "G(Generation)" 부분이다.
//
// 메시지 구성:
//   1) system  : 역할·규칙(근거 안에서만 답하기, [번호] 인용, 근거 부족 시 "확인할 수 없음")과 답변 형식(eDASAN 공문체)
//   2) 퓨샷 예시: answer-examples.ts의 문답을 user/assistant 쌍으로 넣어 "이런 근거엔 이런 형식으로 답한다"를 보여 준다.
//                 모델은 규칙 설명보다 예시를 더 강하게 따라 하므로, 형식을 바꿀 때는 규칙과 예시를 함께 바꿔야 한다.
//   3) user    : 실제 질문과 근거 목록. 근거마다 [1], [2]… 번호를 붙여 보내므로 답변의 [번호]가 화면의 근거 목록과 맞는다.
//
// 환각(hallucination)을 줄이는 장치: 근거 밖 지식 사용 금지, 없는 번호 인용 금지,
// 예시 내용을 현재 질문의 근거로 섞지 말 것을 system 규칙에 명시한다.
export async function answerWithSources(question: string, sources: { content: string; page_from: number; page_to: number; heading: string }[]) {
  const context = sources.map((source, index) => `[${index + 1}] ${source.heading || "본문"} (${source.page_from}~${source.page_to}쪽)\n${source.content}`).join("\n\n");
  return chat([
    { role: "system", content: "당신은 교육공무원 인사실무편람 안내 도우미입니다. 제공된 근거 안에서만 한국어로 답하세요. 근거가 부족하면 확인할 수 없다고 말하세요. 사실 문장마다 [1]처럼 근거 번호를 붙이세요. 번호는 제공된 근거의 같은 번호만 사용하고, 존재하지 않는 번호를 만들지 마세요. 일반 지식이나 추측을 사용하지 마세요.\n\n답변 작성 방식: 문장을 '○ '로 시작하는 항목으로 나누어 줄을 바꿔 쓰고, '~합니다', '~할 수 있습니다', '~함을 안내드립니다'와 같은 존댓말 공문체로 쓰세요. 먼저 적용되는 법령·규정·지침을 「」로 표기하고 조문이나 별표 단위로 특정한 뒤, 일반 원칙을 밝히고 질문의 사례에 적용하여 '○ 따라서, ~'로 결론을 맺으세요. 예외나 단서는 '다만,'으로 구분하세요. 질문이 여러 개이면 <답변1>, <답변2>처럼 질문 번호별로 나누어 답하고, 근거로 확인할 수 없는 질문은 해당 번호 아래에 확인할 수 없다고 쓰세요. 근거가 단정을 뒷받침하지 않으면 '~로 보입니다', '~보기 어렵습니다'처럼 유보하세요. 앞선 대화의 문답은 이 작성 방식을 보여 주는 예시일 뿐이므로, 그 내용을 현재 질문의 근거로 인용하거나 섞지 마세요." },
    ...ANSWER_EXAMPLES.flatMap((example) => [
      { role: "user" as const, content: `질문: ${example.question}\n\n근거:\n${example.sources}` },
      { role: "assistant" as const, content: example.answer },
    ]),
    { role: "user", content: `질문: ${question}\n\n근거:\n${context}` },
  ]);
}
