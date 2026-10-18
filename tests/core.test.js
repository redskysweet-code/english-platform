import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, review, isDue, dueItems, newItemsForLesson, isMastered, DAY } from '../src/srs.js';
import { checkAnswer, normalize } from '../src/answer.js';
import { Store, emptyProgress, SCHEMA_VERSION } from '../src/storage.js';

const item = { id: 'w1', levelId: 'preA1', lessonId: 'l1', blockId: 'b1' };
const T0 = 1_000_000_000_000;

test('новый элемент не считается повторением', () => {
  const s = createState(item, T0);
  assert.equal(isDue(s, T0 + 100 * DAY), false);
  assert.equal(newItemsForLesson([item], { w1: s }).length, 1);
});

test('после первого прохождения элемент уходит из нового и появляется в повторении', () => {
  let s = review(createState(item, T0), { correct: true, active: false }, T0);
  assert.equal(newItemsForLesson([item], { w1: s }).length, 0);
  assert.equal(dueItems({ w1: s }, T0 + 2 * DAY).length, 1);
  assert.equal(dueItems({ w1: s }, T0 + 1000).length, 0);
});

test('интервалы растут при верных ответах', () => {
  let s = createState(item, T0);
  let t = T0;
  const intervals = [];
  for (let i = 0; i < 5; i++) {
    s = review(s, { correct: true, active: true }, t);
    intervals.push(s.interval);
    t += s.interval * DAY;
  }
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i] > intervals[i - 1], intervals.join());
});

test('ошибка возвращает элемент в повторение через 10 минут', () => {
  let s = review(createState(item, T0), { correct: true, active: true }, T0);
  s = review(s, { correct: false, active: true }, T0 + DAY);
  assert.equal(s.interval, 0);
  assert.equal(s.lapses, 1);
  assert.ok(s.due - (T0 + DAY) <= 10 * 60 * 1000);
});

test('подсказки укорачивают интервал', () => {
  const base = review(review(createState(item, T0), { correct: true }, T0), { correct: true }, T0);
  const clean = review(base, { correct: true }, T0);
  const hinted = review(base, { correct: true, hints: 1 }, T0);
  assert.ok(hinted.interval < clean.interval);
});

test('освоенным слово становится только после активного воспроизведения', () => {
  let s = createState(item, T0);
  let t = T0;
  for (let i = 0; i < 8; i++) {
    s = review(s, { correct: true, active: false }, t);
    t += s.interval * DAY;
  }
  assert.equal(isMastered(s), false); // только узнавание
  for (let i = 0; i < 3; i++) {
    s = review(s, { correct: true, active: true }, t);
    t += s.interval * DAY;
  }
  assert.equal(isMastered(s), true);
});

test('проверка ответа: регистр, пунктуация, апострофы', () => {
  assert.equal(checkAnswer("  I'M a student. ", ["I'm a student"]).correct, true);
  assert.equal(checkAnswer('I’m a student', ["I'm a student"]).correct, true);
  assert.equal(checkAnswer('I am a student', ["I'm a student", 'I am a student']).correct, true);
  assert.equal(normalize('Hello,   World!'), 'hello world');
});

test('опечатка в длинном слове: не засчитываем, но говорим, что почти', () => {
  const r = checkAnswer('studnt', ['student']);
  assert.equal(r.correct, false);
  assert.equal(r.near, true);
  assert.equal(checkAnswer('cat', ['cot']).near, false);
});

function memBackend() {
  const m = new Map();
  return { persistent: true, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m };
}

test('прогресс переживает перезагрузку (новый Store на том же хранилище)', () => {
  const b = memBackend();
  const a = new Store(b);
  a.data.completedLessons.l1 = { at: 1, score: 90 };
  a.save();
  const again = new Store(b);
  assert.equal(again.data.completedLessons.l1.score, 90);
  assert.equal(again.data.profileId, a.data.profileId);
});

test('экспорт и импорт, плохой файл не ломает прогресс', () => {
  const a = new Store(memBackend());
  a.data.bookmarks.push('x');
  const dump = a.exportJSON();
  const b = new Store(memBackend());
  assert.equal(b.importJSON(dump).ok, true);
  assert.deepEqual(b.data.bookmarks, ['x']);
  const before = JSON.stringify(b.data);
  assert.equal(b.importJSON('{not json').ok, false);
  assert.equal(b.importJSON(JSON.stringify({ schema: 99 })).ok, false);
  assert.equal(JSON.stringify(b.data), before);
});

test('битые данные сохраняются копией, а не пропадают', () => {
  const b = memBackend();
  b.set('english-path:progress', '{broken');
  const s = new Store(b);
  assert.equal(s.data.schema, SCHEMA_VERSION);
  assert.ok([...b.m.keys()].some((k) => k.includes(':broken:')));
});

test('сокращения равны полным формам, если упражнение не просит именно краткую форму', () => {
  assert.equal(checkAnswer("She's my sister", ['she is my sister']).correct, true);
  assert.equal(checkAnswer('she is my sister', ["she's my sister"]).correct, true);
  assert.equal(checkAnswer("It isn't hot", ['it is not hot']).correct, true);
});

test('strict: когда просят краткую форму, полная форма не засчитывается', () => {
  assert.equal(checkAnswer('I am', ["I'm"], { strict: true }).correct, false);
  assert.equal(checkAnswer("I'm", ["I'm"], { strict: true }).correct, true);
  assert.equal(checkAnswer("I’m", ["I'm"], { strict: true }).correct, true);
});

import { tallySkills, evaluate } from '../src/scoring.js';

const mk = (skill, ok, n) => Array.from({ length: n }, (_, i) => ({ ex: { skill }, res: { correct: i < ok } }));
const rule = { vocabulary: 80, grammar: 80, reading: 70, listening: 70 };

test('зачёт: все навыки выше порога и письмо выполнено', () => {
  const by = tallySkills([...mk('vocabulary', 8, 10), ...mk('grammar', 8, 10), ...mk('reading', 4, 5), ...mk('listening', 7, 10)], (e) => e.skill);
  const r = evaluate(by, rule, 2, 2);
  assert.equal(r.passed, true);
});

test('высокий результат по одному навыку не компенсирует провал другого', () => {
  const by = tallySkills([...mk('vocabulary', 10, 10), ...mk('grammar', 10, 10), ...mk('reading', 5, 5), ...mk('listening', 3, 10)], (e) => e.skill);
  const r = evaluate(by, rule, 2, 2);
  assert.equal(r.passed, false);
  assert.equal(r.rows.find((x) => x.skill === 'listening').ok, false);
});

test('без письменных заданий зачёта нет, даже при идеальных ответах', () => {
  const by = tallySkills([...mk('vocabulary', 10, 10), ...mk('grammar', 10, 10), ...mk('reading', 5, 5), ...mk('listening', 10, 10)], (e) => e.skill);
  assert.equal(evaluate(by, rule, 1, 2).passed, false);
});

test('навык без вопросов не считается сданным', () => {
  const by = tallySkills([...mk('vocabulary', 10, 10), ...mk('grammar', 10, 10), ...mk('reading', 5, 5)], (e) => e.skill);
  assert.equal(evaluate(by, rule, 2, 2).passed, false);
});

test('граница порога: ровно 80% проходит, 79% нет', () => {
  assert.equal(evaluate(tallySkills(mk('vocabulary', 4, 5), (e) => e.skill), { vocabulary: 80 }, 0, 0).passed, true);
  assert.equal(evaluate(tallySkills(mk('vocabulary', 79, 100), (e) => e.skill), { vocabulary: 80 }, 0, 0).passed, false);
});
