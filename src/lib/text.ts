const STOPWORDS = new Set(["교육", "교원", "공무원", "업무", "관련", "경우", "내용", "대해", "대한", "어떤", "무엇", "방법", "기준", "질문", "문의", "확인", "가능", "여부", "하는", "있나요", "주세요", "입니다"]);
const PARTICLES = ["으로", "에서", "에게", "까지", "부터", "처럼", "보다", "에는", "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "만", "로"];

export function normalizeTerm(value: string) {
  let term = value.trim().toLowerCase();
  for (const particle of PARTICLES) {
    if (term.endsWith(particle) && term.length > particle.length + 1) return term.slice(0, -particle.length);
  }
  return term;
}

export function tokens(text: string) {
  return text.match(/[가-힣A-Za-z0-9]{2,}/g)?.map(normalizeTerm).filter((term) => term.length > 1 && !STOPWORDS.has(term)) ?? [];
}

export function questionKeywords(question: string) {
  const frequency = new Map<string, number>();
  for (const term of tokens(question)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return [...frequency.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 2).map(([term]) => term);
}

export function chapterKeywords(chapterTexts: string[], allChapterTexts: string[][]) {
  const frequency = new Map<string, number>();
  for (const term of tokens(chapterTexts.join(" "))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const documentFrequency = new Map<string, number>();
  for (const texts of allChapterTexts) for (const term of new Set(tokens(texts.join(" ")))) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return [...frequency.entries()]
    .map(([term, count]) => ({ term, frequency: count, score: Number((count * Math.log((allChapterTexts.length + 1) / ((documentFrequency.get(term) ?? 0) + 1) + 1)).toFixed(4)) }))
    .sort((a, b) => b.score - a.score || b.frequency - a.frequency)
    .slice(0, 120);
}

export function chunkPages(pages: { page: number; text: string }[], target = 1200, overlap = 180) {
  const chunks: { content: string; pageFrom: number; pageTo: number }[] = [];
  let content = "";
  let pageFrom = pages[0]?.page ?? 1;
  let pageTo = pageFrom;
  const save = () => { if (content.trim().length >= 80) chunks.push({ content: content.trim(), pageFrom, pageTo }); };
  for (const page of pages) {
    let remaining = page.text.trim();
    while (remaining) {
      let end = Math.min(remaining.length, target);
      if (end < remaining.length) {
        const breakAt = remaining.lastIndexOf(" ", end);
        if (breakAt > target / 2) end = breakAt;
      }
      const text = remaining.slice(0, end).trim();
      remaining = remaining.slice(end).trim();
      if (!text) continue;
      if (content && content.length + text.length > target) {
        save();
        content = content.slice(-overlap).trim();
        pageFrom = page.page;
      }
      content += `${content ? "\n\n" : ""}${text}`;
      pageTo = page.page;
    }
  }
  save();
  return chunks;
}
