// прогоняю весь контент через проверку структуры и ищу общие проблемы
import { readFileSync } from 'node:fs';
import { validateLesson, validateExercise, validateReading } from '../src/content.js';

const read = (rel) => JSON.parse(readFileSync(new URL('../content/' + rel, import.meta.url)));

export function checkCourse() {
  const course = read('course.json');
  const problems = [];
  const lessonIds = new Set();
  const vocabIds = new Map();
  const ruByLevel = new Map();
  const lessons = [];
  for (const meta of course.lessons) {
    if (lessonIds.has(meta.id)) problems.push('повтор id урока ' + meta.id);
    lessonIds.add(meta.id);
    const lesson = read(meta.file);
    lessons.push(lesson);
    if (lesson.id !== meta.id) problems.push('id в файле не совпадает с course.json: ' + meta.id);
    if (lesson.levelId !== meta.levelId) problems.push(meta.id + ': levelId не совпадает с course.json');
    problems.push(...validateLesson(lesson));
    for (const v of lesson.vocab ?? []) {
      if (vocabIds.has(v.id)) problems.push('слово ' + v.id + ' есть и в ' + vocabIds.get(v.id) + ', и в ' + lesson.id);
      vocabIds.set(v.id, lesson.id);
      // одинаковый перевод у двух слов делает задание «русский → английский» неоднозначным
      const key = lesson.levelId + ':' + v.ru.toLowerCase();
      if (ruByLevel.has(key) && ruByLevel.get(key) !== v.id) problems.push('одинаковый перевод «' + v.ru + '» у ' + ruByLevel.get(key) + ' и ' + v.id);
      ruByLevel.set(key, v.id);
    }
  }
  // отдельные тексты
  const readings = course.readings ? read(course.readings.file) : [];
  const rIds = new Set();
  for (const r of readings) {
    if (rIds.has(r.id)) problems.push('повтор id текста ' + r.id);
    rIds.add(r.id);
    validateReading(r, 'текст ' + r.id, problems);
    for (const req of r.requires ?? []) if (!lessonIds.has(req)) problems.push('текст ' + r.id + ' требует несуществующий урок ' + req);
  }
  // письменные задания
  const writing = course.writing ?? [];
  for (const w of writing) {
    for (const req of w.requires ?? []) if (!lessonIds.has(req)) problems.push('задание ' + w.id + ' требует несуществующий урок ' + req);
    const text = (w.sample ?? '').replace(/’/g, "'");
    for (const c of w.checks ?? []) {
      let re;
      try { re = new RegExp(c.pattern, c.flags ?? ''); } catch { problems.push('задание ' + w.id + ': плохой шаблон «' + c.label + '»'); continue; }
      if (!re.test(text)) problems.push('образец задания ' + w.id + ' не проходит свою же проверку: ' + c.label);
    }
  }
  // контрольные
  const tests = [];
  for (const meta of course.tests ?? []) {
    const t = read(meta.file);
    tests.push(t);
    for (const id of meta.lessonIds) if (!lessonIds.has(id)) problems.push('тест ' + meta.id + ': нет урока ' + id);
    for (const id of meta.writingIds ?? []) if (!writing.some((w) => w.id === id)) problems.push('тест ' + meta.id + ': нет задания ' + id);
    const seen = new Set();
    const items = [...(t.grammar ?? []), ...(t.listening ?? [])];
    for (const e of items) {
      problems.push(...validateExercise(e, 'тест ' + meta.id));
      if (seen.has(e.id)) problems.push('тест ' + meta.id + ': повтор id ' + e.id);
      seen.add(e.id);
      if (!meta.lessonIds.includes(e.lessonId)) problems.push('тест ' + meta.id + ': ' + e.id + ' ссылается на урок вне теста');
    }
    validateReading(t.reading, 'тест ' + meta.id, problems);
    for (const q of t.reading.questions) {
      if (seen.has(q.id)) problems.push('тест ' + meta.id + ': повтор id ' + q.id);
      seen.add(q.id);
    }
  }
  return { course, lessons, readings, writing, tests, problems };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const { lessons, problems, readings, tests } = checkCourse();
  problems.forEach((p) => console.error(p));
  console.log(problems.length ? 'найдено проблем: ' + problems.length : 'контент в порядке: уроков ' + lessons.length + ', текстов ' + readings.length + ', контрольных ' + tests.length);
  process.exit(problems.length ? 1 : 0);
}
