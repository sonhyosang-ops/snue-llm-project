// ─────────────────────────────────────────────────────────────────────────────
// upstage.ts — Upstage AI API 호출 모음 (RAG 파이프라인에서 "AI 모델"이 하는 일 전부)
//
//   색인 단계(관리자가 PDF를 올릴 때)
//     parsePdf              : PDF → 쪽별 텍스트 (Document Parse, OCR 포함)
//     detectOutline         : 목차 항목을 수준·쪽과 함께 읽어 "목차 초안" 만들기 (Chat 모델, 관리자가 확인 후 확정)
//     selectTopicTerms      : 장별 핵심어 후보 중 장 주제에 속하는 명사 고르기 (Chat 모델)
//     embed                 : 청크 본문 → 의미 벡터 (Embedding, passage 모델)
//   질문 단계(사용자가 질문할 때)
//     embed                 : 질문 → 의미 벡터 (Embedding, query 모델)
//     rewriteQuestion       : 최근 문답을 참고해 짧은 후속 질문을 완전한 문장으로 (Chat 모델)
//     answerWithSources     : 검색된 근거만으로 답변 생성 (Chat 모델 + 퓨샷 예시)
//   문제 풀기(사용자가 "문제 만들기"를 누를 때)
//     generateQuiz          : 근거 원문만으로 O/X·4지선다 문제 만들기 (Chat 모델, JSON 스키마)
//
// 모델 이름은 환경 변수(UPSTAGE_*_MODEL)로 바꿀 수 있고, 없으면 코드의 기본값을 쓴다.
// 임베딩 모델을 바꾸면 기존 벡터와 비교할 수 없으므로 문서를 다시 색인해야 한다.
// ─────────────────────────────────────────────────────────────────────────────
import { ANSWER_EXAMPLES } from "@/lib/answer-examples";
import { conclusionFirst, groupByCitation } from "@/lib/answer-format";
import type { OutlineDraft } from "@/lib/types";

// PDF 파싱 결과의 한 쪽. page는 원본 PDF 기준 쪽 번호다.
export type ParsedPage = { page: number; text: string };

const baseUrl = "https://api.upstage.ai/v1";

// API 키는 서버 환경 변수에서만 읽는다. 이 파일은 서버(API 라우트)에서만 쓰이므로
// 키가 브라우저로 전달되지 않는다. 키가 없으면 원인이 바로 보이도록 오류를 낸다.
function apiKey() {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new Error("UPSTAGE_API_KEY 환경 변수가 없습니다.");
  return key;
}

// 글 속의 HTML 태그(표 칸 안의 <br> 등)를 지운다. 띄어쓰기·탭만 하나로 모으고 줄바꿈은 남긴다.
// 줄바꿈까지 공백으로 합치면 마크다운 표의 행 구분이 사라져 표 전체가 한 줄로 뭉개진다(2026-10-24 이전 색인 데이터의 문제).
function textFromHtml(value: string) {
  return value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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

// [색인 공통: 목차 초안·장 본문 단계] PDF를 Upstage Document Parse로 보내 쪽별 텍스트를 받는다.
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
// responseFormat: OpenAI 호환 response_format(JSON 스키마). 주면 모델이 그 모양의 JSON만 출력한다.
//   API가 이 옵션을 거부하면(400) 옵션 없이 한 번 더 보낸다. 그러면 평문이 오고, 부르는 쪽(parseAnswer)이 평문도 받아 준다.
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// chat()과 chatStream()이 함께 쓰는 요청 함수. stream=true면 응답이 한 번에 오지 않고 글자 조각 단위로 흘러온다.
async function requestChat(messages: ChatMessage[], responseFormat: object | undefined, stream: boolean) {
  const send = (withFormat: boolean) => fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.UPSTAGE_CHAT_MODEL ?? "solar-pro4", temperature: 0.1, messages, ...(stream ? { stream: true } : {}), ...(withFormat && responseFormat ? { response_format: responseFormat } : {}) }),
  });
  let response = await send(true);
  if (!response.ok && responseFormat && response.status === 400) response = await send(false);
  if (!response.ok) throw new Error(`Upstage 답변 생성 실패: ${await response.text()}`);
  return response;
}

async function chat(messages: ChatMessage[], responseFormat?: object) {
  const response = await requestChat(messages, responseFormat, false);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

// 스트리밍 호출(교재 8장 sec04의 llm.stream과 같은 일). 모델이 글자 조각을 만드는 대로 onDelta로 넘기고, 끝나면 전체 글을 돌려준다.
// stream: true면 응답 본문이 SSE(Server-Sent Events) 형식이다. "data: {JSON}" 줄이 이어지고 마지막은 "data: [DONE]"이다.
// 조각이 줄 중간에서 끊겨 올 수 있으므로, 받은 글자를 buffer에 모아 두고 줄바꿈이 완성된 줄만 꺼내 읽는다.
async function chatStream(messages: ChatMessage[], responseFormat: object | undefined, onDelta: (text: string) => void) {
  const response = await requestChat(messages, responseFormat, true);
  if (!response.body) throw new Error("Upstage 답변 생성 실패: 응답 본문이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
      if (delta) { full += delta; onDelta(delta); }
    }
  }
  return full.trim();
}

// [색인 1단계: 목차 초안] 문서 앞부분(목차)을 모델에 보여 주고 "목차 초안"을 JSON으로 받는다.
// 장은 이 앱에서 "검색 범위"의 단위다. 사용자는 장을 고른 뒤 그 장 안에서만 답을 찾는다.
//
// 매뉴얼마다 목차 형식이 달라서("제 1 장", "Ⅰ.", "1." 등) 모델이 장을 정확히 고르리라 믿기 어렵다.
// 그래서 여기서는 장을 확정하지 않고, 목차 항목을 수준(level)과 함께 모두 받아 "초안"으로만 저장한다.
// 관리자가 화면에서 장으로 쓸 수준을 고르고, 제목·쪽을 고친 뒤 확정한다(/api/admin/documents/[id]/outline).
//
// 쪽 번호: 목차에 인쇄된 쪽(page)과 실제 PDF 쪽은 표지·목차 때문에 어긋나는 경우가 많다.
// 모델에게 본문 쪽 아래 인쇄된 번호와 [N쪽](실제 PDF 쪽)을 비교해 차이(offset)를 추정하게 하고, 관리자가 확인·수정한다.
// 앞 15쪽만, 쪽마다 2,200자까지만 보내는 이유: 목차는 보통 앞부분에 있고, 너무 길게 보내면 비용과 오류가 늘어난다.
export async function detectOutline(pages: ParsedPage[]): Promise<OutlineDraft> {
  const preview = pages.slice(0, 15).map((page) => `[${page.page}쪽]\n${page.text.slice(0, 2200)}`).join("\n\n");
  const raw = await chat([
    { role: "system", content: "당신은 PDF 목차 분석기입니다. 제공된 문서 앞부분에서 목차를 찾아 항목을 순서대로 반환하세요.\n- level: 1은 가장 큰 단위(예: '제 1 장', '제1편', 'Ⅰ.'), 2는 그 바로 아래(예: '1.', '가.'), 3은 그 아래입니다. level 3보다 깊은 항목은 빼세요.\n- number: 번호만 적습니다(예: '제 1 장'은 '1', 'Ⅰ.'은 'Ⅰ', '가.'는 '가'). 번호가 없으면 빈 문자열입니다.\n- title: 번호를 뺀 제목입니다. 목차가 두 칼럼으로 추출되어 제목이 여러 줄에 흩어질 수 있습니다. 예를 들어 '제 1 장', '교육법과 2. ...', '교원 정원 3. ...'이면 level 1 항목의 title은 '교육법과 교원 정원'입니다.\n- page: 목차에 인쇄된 쪽 번호(정수)입니다. 쪽 번호가 적혀 있지 않은 큰 단위는 그 첫 하위 항목의 쪽 번호를 씁니다.\n- offset: 각 쪽 앞의 [N쪽]은 실제 PDF 쪽 번호입니다. 본문 쪽에 인쇄된 쪽 번호와 비교해 '실제 PDF 쪽 − 인쇄된 쪽'을 정수로 추정하세요. 모르면 0입니다.\n형식: {\"offset\": 정수, \"items\": [{\"level\": 1, \"number\": \"1\", \"title\": \"…\", \"page\": 3}]} JSON 객체만 반환하세요. 항목은 최대 150개입니다." },
    { role: "user", content: preview },
  ]);
  // 모델이 JSON 앞뒤에 설명을 붙일 수 있으므로, 응답에서 { ... } 부분만 찾아 해석한다.
  const match = raw.match(/\{[\s\S]*\}/);
  let parsed: { offset?: unknown; items?: { level?: unknown; number?: unknown; title?: unknown; page?: unknown }[] } = {};
  try { parsed = match ? JSON.parse(match[0]) : {}; } catch { parsed = {}; }
  // 모델 출력은 그대로 믿지 않고 검사한다: 수준이 1~3이 아니거나, 제목이 비었거나, 쪽이 양의 정수가 아닌 항목은 버린다.
  // 장으로 쓸지와 쪽이 맞는지는 관리자가 화면에서 최종 판단한다.
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map((item) => ({ level: Number(item.level), number: String(item.number ?? "").trim(), title: String(item.title ?? "").trim(), page: Number(item.page) }))
    .filter((item) => [1, 2, 3].includes(item.level) && item.title && Number.isInteger(item.page) && item.page >= 1)
    .slice(0, 150);
  const offset = Number.isInteger(Number(parsed.offset)) ? Number(parsed.offset) : 0;
  return { offset, items };
}

// [색인 4단계: 핵심어] 장별 핵심어 후보(text.ts의 chapterKeywordCandidates) 중에서 장 주제에 속하는 명사만 고른다.
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
        { role: "system", content: "당신은 학교 업무 매뉴얼의 장별 핵심어 사전을 만드는 분류기입니다. 후보 낱말은 대상 장 본문에서 추출한 것입니다. 후보마다 다음 중 하나로 분류하세요.\n- \"주제\": 대상 장 제목이 가리키는 주제나 그 하위 주제에 직접 속하는 명사(복합명사 포함)\n- \"다른장\": 다른 장 제목이 가리키는 주제에 더 가까운 명사\n- \"제외\": 동사·형용사·부사, 어미나 조사가 붙은 말('휴직하였던', '위반한', '직을'), 어느 장에나 나오는 일반 행정어('사항', '경우', '규정', '소속'), 단위, 주제와 무관한 고유명사·기관명, 글자 인식 오류로 보이는 말\n예: 대상 장이 '휴직 및 복직'이면 '육아휴직', '복직원', '진단서'는 주제, '연가'는 다른장, '휴직중인', '사항'은 제외입니다.\n후보 낱말을 키로, 분류를 값으로 하는 JSON 객체만 반환하세요. 키는 후보의 글자를 그대로 씁니다." },
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

// [색인 3단계: 장 본문 / 질문 단계] 글을 "의미 벡터(임베딩)"로 바꾼다.
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

// [질문 보강] 짧은 후속 질문을 대화 기록으로 완전한 한 문장으로 고쳐 쓴다(교재 9장의 query augmentation).
//   예) 앞서 "육아휴직은 몇 년까지?"를 묻고 "그럼 분할해서 쓸 수 있어?" → "육아휴직을 분할해서 사용할 수 있는가?"
// 왜 필요한가: 벡터 검색은 질문 문장 하나만 보고 비슷한 청크를 찾는다. "그럼 기간은?"만으로는 무엇의 기간인지
//   알 수 없어 엉뚱한 청크가 나온다. 답변 생성에도 고쳐 쓴 질문을 쓰면 "그것"이 무엇인지 모델이 헤매지 않는다.
// history: 같은 사용자의 최근 질문·답변(오래된 것부터). 답변은 앞 300자만 보내 토큰을 아낀다.
// Solar는 지시문을 대화 '뒤'에 두면 질문을 고쳐 쓰는 대신 대화에 답해 버리므로, 지시문을 system에 두고
// 마지막 user 메시지에서 "답하지 말고 바꾼 질문만"을 한 번 더 못 박는다.
// 안전장치: 결과가 비었거나, 두 줄 이상이거나, 200자를 넘으면(답변을 해 버린 경우) 원문을 그대로 돌려준다.
export async function rewriteQuestion(question: string, history: { question: string; answer: string }[]) {
  if (!history.length) return question;
  const rewritten = await chat([
    { role: "system", content: "너는 검색어를 다듬는 도구다. 대화 기록을 참고하여, 사용자의 마지막 질문에서 생략된 주어·목적어와 대명사(이, 그, 저, 그럼 등)를 명확한 명사로 채운 '완전한 한 문장의 질문'으로 바꿔라. 생략된 것을 채우는 일만 하고, 원문에 있는 낱말과 묻는 내용은 바꾸지 마라(예: '계산'을 '비율'로 바꾸지 않는다). 마지막 질문이 이미 완전하거나 앞 대화와 관련이 없으면 한 글자도 바꾸지 말고 그대로 출력하라. 새로운 내용을 덧붙이지 마라." },
    ...history.flatMap((turn) => [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.answer.slice(0, 300) },
    ]),
    { role: "user", content: `다음 질문을 바꿔라. 질문에 답하지 말고 바꾼 질문 한 문장만 출력하라:\n\n${question}` },
  ]);
  const cleaned = rewritten.replace(/^["“'「]|["”'」]$/g, "").trim();
  if (!cleaned || cleaned.includes("\n") || cleaned.length > 200) return question;
  return cleaned;
}

// 답변 생성 결과. 모델이 JSON으로 돌려준 것을 풀어 쓴 모양이다.
//   - answer         : 답변 본문(사실 문장마다 [번호])
//   - usedCitations  : 모델이 인용했다고 밝힌 근거 번호 목록
//   - enoughEvidence : 근거가 질문에 답하기에 충분했는지. false면 서버(api/ask)가 답변 대신 "확인할 수 없음"으로 돌린다.
export type StructuredAnswer = { answer: string; usedCitations: number[]; enoughEvidence: boolean };

// 모델에게 요구하는 JSON 모양(OpenAI 호환 response_format). strict: 스키마에 없는 필드나 누락을 허용하지 않는다.
// 교재 8장의 with_structured_output(pydantic)과 같은 발상이다. 자유 문장 대신 정해진 칸에 채우게 하면
// 본문에서 번호를 정규식으로 긁어내는 것보다 안정적이고, "근거가 부족했는가"를 모델 판단으로 따로 받을 수 있다.
const ANSWER_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "manual_answer",
    strict: true,
    schema: {
      type: "object",
      // 순서가 중요하다. 모델은 보통 properties에 적힌 순서대로 쓰므로, enough_evidence를 맨 앞에 두면
      // 스트리밍 중 본문이 나오기 전에 "근거 부족" 여부를 먼저 알 수 있다(api/ask가 그때는 본문을 흘려보내지 않는다).
      properties: {
        enough_evidence: { type: "boolean", description: "근거가 질문의 핵심에 답하기에 충분했으면 true, 확인할 수 없다고 답했으면 false" },
        used_citations: { type: "array", items: { type: "integer" }, description: "본문에서 인용한 근거 번호 목록" },
        answer: { type: "string", description: "작성 방식대로 쓴 답변 본문. 사실 문장마다 [번호]를 붙인다." },
      },
      required: ["enough_evidence", "used_citations", "answer"],
      additionalProperties: false,
    },
  },
};

// 본문에 나온 [번호]를 중복 없이 뽑는다. 예시 답변을 JSON으로 바꿀 때와 평문 안전장치에서 쓴다.
const citationNumbers = (text: string) => [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))];

// 스트리밍 중 JSON 조각에서 answer 문자열 값만 꺼내는 도우미.
// 모델은 {"enough_evidence": true, "used_citations": [1], "answer": "○ ...\n○ ..."}를 글자 단위로 보낸다.
// "answer": " 뒤부터 닫는 따옴표 전까지가 본문이고, JSON 이스케이프(\n, \", \\, \uXXXX)를 풀어야 사람이 읽는 글이 된다.
// push(조각)을 부를 때마다 "지금까지 풀린 본문" 중 아직 돌려주지 않은 부분만 돌려준다.
// 조각이 백슬래시나 \u 중간에서 끊기면 그 자리에서 멈추고 다음 조각을 기다린다(절반만 풀린 글자가 나가지 않게).
function createAnswerExtractor() {
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" };
  let raw = "";
  let sent = 0;
  return {
    push(chunk: string) {
      raw += chunk;
      const key = raw.search(/"answer"\s*:\s*"/);
      if (key < 0) return "";
      const bodyStart = raw.indexOf('"', raw.indexOf(":", key) + 1) + 1;
      let text = "";
      for (let i = bodyStart; i < raw.length;) {
        const ch = raw[i];
        if (ch === '"') break;
        if (ch !== "\\") { text += ch; i += 1; continue; }
        const next = raw[i + 1];
        if (next === undefined) break;
        if (next === "u") {
          if (i + 6 > raw.length) break;
          text += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        text += escapes[next] ?? next;
        i += 2;
      }
      const delta = text.slice(sent);
      sent = text.length;
      return delta;
    },
    // 근거 충분 여부가 이미 나왔으면 그 값, 아직 안 나왔으면 undefined
    enoughEvidence(): boolean | undefined {
      const match = raw.match(/"enough_evidence"\s*:\s*(true|false)/);
      return match ? match[1] === "true" : undefined;
    },
  };
}

// 모델 출력(JSON 문자열)을 StructuredAnswer로 푼다.
// JSON이 아니면(모델이 형식을 어겼거나 API가 response_format을 지원하지 않아 평문이 온 경우)
// 본문 전체를 답변으로 보고 번호는 본문에서 뽑는다. 이 안전장치 덕분에 구조화 출력이 실패해도 서비스는 예전처럼 동작한다.
function parseAnswer(raw: string): StructuredAnswer {
  const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const parsed = JSON.parse(text) as { answer?: unknown; used_citations?: unknown; enough_evidence?: unknown };
    if (typeof parsed.answer === "string") {
      return {
        answer: parsed.answer.trim(),
        usedCitations: Array.isArray(parsed.used_citations) ? parsed.used_citations.filter((n): n is number => Number.isInteger(n)) : citationNumbers(parsed.answer),
        enoughEvidence: parsed.enough_evidence !== false,
      };
    }
  } catch {
    // JSON이 아니면 아래 평문 안전장치로 간다.
  }
  return { answer: raw.trim(), usedCitations: citationNumbers(raw), enoughEvidence: true };
}

// [질문 단계 마지막] 검색으로 찾은 근거(청크)만 보고 답변을 만든다. RAG의 "G(Generation)" 단계다.
// 메시지 구성:
//   1) system  : 역할·규칙(근거 안에서만 답하기, [번호] 인용, 근거 부족 시 "확인할 수 없음"), 작성 방식, JSON 출력 형식
//   2) 퓨샷 예시: answer-examples.ts의 문답을 user/assistant 쌍으로 넣는다. 답변은 같은 JSON 모양으로 바꿔 넣는다.
//                 모델은 규칙 설명보다 예시를 더 강하게 따라 하므로(예시가 평문이면 모델도 평문을 낸다), 형식을 바꿀 때는 규칙과 예시를 함께 바꿔야 한다.
//   3) user    : 실제 질문과 근거 목록. 근거마다 [1], [2]… 번호를 붙여 보내므로 답변의 [번호]가 화면의 근거 목록과 맞는다.
// 환각(hallucination)을 줄이는 장치: 근거 밖 지식 사용 금지, 없는 번호 인용 금지,
// 예시 내용을 현재 질문의 근거로 섞지 말 것을 system 규칙에 명시한다.
// manualTitle: 근거가 나온 매뉴얼 이름(예: 인사업무실무편람). 여러 매뉴얼을 다루므로 도우미 이름에 넣는다.
// options.history: 지금 사용자와 나눈 최근 문답(오래된 것부터). 퓨샷 예시 뒤, 이번 질문 앞에 실제 대화로 넣는다(멀티턴).
//   "그건 왜?", "더 쉽게 설명해 줘"처럼 앞 답변을 가리키는 질문에 답하려면 모델이 앞 답변을 봐야 한다.
//   앞 답변의 [번호]는 지난 근거를 가리키므로 떼고 보낸다. 번호가 남아 있으면 모델이 이번 근거 번호와 섞어 쓴다.
//   예시와 구분되도록 실제 대화의 질문은 '이전 질문:'으로 시작한다(system 규칙이 이 표시를 설명한다).
// options.onAnswerDelta: 주면 스트리밍으로 받는다. 본문(answer)이 풀리는 대로 조각을 넘기되, 모델이 근거 부족(enough_evidence=false)이라고
//   먼저 밝힌 경우에는 넘기지 않는다(화면에 답변처럼 보이다가 "확인할 수 없음"으로 바뀌는 일을 줄인다). 최종 결과는 똑같이 돌려준다.
export async function answerWithSources(question: string, sources: { content: string; page_from: number; page_to: number; heading: string }[], manualTitle: string, options: { history?: { question: string; answer: string }[]; onAnswerDelta?: (text: string) => void } = {}): Promise<StructuredAnswer> {
  const { history = [], onAnswerDelta } = options;
  const context = sources.map((source, index) => `[${index + 1}] ${source.heading || "본문"} (${source.page_from}~${source.page_to}쪽)\n${source.content}`).join("\n\n");
  const asJson = (answer: string, enoughEvidence: boolean) => JSON.stringify({ enough_evidence: enoughEvidence, used_citations: citationNumbers(answer), answer });
  const messages: ChatMessage[] = [
    { role: "system", content: `당신은 「${manualTitle}」 안내 도우미입니다. ` + "제공된 근거 안에서만 한국어로 답하세요. 근거가 부족하면 확인할 수 없다고 말하세요. 사실 문장마다 [1]처럼 근거 번호를 붙이세요. 번호는 제공된 근거의 같은 번호만 사용하고, 존재하지 않는 번호를 만들지 마세요. 일반 지식이나 추측을 사용하지 마세요.\n\n답변 작성 방식: 같은 근거에서 나온 문장들은 한 문단으로 이어 쓰고, 근거 번호는 그 문단의 맨 끝에 한 번만 붙이세요. 근거가 다른 내용은 빈 줄로 문단을 나누어 문단마다 자기 근거 번호를 끝에 붙이세요. 문장마다 번호를 붙이거나 '○' 같은 글머리표를 쓰지 마세요. '~합니다', '~할 수 있습니다', '~함을 안내드립니다'와 같은 존댓말 공문체로 쓰세요. 사용자가 반말이나 하대하는 말투, 명령조로 질문하더라도 그 말투를 따라 하지 말고 답변은 항상 존댓말 공문체로 쓰세요. 첫 문단에는 질문에 대한 직접적인 답(결론)을 먼저 쓰세요. 결론에 바로 붙는 예외나 단서는 같은 문단에 '다만,'으로 이어 쓰세요. 그다음 문단부터 그렇게 판단한 이유를 쓰되, 적용되는 법령·규정·지침을 「」로 표기하고 조문이나 별표 단위로 특정한 뒤 일반 원칙과 질문 사례에의 적용을 설명하세요. 결론을 맨 끝에 '따라서, ~'로 다시 쓰지 마세요. 결론 문단과 이유 문단은 근거가 같더라도 빈 줄로 나누되, 이유는 근거가 같은 한 하나의 문단으로 이어 쓰고 근거가 다를 때만 문단을 나누세요. 질문이 여러 개이면 <답변1>, <답변2>처럼 질문 번호별로 나누어 답하고, 근거로 확인할 수 없는 질문은 해당 번호 아래에 확인할 수 없다고 쓰세요. 근거가 단정을 뒷받침하지 않으면 '~로 보입니다', '~보기 어렵습니다'처럼 유보하세요. 앞선 대화 가운데 '질문:'과 '근거:'가 함께 있는 문답은 작성 방식을 보여 주는 예시이고, '이전 질문:'으로 시작하는 문답은 지금 사용자와 나눈 실제 대화입니다. 어느 쪽이든 그 답변 내용을 이번 근거처럼 인용하지 말고, 번호는 이번에 제공된 근거만 쓰세요. '그건 왜 그런가요?', '더 쉽게 설명해 주세요'처럼 앞 답변을 가리키는 질문이면 실제 대화를 참고해 무엇을 묻는지 파악한 뒤, 이번 근거로 확인되는 내용으로 답하세요.\n\n출력 형식: 반드시 JSON 객체 하나만 출력하세요. answer에는 위 작성 방식대로 쓴 답변 본문을, used_citations에는 본문에서 인용한 근거 번호 목록을, enough_evidence에는 근거가 질문의 핵심에 답하기에 충분했으면 true를, 핵심을 확인할 수 없다고 답했으면 false를 넣으세요." },
    ...ANSWER_EXAMPLES.flatMap((example) => [
      { role: "user" as const, content: `질문: ${example.question}\n\n근거:\n${example.sources}` },
      // 예시 답변은 옛 형식(법령→결론 순서, 문장마다 번호)으로 적혀 있어 결론을 앞으로 옮기고 근거별 문단으로 바꿔 보낸다(answer-format.ts).
      // 예시 답변에 "확인할 수 없습니다"가 들어 있으면 근거 부족 예시로 본다.
      { role: "assistant" as const, content: asJson(groupByCitation(conclusionFirst(example.answer)), !example.answer.includes("확인할 수 없습니다")) },
    ]),
    // 실제 대화(멀티턴 맥락). 답변은 [번호]를 뗀 채 예시와 같은 JSON 모양으로 넣는다.
    ...history.flatMap((turn) => [
      { role: "user" as const, content: `이전 질문: ${turn.question}` },
      { role: "assistant" as const, content: asJson(turn.answer.replace(/\s*\[\d+\]/g, ""), true) },
    ]),
    { role: "user", content: `질문: ${question}\n\n근거:\n${context}` },
  ];
  if (!onAnswerDelta) return parseAnswer(await chat(messages, ANSWER_SCHEMA));
  const extractor = createAnswerExtractor();
  const raw = await chatStream(messages, ANSWER_SCHEMA, (chunk) => {
    const delta = extractor.push(chunk);
    if (delta && extractor.enoughEvidence() !== false) onAnswerDelta(delta);
  });
  return parseAnswer(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// [문제 풀기] 근거 원문으로 O/X·4지선다 문제를 만든다(2026-11-08).
//
// 설계 원칙 — 답변과 같다. 문제·정답·해설은 제공한 원문에 있는 내용으로만 만든다.
//   모델이 편람에 없는 보기나 "상식"을 섞어 넣을 수 있으므로, 문제마다 근거 문장(evidence)을 원문에서
//   "글자 그대로" 옮겨 적게 하고, 부르는 쪽(api/quiz)이 그 문장이 실제 원문에 있는지 검사해 없으면 그 문제를 버린다.
//   핵심어 사전을 만들 때 "후보에 없는 낱말은 못 들어온다"고 한 것과 같은 장치다.
// "최근 문답" 출제(사용자 요청 2026-11-08) — 두 단계로 나눈다.
//   ① describeConsultations : 상담(질문·답변)에서 "상황"(누가 어떤 처지에서 무엇을 하려는지)과 "이미 물은 쟁점"을 뽑는다.
//   ② generateQuiz          : 상황은 문제의 소재로 가져오되, 이미 물은 쟁점은 피하고 같은 상황의 다른 쟁점을 묻는다.
//   한 번에 시키면 모델이 상담 질문의 쟁점(예: 복직 서류)을 그대로 되묻는 일이 잦았다(실측). 상황과 피할 쟁점을 글로 먼저
//   적게 하고 그것을 지시문에 박아 넣으면 훨씬 잘 지킨다. 부르는 쪽은 ①의 상황 문장으로 원문을 검색하므로
//   (상담 질문으로 검색하면 이미 물은 쟁점의 원문만 모인다) 다른 쟁점을 낼 재료도 함께 확보된다.
// 형식은 JSON 스키마로 고정한다(answerWithSources와 같은 방식). 보기 수(4개), 정답 표기('O'/'X', '1'~'4')가 어긋나면 버린다.
export type GeneratedQuestion = { kind: "ox" | "choice"; prompt: string; choices: string[]; answer: string; explanation: string; source: number; evidence: string };
export type Consultation = { question: string; answer: string };
// 상담 하나에서 뽑은 출제 소재. situation은 검색 문장과 문제 소재로, askedIssue는 "묻지 말 것"으로 쓴다.
export type Scenario = { situation: string; askedIssue: string };

const SCENARIO_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "consultation_scenarios",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scenarios: {
          type: "array",
          items: {
            type: "object",
            properties: {
              situation: { type: "string", description: "상담의 상황을 한 문장으로. 누가(예: 육아휴직 중인 교사) 어떤 처지에서 무엇을 하려는지(예: 복직하려 함). 질문의 쟁점은 넣지 않는다" },
              asked_issue: { type: "string", description: "상담에서 이미 물은 쟁점을 명사구로(예: 복직에 필요한 서류)" },
            },
            required: ["situation", "asked_issue"],
            additionalProperties: false,
          },
        },
      },
      required: ["scenarios"],
      additionalProperties: false,
    },
  },
};

export async function describeConsultations(consultations: Consultation[]): Promise<Scenario[]> {
  const raw = await chat([
    { role: "system", content: "당신은 교육공무원 인사 상담 기록을 읽고, 상담마다 '상황'과 '이미 물은 쟁점'을 나누어 적는 분석기입니다. 상황에는 쟁점을 섞지 않습니다. 예: 질문 '육아휴직에서 복직하려면 어떤 서류가 필요한가요?' → situation '육아휴직 중인 교사가 복직하려는 상황', asked_issue '복직에 필요한 서류'. 상담 순서대로 같은 개수의 항목을 반환합니다." },
    { role: "user", content: consultations.map((item, index) => `(${index + 1}) 질문: ${item.question}\n    답변: ${item.answer}`).join("\n") },
  ], SCENARIO_SCHEMA);
  const match = raw.match(/\{[\s\S]*\}/);
  let parsed: { scenarios?: { situation?: unknown; asked_issue?: unknown }[] } = {};
  try { parsed = match ? JSON.parse(match[0]) : {}; } catch { parsed = {}; }
  const scenarios = (Array.isArray(parsed.scenarios) ? parsed.scenarios : [])
    .map((item) => ({ situation: String(item.situation ?? "").trim(), askedIssue: String(item.asked_issue ?? "").trim() }))
    .filter((item) => item.situation);
  // 모델이 비우거나 실패하면 상담 질문 자체를 상황으로 쓴다(검색은 되고, 피할 쟁점만 비는 안전장치).
  return scenarios.length ? scenarios : consultations.map((item) => ({ situation: item.question, askedIssue: "" }));
}

const QUIZ_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "manual_quiz",
    strict: true,
    schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["ox", "choice"], description: "ox: O/X 문제, choice: 4지선다" },
              prompt: { type: "string", description: "문항. O/X는 참·거짓을 판단할 서술문, 4지선다는 질문문" },
              choices: { type: "array", items: { type: "string" }, description: "4지선다 보기 4개(번호 없이 내용만). O/X는 빈 배열" },
              answer: { type: "string", enum: ["O", "X", "1", "2", "3", "4"], description: "정답. O/X 문제는 O 또는 X, 4지선다는 정답 보기의 번호" },
              explanation: { type: "string", description: "해설 한두 문장. 근거 원문의 내용으로만 쓴다" },
              source: { type: "integer", description: "문제를 만든 근거의 번호([1]부터)" },
              evidence: { type: "string", description: "정답의 근거가 되는 문장을 해당 근거 원문에서 글자 그대로 옮긴 것(고치거나 줄이지 않는다)" },
            },
            required: ["kind", "prompt", "choices", "answer", "explanation", "source", "evidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
};

export async function generateQuiz(sources: { heading: string; content: string }[], manualTitle: string, count: number, scenarios: Scenario[] = []): Promise<GeneratedQuestion[]> {
  const evidence = sources.map((source, index) => `[${index + 1}] ${source.heading ? `(${source.heading}) ` : ""}${source.content}`).join("\n\n");
  const commonRules = `- 문제 ${count}개를 만듭니다. O/X와 4지선다를 섞되 4지선다를 더 많이 냅니다.\n- 문제·보기·정답·해설은 모두 근거 원문에 있는 내용으로만 만듭니다. 원문에 없는 숫자·기간·조건·기관을 지어내지 않습니다.\n- 4지선다 오답 보기는 원문의 다른 내용이나 원문과 어긋나는 내용으로 만들고, 정답은 문제마다 고르게 다른 번호에 둡니다.\n- O/X 문제는 원문 내용을 그대로 서술하거나(정답 O) 숫자·조건 하나를 바꿔 서술합니다(정답 X).\n- evidence에는 정답의 근거가 되는 문장을 해당 근거 원문에서 글자 그대로 복사합니다. 요약하거나 고치지 않습니다.\n- 문항과 해설은 존댓말로, 표의 칸이나 쪽 번호 같은 형식 요소를 묻지 않고 실무 지식을 묻습니다.`;
  // 상담 소재가 있을 때만 붙는 규칙. 상황은 가져오고, 이미 물은 쟁점은 피한다.
  const scenarioRules = scenarios.length
    ? `\n- 아래 "출제 소재"의 상황을 문제의 배경으로 삼아 "~하려는 교사가 있습니다. 이때 …" 같은 사례형 문항으로 만듭니다.\n- 각 소재의 "묻지 말 것"에 적힌 쟁점은 문항·보기 어디에도 넣지 않습니다. 대신 같은 상황에서 생기는 다른 쟁점(시기·기간 산정, 경력·호봉 인정, 신청 시한, 요건과 제한, 승인 절차 등)을 근거 원문에서 찾아 묻습니다. 근거 원문에 그런 다른 쟁점이 없으면 상황만 비슷한 다른 사례를 원문에서 골라 묻습니다.`
    : "";
  const scenarioText = scenarios.length
    ? `\n\n출제 소재:\n${scenarios.map((item, index) => `(${index + 1}) 상황: ${item.situation}${item.askedIssue ? `\n    묻지 말 것: ${item.askedIssue}` : ""}`).join("\n")}`
    : "";
  const raw = await chat([
    { role: "system", content: `당신은 「${manualTitle}」로 교육공무원 인사 실무를 공부하는 교사를 위해 확인 문제를 내는 출제자입니다. 제공된 근거 원문만으로 문제를 만듭니다.\n\n규칙\n${commonRules}${scenarioRules}` },
    { role: "user", content: `근거 원문:\n${evidence}${scenarioText}` },
  ], QUIZ_SCHEMA);
  const match = raw.match(/\{[\s\S]*\}/);
  let parsed: { questions?: Partial<GeneratedQuestion>[] } = {};
  try { parsed = match ? JSON.parse(match[0]) : {}; } catch { parsed = {}; }
  // 모델 출력은 그대로 믿지 않고 모양을 검사한다. 근거 번호 범위, 보기 수, 정답 표기가 맞는 문제만 남긴다.
  return (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((item) => ({
      kind: item.kind === "ox" ? "ox" as const : "choice" as const,
      prompt: String(item.prompt ?? "").trim(),
      choices: Array.isArray(item.choices) ? item.choices.map((choice) => String(choice).trim()) : [],
      answer: String(item.answer ?? "").trim(),
      explanation: String(item.explanation ?? "").trim(),
      source: Number(item.source),
      evidence: String(item.evidence ?? "").trim(),
    }))
    .filter((item) => item.prompt && item.explanation && item.evidence && Number.isInteger(item.source) && item.source >= 1 && item.source <= sources.length)
    .filter((item) => (item.kind === "ox" ? ["O", "X"].includes(item.answer) : item.choices.length === 4 && item.choices.every(Boolean) && ["1", "2", "3", "4"].includes(item.answer)))
    .map((item) => (item.kind === "ox" ? { ...item, choices: [] } : item))
    .slice(0, count);
}
