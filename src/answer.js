// проверка свободного ввода: регистр, пунктуация и сокращения не должны считаться ошибкой,
// если вопрос не просит именно краткую форму (тогда у упражнения стоит strict)

const CONTRACTIONS = [
  [/\bi'm\b/g, 'i am'], [/\byou're\b/g, 'you are'], [/\bhe's\b/g, 'he is'], [/\bshe's\b/g, 'she is'],
  [/\bit's\b/g, 'it is'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'],
  [/\bwhat's\b/g, 'what is'], [/\bwhere's\b/g, 'where is'], [/\bwho's\b/g, 'who is'], [/\bhow's\b/g, 'how is'],
  [/\bthat's\b/g, 'that is'], [/\bthere's\b/g, 'there is'], [/\bthis's\b/g, 'this is'],
  [/\bisn't\b/g, 'is not'], [/\baren't\b/g, 'are not'],
];

export function normalize(text, { strict = false } = {}) {
  let t = String(text)
    .normalize('NFKC')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/[.,!?;:"“”()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!strict) for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t;
}

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * accepted: список допустимых ответов (все альтернативы, которые я заранее разрешил)
 * возвращает { correct, near, expected }
 * near = true, если опечатка в одну букву в длинном слове: засчитываем как ошибку,
 * но говорим человеку, что он почти угадал
 */
export function checkAnswer(input, accepted, opts = {}) {
  const given = normalize(input, opts);
  const list = accepted.map((a) => normalize(a, opts));
  if (given && list.includes(given)) return { correct: true, near: false, expected: accepted[0] };
  const near = !!given && list.some((a) => a.length >= 5 && levenshtein(given, a) === 1);
  return { correct: false, near, expected: accepted[0] };
}
