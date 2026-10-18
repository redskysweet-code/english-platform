// генерация упражнений из слов и проверка ответов

import { checkAnswer } from './answer.js';

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function distractors(word, pool, field, n = 3) {
  const others = pool.filter((w) => w.id !== word.id && w[field] !== word[field]);
  // сначала беру слова с той же частью речи, так варианты правдоподобнее
  const same = shuffle(others.filter((w) => w.pos === word.pos));
  const rest = shuffle(others.filter((w) => w.pos !== word.pos));
  return [...same, ...rest].slice(0, n).map((w) => w[field]);
}

function choiceFrom(correct, wrong) {
  const options = shuffle([correct, ...wrong]);
  return { options, answer: options.indexOf(correct) };
}

/** en -> ru, выбор из вариантов (узнавание) */
export function recognizeEx(word, pool) {
  const { options, answer } = choiceFrom(word.ru, distractors(word, pool, 'ru'));
  return {
    id: 'auto:rec:' + word.id, kind: 'vocab', skill: 'vocabulary', topic: 'Слова', lessonId: word.lessonId, itemId: word.id, type: 'choice', active: false,
    prompt: 'Что значит «' + word.en + '»?', speak: word.en, options, answer,
    explain: word.en + ' = ' + word.ru + '. Пример: ' + word.example + ' (' + word.exampleRu + ')',
  };
}

/** на слух выбрать слово (узнавание на слух) */
export function listenEx(word, pool) {
  const { options, answer } = choiceFrom(word.en, distractors(word, pool, 'en'));
  return {
    id: 'auto:lis:' + word.id, kind: 'vocab', skill: 'listening', topic: 'Слова на слух', lessonId: word.lessonId, itemId: word.id, type: 'listen', active: false,
    prompt: 'Послушайте и выберите слово', audio: word.en, options, answer,
    explain: 'Прозвучало слово ' + word.en + ' (' + word.ru + ').',
  };
}

/** ru -> en, ввод с клавиатуры (активное воспроизведение) */
export function produceEx(word) {
  return {
    id: 'auto:prod:' + word.id, kind: 'vocab', skill: 'vocabulary', topic: 'Слова', lessonId: word.lessonId, itemId: word.id, type: 'type', active: true,
    prompt: 'Как будет по-английски «' + word.ru + '»?', accepted: [word.en, ...(word.alt ?? [])],
    explain: word.ru + ' по-английски: ' + word.en + '. Пример: ' + word.example,
  };
}

/** выбираю тип упражнения для повторения по истории слова */
export function reviewEx(word, state, pool) {
  const activeOk = state.active.ok;
  if (state.recog.ok < 2 && activeOk === 0) return recognizeEx(word, pool);
  if (state.lapses > 0 && state.reps === 0) return recognizeEx(word, pool); // после ошибки сначала попроще
  return activeOk % 3 === 2 ? listenEx(word, pool) : produceEx(word);
}

/** единая проверка: возвращает { correct, near, expected, given } */
export function grade(ex, input) {
  if (ex.type === 'choice' || ex.type === 'listen') {
    const idx = Number(input);
    return { correct: idx === ex.answer, near: false, expected: ex.options[ex.answer], given: ex.options[idx] };
  }
  const r = checkAnswer(input, ex.accepted, { strict: !!ex.strict });
  return { ...r, given: input };
}
