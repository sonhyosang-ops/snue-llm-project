// ─────────────────────────────────────────────────────────────────────────────
// text.ts — 글자 처리 도구 모음 (RAG 파이프라인의 "전처리" 단계)
//
// 외부 API를 부르지 않는 순수 함수만 모아 두었다. 같은 입력이면 언제나 같은 결과가 나오므로
// 테스트하기 쉽고, 문서 색인(ingest)과 질문 처리(ask) 양쪽에서 함께 쓴다.
//
//   1) normalizeTerm / tokens   : 문장을 검색용 낱말로 자른다.
//   2) questionKeywords         : 사용자 질문에서 핵심어 1~2개를 뽑는다.
//   3) chapterKeywordCandidates : 장별 핵심어 사전의 "후보"를 TF-IDF 점수로 뽑는다.
//   4) chunkPages               : PDF 쪽 본문을 검색 단위(청크)로 자른다.
//   5) cleanChunk               : 검색된 청크의 잡음을 빼고 표를 다듬는다(답변 생성·근거 표시용).
//
// 참고: 핵심어 사전은 답변의 근거가 아니라 "질문이 어느 장에 속하는지" 판단하는 길잡이다.
//       실제 답변 근거는 임베딩(의미 벡터) 검색으로 찾는다(src/app/api/ask/route.ts 참고).
// ─────────────────────────────────────────────────────────────────────────────

// 불용어(stopword): 너무 흔해서 어느 장을 가리키는지 구분하는 데 도움이 되지 않는 낱말.
// 예) "교육", "교원"은 편람의 모든 장에 나오므로 핵심어로 남기면 어떤 질문이든 모든 장에 걸린다.
//     "있나요", "주세요"처럼 질문 문장에만 나오는 말도 함께 뺀다.
const STOPWORDS = new Set(["교육", "교원", "공무원", "업무", "관련", "경우", "내용", "대해", "대한", "어떤", "무엇", "방법", "기준", "질문", "문의", "확인", "가능", "여부", "하는", "있나요", "주세요", "입니다"]);
// 낱말 끝에 붙는 조사 목록. 반드시 긴 조사를 먼저 둔다.
// 예) "기간으로"에서 "로"를 먼저 떼면 "기간으"가 남지만, "으로"를 먼저 검사하면 "기간"이 된다.
const PARTICLES = ["으로", "에서", "에게", "까지", "부터", "처럼", "보다", "에는", "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "만", "로"];
// 숫자와 함께 쓰이는 단위 낱말. 숫자가 붙은 어절("3개월")은 tokens()에서 통째로 버려지지만,
// 띄어 쓴 경우("3 개월간")에는 "개월간"만 남으므로 여기서 한 번 더 걸러 낸다.
const UNITS = new Set(["개월", "개월간", "시간", "퍼센트", "천원", "만원", "억원", "년도", "학년도", "주년", "개년"]);

// 낱말 하나를 비교하기 좋은 형태로 바꾼다: 앞뒤 공백 제거 → 소문자 변환 → 끝에 붙은 조사 하나 떼기.
// 조사를 뗀 뒤에도 2글자 이상 남을 때만 뗀다(term.length > particle.length + 1).
// 예) "휴가"의 끝 글자 "가"는 조사처럼 보이지만, 떼면 "휴" 한 글자만 남으므로 그대로 둔다.
// 형태소 분석기 없이 쓰는 간단한 규칙이라 어미("휴직하였던")는 떼지 못한다.
// 그런 말은 핵심어 사전을 만들 때 selectTopicTerms(upstage.ts)가 "제외"로 걸러 낸다.
export function normalizeTerm(value: string) {
  let term = value.trim().toLowerCase();
  for (const particle of PARTICLES) {
    if (term.endsWith(particle) && term.length > particle.length + 1) return term.slice(0, -particle.length);
  }
  return term;
}

// 문장을 검색용 낱말 목록으로 자른다. 처리 순서:
//   ① 띄어쓰기·문장부호를 경계로 한글·영문·숫자 2글자 이상 덩어리(어절)를 잘라 낸다.
//   ② 한글로만 된 어절만 남긴다.
//   ③ 조사를 떼고(normalizeTerm), 1글자 낱말·불용어·단위를 뺀다.
// 같은 낱말이 여러 번 나오면 그대로 여러 번 들어간다(빈도 계산에 쓰기 때문).
export function tokens(text: string) {
  // ②에서 영어나 숫자가 섞인 어절("제3호에", "2026학년도")은 조각내지 않고 통째로 버린다.
  // 처음부터 한글만 골라내는 정규식([가-힣]+)을 쓰면 "제3호에"가 "호에" 같은 의미 없는 조각으로 남기 때문이다.
  // PDF 파싱 과정에서 그림·화면 캡처를 설명하려고 들어간 영어 문장도 여기서 모두 걸러진다.
  return text.match(/[가-힣A-Za-z0-9]{2,}/g)?.filter((word) => /^[가-힣]+$/.test(word)).map(normalizeTerm).filter((term) => term.length > 1 && !STOPWORDS.has(term) && !UNITS.has(term)) ?? [];
}

// 사용자 질문에서 핵심어를 최대 2개 뽑는다.
// 질문 안에서 많이 나온 낱말을 먼저, 횟수가 같으면 더 긴 낱말을 먼저 고른다.
// 긴 낱말(대개 "육아휴직", "호봉획정" 같은 복합명사)이 짧은 낱말보다 주제를 더 구체적으로 가리키기 때문이다.
// 뽑은 핵심어는 장 안내 판단(api/ask/route.ts의 matchingRows)과 화면의 "핵심어" 표시에 쓰인다.
// 질문을 이 핵심어로 줄여서 검색하지는 않는다. 임베딩 검색에는 질문 문장 전체를 쓴다.
export function questionKeywords(question: string) {
  const frequency = new Map<string, number>();
  for (const term of tokens(question)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return [...frequency.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 2).map(([term]) => term);
}

// 한 장의 핵심어 사전 "후보"를 TF-IDF 점수로 뽑는다.
//   - chapterTexts    : 대상 장의 청크 본문 목록
//   - allChapterTexts : 문서 전체의 장별 청크 본문 목록(대상 장 포함). IDF 계산에 쓴다.
//
// TF-IDF는 "이 장에서는 자주 나오지만 다른 장에서는 드문 낱말"에 높은 점수를 주는 방법이다.
//   - TF(term frequency)   : 대상 장 안에서 낱말이 나온 횟수(frequency)
//   - DF(document frequency): 그 낱말이 나온 장의 수(documentFrequency)
//   - score = TF × log((전체 장 수 + 1) / (DF + 1) + 1)
//     분모·분자의 +1은 0으로 나누는 것을 막는 보정이고, log 안의 마지막 +1 덕분에
//     모든 장에 나오는 낱말도 점수가 0이 되지 않는다(아주 작아질 뿐이다).
//
// 상위 300개는 아직 "후보"다. 동사 활용형, 어느 장에나 나오는 일반어, 다른 장의 주제어가 섞여 있으므로
// upstage.ts의 selectTopicTerms가 이 중에서 장 주제에 속하는 명사만 다시 고른다.
// 반환값의 frequency와 score는 그대로 chapter_keywords 테이블에 저장된다.
export function chapterKeywordCandidates(chapterTexts: string[], allChapterTexts: string[][]) {
  const frequency = new Map<string, number>();
  for (const term of tokens(chapterTexts.join(" "))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  // DF는 "몇 번 나왔나"가 아니라 "몇 개 장에 나왔나"이므로, 장마다 new Set으로 중복을 없앤 뒤 센다.
  const documentFrequency = new Map<string, number>();
  for (const texts of allChapterTexts) for (const term of new Set(tokens(texts.join(" ")))) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return [...frequency.entries()]
    .map(([term, count]) => ({ term, frequency: count, score: Number((count * Math.log((allChapterTexts.length + 1) / ((documentFrequency.get(term) ?? 0) + 1) + 1)).toFixed(4)) }))
    .sort((a, b) => b.score - a.score || b.frequency - a.frequency)
    .slice(0, 300);
}

// PDF의 쪽별 본문을 검색 단위인 "청크(chunk)"로 자른다.
//
// 왜 자르나: 임베딩 모델은 한 번에 받을 수 있는 글자 수에 한계가 있고, 긴 글을 통째로 벡터 하나로 만들면
// 여러 주제가 섞여 질문과 정확히 맞는 부분을 찾기 어렵다. 적당한 크기로 잘라야 검색이 정확해진다.
//
//   - target = 1200 : 청크 하나의 목표 글자 수. 너무 길면 주제가 섞이고, 너무 짧으면 문맥이 끊긴다.
//   - overlap = 180 : 새 청크를 시작할 때 직전 청크의 끝 180자를 앞에 다시 붙인다.
//                     문장이 청크 경계에서 잘려도 앞뒤 문맥이 양쪽 청크에 남아 검색에서 놓치지 않는다.
//   - 80자 미만 조각(쪽 번호, 머리말 등)은 저장하지 않는다.
//
// 반환하는 pageFrom·pageTo는 청크가 걸친 쪽 범위로, 화면의 "확인한 근거 ○~○쪽" 표시에 쓰인다.
export function chunkPages(pages: { page: number; text: string }[], target = 1200, overlap = 180) {
  const chunks: { content: string; pageFrom: number; pageTo: number }[] = [];
  let content = "";
  let pageFrom = pages[0]?.page ?? 1;
  let pageTo = pageFrom;
  // 지금까지 모은 content를 청크 하나로 저장한다. 너무 짧은 조각은 버린다.
  const save = () => { if (content.trim().length >= 80) chunks.push({ content: content.trim(), pageFrom, pageTo }); };
  for (const page of pages) {
    let remaining = page.text.trim();
    // 한 쪽이 target보다 길 수 있으므로, 쪽 본문을 target 이하 조각으로 나눠 가며 처리한다.
    while (remaining) {
      let end = Math.min(remaining.length, target);
      if (end < remaining.length) {
        // 낱말 중간에서 자르지 않도록 target 직전의 띄어쓰기에서 자른다.
        // 다만 띄어쓰기가 target의 절반보다 앞에 있으면 조각이 너무 짧아지므로 그냥 target에서 자른다.
        const breakAt = remaining.lastIndexOf(" ", end);
        if (breakAt > target / 2) end = breakAt;
      }
      const text = remaining.slice(0, end).trim();
      remaining = remaining.slice(end).trim();
      if (!text) continue;
      if (content && content.length + text.length > target) {
        // 이 조각을 더하면 target을 넘으므로, 지금까지 모은 내용을 청크로 저장하고
        // 직전 청크의 끝 overlap 글자를 새 청크의 시작으로 삼는다.
        save();
        content = content.slice(-overlap).trim();
        // 겹친 부분이 앞 쪽에서 왔더라도 새 청크의 시작 쪽은 현재 쪽으로 잡는다(쪽 표시는 근사치다).
        pageFrom = page.page;
      }
      content += `${content ? "\n\n" : ""}${text}`;
      pageTo = page.page;
    }
  }
  // 마지막에 남은 내용도 청크로 저장한다.
  save();
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 근거 정리 — 검색된 청크를 "사람이 읽고, 모델에 보내기 좋은" 모양으로 다듬는다.
//
// PDF 파싱 결과에는 검색에는 큰 해가 없지만 읽기에는 방해가 되는 잡음이 섞여 있다.
//   - "$$ … $$"가 들어간 줄 : 계산식 그림을 수식으로 잘못 인식한 LaTeX 기호
//   - 한글 없이 영어 낱말만 이어진 줄 : 그림·화면 캡처를 설명하려고 파서가 덧붙인 영어 문장
//   - 숫자만 있는 줄 : 쪽 번호
// 또 일부 표는 파싱 때 줄바꿈이 사라져 "| a | b | | --- | --- | | x | y |"처럼 한 줄로 뭉개져 저장되어 있다.
//
// cleanChunk는 잡음 줄을 빼고, 뭉개진 표를 다시 여러 줄의 마크다운 표로 펼친다. 글머리표("- ")와 제목("# ")은 그대로 둔다.
// 이렇게 정리한 글을 ① 답변 생성 모델에 보내고(토큰 절약) ② 화면의 "확인한 근거"에 마크다운으로 그린다(표는 표로).
// DB에 저장된 청크와 임베딩은 바꾸지 않는다. 그래서 검색 결과는 그대로이고 다시 색인할 필요가 없다.
// ─────────────────────────────────────────────────────────────────────────────

// 마크다운 표의 구분 줄. 예) "| --- | :---: |"
const SEPARATOR_ROW = /^\|(\s*:?-{3,}:?\s*\|)+$/;

// 줄이 마크다운 표의 한 행인지("|"로 시작하고 "|"로 끝나는지) 확인한다.
function isTableRow(line: string | undefined) {
  const trimmed = line?.trim() ?? "";
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

// 한 줄로 뭉개진 표를 여러 줄로 펼친다. 뭉개진 표가 아니면 그 줄을 그대로 돌려준다.
// 원리: 뭉개진 표는 행과 행 사이가 "| |"로 붙어 있다. "|"로 자르면 [칸1, 칸2, …, 칸n, 빈칸(행 경계), 칸1, …] 순서가 되므로,
//       구분 줄("| --- | --- |")에서 열 수 n을 알아낸 뒤 n+1개씩 묶으면 원래 행을 되찾을 수 있다.
//       묶음의 마지막(행 경계) 자리에 글자가 있으면 이 규칙에 맞지 않는 줄이므로 손대지 않는다.
function expandFlatTable(line: string): string[] {
  const trimmed = line.trim();
  const separator = trimmed.match(/\|(\s*:?-{3,}:?\s*\|)+/);
  if (!trimmed.startsWith("|") || !separator || separator[0] === trimmed) return [line];
  const columns = separator[0].split("|").length - 2;
  const tokens = trimmed.split("|").slice(1);
  const rows: string[] = [];
  for (let index = 0; index < tokens.length; index += columns + 1) {
    const cells = tokens.slice(index, index + columns);
    const boundary = tokens[index + columns];
    if (boundary !== undefined && boundary.trim()) return [line];
    // 맨 끝의 빈 조각(마지막 "|" 뒤)처럼 칸이 모두 비어 있는 묶음은 행이 아니므로 버린다.
    if (cells.every((cell) => !cell.trim())) continue;
    rows.push(`| ${cells.map((cell) => cell.trim()).join(" | ")} |`);
  }
  return rows;
}

// 표의 앞뒤를 마크다운 표 규칙에 맞게 다듬는다.
//   - 마크다운 표로 그려지려면 "머리글 행 + 구분 줄"로 시작해야 한다. 그런데 청크는 1,200자 단위로 잘리므로
//     표의 중간부터 시작하는 청크가 많다(머리글은 앞 청크에 있음). 그런 표 앞에는 빈 머리글 행과 구분 줄을 넣는다.
//   - 문단 바로 뒤에 붙은 표는 표로 인식되지 않을 수 있어, 모든 표 앞에 빈 줄을 넣는다.
//   - 표 바로 뒤에 빈 줄 없이 문단이 이어지면 그 문단이 표의 한 행으로 빨려 들어가므로, 표 뒤에도 빈 줄을 넣는다.
function formatTables(lines: string[]) {
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const startsTable = isTableRow(lines[index]) && !isTableRow(lines[index - 1]);
    if (startsTable) {
      output.push("");
      if (!SEPARATOR_ROW.test((lines[index + 1] ?? "").trim())) {
        const columns = lines[index].trim().split("|").length - 2;
        output.push(`|${" |".repeat(columns)}`, `|${" --- |".repeat(columns)}`);
      }
    }
    output.push(lines[index]);
    const next = lines[index + 1];
    if (isTableRow(lines[index]) && next !== undefined && next.trim() && !isTableRow(next)) output.push("");
  }
  return output;
}

export function cleanChunk(text: string) {
  const lines = text
    .split("\n")
    .filter((line) => !line.includes("$$"))
    .filter((line) => !/^\s*\d{1,4}\s*$/.test(line))
    // 한글이 하나도 없고 영어 낱말이 3개 이상 이어진 줄 = 파서가 덧붙인 그림 설명. 표의 숫자 행이나 "NEIS" 같은 낱말은 남는다.
    .filter((line) => /[가-힣]/.test(line) || !/[A-Za-z]{2,}(\W+[A-Za-z]{2,}){2,}/.test(line))
    .flatMap(expandFlatTable);
  return formatTables(lines).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
