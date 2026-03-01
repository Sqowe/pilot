export function sanitizeScreenInterpretationAnswer(raw: string): string {
  let text = (raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return text;
  }

  text = stripOperationSuccessJudgment(text);
  text = collapseLikelyEchoedCjk(text);
  text = cutRepeatedScreenReport(text);
  text = dedupeConsecutiveParagraphs(text);
  text = dedupeConsecutiveLines(text);
  return text.trim();
}

function stripOperationSuccessJudgment(text: string): string {
  const patterns = [
    /\n?\*\*Operation Success Judgment:\*\*[\s\S]*?(?:- Status:\s*(?:SUCCESS|FAILURE)[\s\S]*?(?:\n{2,}|$))/gi,
    /\n?Operation Success Judgment:\s*[\s\S]*?(?:Status:\s*(?:SUCCESS|FAILURE)[\s\S]*?(?:\n{2,}|$))/gi,
  ];
  let stripped = text;
  for (const pattern of patterns) {
    stripped = stripped.replace(pattern, '\n\n');
  }
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

function collapseLikelyEchoedCjk(text: string): string {
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  if (cjk.length < 60) {
    return text;
  }
  const doubled = text.match(/([\u4e00-\u9fff])\1/g) || [];
  const ratio = doubled.length / cjk.length;
  if (ratio < 0.18) {
    return text;
  }
  return text.replace(/([\u4e00-\u9fff])\1/g, '$1');
}

function cutRepeatedScreenReport(text: string): string {
  const intros = ['下面是基于截图', '以下是我基于截图', '以下是基于截图'];
  for (const intro of intros) {
    const first = text.indexOf(intro);
    if (first < 0) continue;
    const second = text.indexOf(intro, first + intro.length);
    if (second > first + 20) {
      return text.slice(0, second).trim();
    }
  }

  const headingRegex = /###\s*1[).]/g;
  const matches = [...text.matchAll(headingRegex)];
  if (matches.length >= 2) {
    const firstIndex = matches[0].index ?? -1;
    const secondIndex = matches[1].index ?? -1;
    if (firstIndex >= 0 && secondIndex > firstIndex + 120) {
      return text.slice(0, secondIndex).trim();
    }
  }
  return text;
}

function dedupeConsecutiveParagraphs(text: string): string {
  const blocks = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    return text;
  }
  const kept: string[] = [];
  for (const block of blocks) {
    const prev = kept[kept.length - 1] || '';
    if (normalizeDedupText(prev) === normalizeDedupText(block)) {
      continue;
    }
    kept.push(block);
  }
  return kept.join('\n\n').trim();
}

function dedupeConsecutiveLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return text;
  }
  const kept: string[] = [];
  for (const line of lines) {
    const prev = kept[kept.length - 1] || '';
    if (normalizeDedupText(prev) === normalizeDedupText(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function normalizeDedupText(text: string): string {
  return text.replace(/\s+/g, '').trim();
}
