export type ParsedPage = { page: number; text: string };
export type ChapterHeading = { title: string; chapterNumber: string; pageFrom: number };

const baseUrl = "https://api.upstage.ai/v1";

function apiKey() {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new Error("UPSTAGE_API_KEY 환경 변수가 없습니다.");
  return key;
}

function textFromHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function elementText(element: Record<string, unknown>) {
  const content = element.content as Record<string, unknown> | undefined;
  const value = content?.markdown ?? content?.text ?? content?.html ?? element.text;
  if (typeof value !== "string") return "";
  return value.includes("<") ? textFromHtml(value) : value.trim();
}

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

async function chat(messages: { role: "system" | "user"; content: string }[]) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.UPSTAGE_CHAT_MODEL ?? "solar-pro2", temperature: 0.1, messages }),
  });
  if (!response.ok) throw new Error(`Upstage 답변 생성 실패: ${await response.text()}`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function detectChapterHeadings(pages: ParsedPage[], totalPages: number): Promise<ChapterHeading[]> {
  const preview = pages.slice(0, 15).map((page) => `[${page.page}쪽]\n${page.text.slice(0, 2200)}`).join("\n\n");
  const raw = await chat([
    { role: "system", content: "당신은 PDF 목차 분석기입니다. 제공된 문서 앞부분의 목차에서 최상위 '제 N 장'만 찾으세요. 하위 번호(1., 2., 3. 등)는 절대로 반환하지 마세요. chapterNumber마다 정확히 한 항목만 반환합니다. 목차가 두 칼럼으로 추출되어 장 제목이 여러 줄에 흩어질 수 있습니다. 예를 들어 '제 1 장', '교육법과 2. ...', '교원 정원 3. ...'이면 title은 '교육법과 교원 정원'입니다. pageFrom은 해당 장의 첫 하위 항목에 적힌 실제 PDF 시작 쪽입니다. JSON 배열만 반환하세요. 각 항목은 title, chapterNumber, pageFrom만 가지며, title에는 제N장 표기를 넣지 않습니다." },
    { role: "user", content: preview },
  ]);
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

export async function embed(texts: string[], model: string) {
  const requestBatch = async (input: string[]): Promise<number[][]> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input }),
      });
      if (response.ok) {
        const payload = await response.json() as { data?: { index: number; embedding: number[] }[] };
        return (payload.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
      }
      const error = await response.text();
      if (response.status === 400 && error.includes("maximum context length") && input.length > 1) {
        const middle = Math.ceil(input.length / 2);
        return [...await requestBatch(input.slice(0, middle)), ...await requestBatch(input.slice(middle))];
      }
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
  if (vectors.length !== texts.length) throw new Error("임베딩 결과 수가 청크 수와 다릅니다.");
  return vectors;
}

export async function answerWithSources(question: string, sources: { content: string; page_from: number; page_to: number; heading: string }[]) {
  const context = sources.map((source, index) => `[${index + 1}] ${source.heading || "본문"} (${source.page_from}~${source.page_to}쪽)\n${source.content}`).join("\n\n");
  return chat([
    { role: "system", content: "당신은 교육공무원 인사실무편람 안내 도우미입니다. 제공된 근거 안에서만 한국어로 답하세요. 근거가 부족하면 확인할 수 없다고 말하세요. 사실 문장마다 [1]처럼 근거 번호를 붙이세요. 번호는 제공된 근거의 같은 번호만 사용하고, 존재하지 않는 번호를 만들지 마세요. 일반 지식이나 추측을 사용하지 마세요." },
    { role: "user", content: `질문: ${question}\n\n근거:\n${context}` },
  ]);
}
