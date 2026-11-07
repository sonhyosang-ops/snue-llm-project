// ─────────────────────────────────────────────────────────────────────────────
// answer-format.ts — 답변을 "근거별 문단"으로 묶는다
//
// 배경(2026-11-08): 문장마다 [1]이 붙은 "○ " 항목 나열은 공문으로는 익숙하지만 챗봇 답변으로는 읽기에 피로하다.
// 그래서 같은 근거에서 나온 문장들은 한 문단으로 이어 쓰고, 근거 번호는 문단 끝에 한 번만 붙이기로 했다.
// 근거가 다른 내용은 빈 줄로 문단을 나눈다.
//
// 이 함수는 두 곳에서 쓴다.
//   1) 퓨샷 예시(answer-examples.ts)를 모델에 보낼 때: 예시는 옛 형식(문장마다 번호)으로 적혀 있으므로 보내기 전에 변환한다.
//      모델은 규칙보다 예시를 따르므로, 예시를 새 형식으로 보여 줘야 새 형식으로 답한다.
//   2) 모델이 만든 답변에 한 번 더(api/ask): 모델이 규칙을 어기고 문장마다 번호를 붙여도 화면에는 묶인 모양으로 나간다.
//
// 묶는 규칙
//   - 줄 단위로 본다. 줄 앞의 글머리표("○ ", "• ", "- ")와 줄 안의 [번호]는 떼고 문장만 남긴다.
//   - 바로 앞 문단과 근거 번호 집합이 같으면(또는 이 줄에 번호가 없으면) 앞 문단에 이어 붙인다. 다르면 새 문단을 연다.
//   - 앞 문단에 아직 번호가 없고 이 줄에 번호가 있으면, 이 줄의 번호를 그 문단의 번호로 삼는다.
//   - "<답변1>"처럼 질문이 여러 개일 때의 머리말 줄은 그대로 한 줄로 두고, 그 뒤 문장은 새 문단에서 시작한다.
//   - 문단 끝에 " [1]" 또는 " [1][2]"를 붙인다. 번호가 없는 문단은 번호 없이 둔다.
// ─────────────────────────────────────────────────────────────────────────────

type Paragraph = { sentences: string[]; citations: number[]; heading: boolean };

const sameCitations = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export function groupByCitation(answer: string) {
  const paragraphs: Paragraph[] = [];
  // 빈 줄은 "여기서 문단을 나눈다"는 뜻이지만, 한 답변(머리말 단위) 안에서 첫 문단(결론) 뒤 한 번만 존중한다.
  // 결론 문단과 이유 문단이 같은 근거여도 하나로 합쳐지지 않게 하되, 모델이 이유를 문장마다 빈 줄로 쪼개 보내도
  // 이유는 근거가 같은 한 한 문단으로 묶이게 하기 위해서다.
  let breakBefore = false;
  let sectionParagraphs = 0;
  for (const rawLine of answer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { breakBefore = sectionParagraphs === 1; continue; }
    // "<답변1>", "<답변2~3>"처럼 번호나 범위가 든 머리말. 머리말 뒤에 문장이 같은 줄에 이어지면 머리말만 떼어 한 줄로 두고 문장은 새 문단에서 시작한다.
    const heading = line.match(/^(<답변[\d~\-,·]+>)\s*(.*)$/);
    if (heading) {
      paragraphs.push({ sentences: [heading[1]], citations: [], heading: true });
      sectionParagraphs = 0;
      breakBefore = false;
      if (!heading[2]) continue;
    }
    const body = heading ? heading[2] : line;
    const citations = [...new Set([...body.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    const sentence = body.replace(/^[○•\-·]\s*/, "").replace(/\s*\[\d+\]/g, "").replace(/\s{2,}/g, " ").trim();
    if (!sentence) continue;
    const last = paragraphs[paragraphs.length - 1];
    const continues = !breakBefore && last && !last.heading && (citations.length === 0 || last.citations.length === 0 || sameCitations(last.citations, citations));
    breakBefore = false;
    if (continues) {
      last.sentences.push(sentence);
      if (!last.citations.length) last.citations = citations;
    } else {
      paragraphs.push({ sentences: [sentence], citations, heading: false });
      sectionParagraphs += 1;
    }
  }
  return paragraphs
    .map((paragraph) => (paragraph.heading ? paragraph.sentences[0] : paragraph.sentences.join(" ") + (paragraph.citations.length ? ` ${paragraph.citations.map((n) => `[${n}]`).join("")}` : "")))
    .join("\n\n");
}

// 결론을 맨 앞으로 옮긴다(2026-11-08). 챗봇 답변은 "질문에 대한 직접 답변 → 그렇게 판단한 이유" 순서가 읽기 좋다.
// 퓨샷 예시(answer-examples.ts)는 공문 관행대로 "법령·원칙 → 사례 적용 → '따라서, ~' 결론" 순서로 적혀 있으므로,
// 보내기 전에 이 함수로 순서를 바꿔 모델이 결론 먼저 쓰는 모양을 보고 배우게 한다. 모델 출력에는 적용하지 않는다.
//   - '따라서, ~'로 시작하는 첫 줄이 결론이다. '따라서, '는 떼고 맨 앞에 둔다.
//   - 결론 바로 뒤에 이어지는 '다만, ~' 줄은 결론에 딸린 단서이므로 함께 앞으로 옮긴다.
//   - 옮긴 결론 뒤에 빈 줄을 두어 groupByCitation이 결론 문단과 이유 문단을 합치지 않게 한다.
//   - "<답변1>"처럼 질문이 여러 개인 답변은 머리말 단위로 나누어 각각 적용한다.
//   - 결론 줄이 없으면 그대로 둔다.
export function conclusionFirst(answer: string) {
  const lines = answer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sections: string[][] = [];
  for (const line of lines) {
    if (/^<답변[\d~\-,·]+>/.test(line) || !sections.length) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  const bullet = /^[○•\-·]\s*/;
  return sections.map((section) => {
    const heading = /^<답변[\d~\-,·]+>/.test(section[0]) ? section.shift()! : "";
    const start = section.findIndex((line) => /^따라서[,，]?\s*/.test(line.replace(bullet, "")));
    if (start < 0) return [heading, ...section].filter(Boolean).join("\n");
    let end = start + 1;
    while (end < section.length && /^다만[,，]?\s*/.test(section[end].replace(bullet, ""))) end += 1;
    const conclusion = section.slice(start, end).map((line, index) => (index === 0 ? line.replace(bullet, "").replace(/^따라서[,，]?\s*/, "") : line.replace(bullet, "")));
    const rest = [...section.slice(0, start), ...section.slice(end)];
    return [heading, ...conclusion, "", ...rest].filter((line, index) => line || index > 0).join("\n");
  }).join("\n\n");
}
