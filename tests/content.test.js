import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCourse } from '../scripts/validate-content.mjs';
import { recognizeEx, listenEx, produceEx, grade } from '../src/exercises.js';

const { lessons, problems } = checkCourse();

test('структура контента без ошибок', () => {
  assert.deepEqual(problems, []);
});

test('каждое упражнение принимает свой эталонный ответ и отвергает чужой', () => {
  for (const l of lessons) {
    for (const e of l.exercises) {
      if (e.options) {
        assert.equal(grade(e, e.answer).correct, true, l.id + ':' + e.id);
        assert.equal(grade(e, (e.answer + 1) % e.options.length).correct, false, l.id + ':' + e.id);
      } else {
        for (const a of e.accepted) assert.equal(grade(e, a).correct, true, l.id + ':' + e.id + ' ' + a);
        assert.equal(grade(e, 'qqqq').correct, false);
      }
    }
  }
});

test('автоупражнения по словам: верный вариант есть и один, ввод принимает слово', () => {
  const all = lessons.flatMap((l) => l.vocab);
  for (const l of lessons) {
    const pool = lessons.filter((x) => x.levelId === l.levelId).flatMap((x) => x.vocab);
    for (const w of l.vocab) {
      for (const ex of [recognizeEx(w, pool), listenEx(w, pool)]) {
        assert.equal(new Set(ex.options).size, ex.options.length, w.id + ' повтор вариантов');
        assert.equal(ex.options.filter((_, i) => grade(ex, i).correct).length, 1, w.id);
        assert.ok(ex.options.length >= 3, w.id + ' мало вариантов');
      }
      assert.equal(grade(produceEx(w), w.en).correct, true, w.id);
    }
  }
  assert.ok(all.length >= 40);
});

test('строгие упражнения не принимают полную форму вместо краткой', () => {
  const strict = lessons.flatMap((l) => l.exercises.filter((e) => e.strict));
  assert.ok(strict.length >= 2);
  for (const e of strict) assert.equal(grade(e, 'i am').correct, false, e.id);
});

test('в курсе есть материал для каждого навыка и вопросов хватает для контрольной', () => {
  const { tests, readings, writing, lessons: ls } = checkCourse();
  const t = tests[0];
  assert.ok(t.grammar.length >= 12);
  assert.ok(t.reading.questions.length >= 4);
  assert.ok(t.listening.length >= 3);
  assert.ok(readings.length >= 3);
  assert.ok(writing.length >= 2);
  assert.ok(ls.some((l) => l.dialogue));
  assert.ok(ls.filter((l) => l.vocab).reduce((n, l) => n + l.vocab.length, 0) >= 100);
});

test('в тексте урока слова из новых уроков не опережают изученное: слова в тексте урока 11 известны к этому уроку', () => {
  const l11 = lessons.find((l) => l.id === 'preA1-11');
  const known = new Set();
  for (const l of lessons.filter((x) => x.id <= 'preA1-11')) {
    for (const v of l.vocab) for (const w of v.en.toLowerCase().split(' ')) known.add(w);
    // слова, которые урок вводит списками озвученных чипов (числа, дни, цвета)
    for (const b of l.explanation.filter((x) => x.t === 'say')) for (const it of b.items) for (const w of it.en.toLowerCase().split(' ')) known.add(w);
  }
  // служебные слова, которые объяснены в самом уроке или на уроках раньше
  for (const w of ['and', 'a', 'an', 'the', 'is', 'are', 'am', 'at', 'on', 'in', 'not', 'of', 'to', 'it', 'you', 'we']) known.add(w);
  const text = l11.reading.sentences.map((s) => s.en).join(' ').toLowerCase().replace(/[.,!?]/g, '').split(/\s+/);
  const unknown = text.filter((w) => !known.has(w) && !known.has(w.split('-')[0]) && !['anna', 'max'].includes(w));
  assert.deepEqual(unknown, []);
});
