import { Store } from './storage.js';
import { createState, review, dueItems, newItemsForLesson, isMastered, DAY } from './srs.js';
import { loadCourse, loadLesson, loadVocabMap, loadAllLessons, loadReadings, loadTest } from './content.js';
import { recognizeEx, listenEx, produceEx, reviewEx, grade } from './exercises.js';
import { speak, stopSpeaking, ttsSupported } from './tts.js';
import { tallySkills, evaluate } from './scoring.js';

const store = new Store();
const $main = document.getElementById('main');
const $nav = document.getElementById('nav');

// маленький помощник для создания элементов, текст всегда идет через textContent
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// replaceChildren превращает null в текст «null», поэтому пустые значения убираю сам
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const SPEAK_ERRORS = {
  unsupported: 'Этот браузер не умеет озвучивать текст. Попробуйте Chrome, Safari или Edge.',
  'no-voice': 'На устройстве нет английского голоса. Установите его в настройках системы (синтез речи).',
  error: 'Не получилось воспроизвести звук. Попробуйте ещё раз.',
};

async function say(text) {
  const r = await speak(text, { accent: store.data.settings.accent, rate: store.data.settings.rate });
  if (!r.ok && r.reason !== 'cancelled') toast(SPEAK_ERRORS[r.reason]);
}

function audioBtn(text, label = 'Прослушать') {
  return h('button', { class: 'audio', type: 'button', 'aria-label': label + ': ' + text, onclick: () => say(text) }, '🔊');
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', store.data.settings.theme);
}

// ---------- работа с прогрессом ----------

const todayKey = () => new Date().toISOString().slice(0, 10);

function logEvent(type, extra = {}) {
  store.data.log.push({ at: Date.now(), day: todayKey(), type, ...extra });
  if (store.data.log.length > 500) store.data.log.splice(0, store.data.log.length - 500);
}

function recordAnswer(word, ex, res) {
  if (!word) return;
  const prev = store.data.srs[word.id] ?? createState(word);
  store.data.srs[word.id] = review(prev, { correct: res.correct, active: ex.active, hints: res.hints, errors: 0, ms: res.ms });
  if (!res.correct) {
    store.data.mistakes.unshift({ itemId: word.id, at: Date.now(), given: String(res.given ?? '') });
    store.data.mistakes.length = Math.min(store.data.mistakes.length, 100);
  }
}

function recordGrammar(ex, correct) {
  if (!ex.topic) return;
  const g = (store.data.grammar[ex.topic] ??= { ok: 0, total: 0 });
  g.total += 1;
  if (correct) g.ok += 1;
}

// ---------- упражнение ----------

function runExercise(ex, { onDone, showProgress, exam = false }) {
  const start = Date.now();
  let hints = 0;
  let answered = false;
  const box = h('div', { class: 'card' });
  if (showProgress) box.append(showProgress);
  if (ex.context) box.append(h('div', { class: 'hl' }, h('div', { class: 'row' }, ex.contextSpeak ? audioBtn(ex.contextSpeak, 'Прослушать текст') : null, h('div', { style: 'flex:1;min-width:0' }, ex.context))));
  const promptRow = h('div', { class: 'row' });
  const audioText = ex.audio ?? ex.speak;
  if (audioText) promptRow.append(audioBtn(audioText));
  promptRow.append(h('h2', { style: 'margin:0' }, ex.prompt));
  box.append(promptRow);
  const fb = h('div', { 'aria-live': 'polite' });
  const area = h('div');
  box.append(area, fb);

  function finish(result) {
    if (answered) return;
    answered = true;
    if (exam) { onDone({ ...result, hints, ms: Date.now() - start }); return; }
    const ok = result.correct;
    fb.className = 'fb ' + (ok ? 'ok' : 'bad');
    fill(fb, 
      h('b', {}, ok ? 'Верно!' : result.near ? 'Почти! Проверьте написание.' : 'Не совсем.'),
      !ok ? h('div', {}, 'Правильный ответ: ' + result.expected) : null,
      h('div', { class: 'why' }, ex.explain),
    );
    const next = h('button', { class: 'btn wide', type: 'button', style: 'margin-top:12px' }, 'Дальше');
    next.addEventListener('click', () => onDone({ ...result, hints, ms: Date.now() - start }));
    box.append(next);
    next.focus();
  }

  if (ex.type === 'choice' || ex.type === 'listen') {
    const opts = h('div', { class: 'opts', role: 'group' });
    ex.options.forEach((text, i) => {
      const b = h('button', { class: 'opt', type: 'button' }, text);
      b.addEventListener('click', () => {
        if (answered) return;
        const r = grade(ex, i);
        if (!exam) {
          b.classList.add(r.correct ? 'ok' : 'bad');
          if (!r.correct) opts.children[ex.answer].classList.add('ok');
        }
        for (const c of opts.children) c.disabled = true;
        finish(r);
      });
      opts.append(b);
    });
    area.append(opts);
  } else {
    const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Ваш ответ' });
    const check = h('button', { class: 'btn', type: 'button' }, 'Проверить');
    const hint = h('button', { class: 'btn ghost', type: 'button' }, 'Подсказка');
    const submit = () => {
      if (answered || !input.value.trim()) return;
      input.disabled = check.disabled = hint.disabled = true;
      finish(grade(ex, input.value));
    };
    check.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    hint.addEventListener('click', () => {
      hints += 1;
      const exp = ex.accepted[0];
      toast('Начинается с «' + exp.slice(0, Math.min(hints, exp.length)) + '»');
      input.focus();
    });
    area.append(h('div', { style: 'margin-top:12px' }, input), h('div', { class: 'row', style: 'margin-top:10px' }, check, exam ? null : hint));
    setTimeout(() => input.focus(), 50);
  }
  return box;
}

// ---------- блоки объяснения ----------

function renderBlock(b) {
  switch (b.t) {
    case 'h': return h('h2', {}, b.text);
    case 'p': return h('p', {}, b.text);
    case 'hl': return h('div', { class: 'hl' }, b.text);
    case 'warn': return h('div', { class: 'warn' }, b.text);
    case 'list': return h('ul', {}, b.items.map((i) => h('li', {}, i)));
    case 'ex': return h('div', { class: 'row', style: 'margin:6px 0' }, audioBtn(b.en), h('div', {}, h('div', { class: 'en' }, b.en), h('div', { class: 'muted' }, b.ru)));
    case 'letters':
      return h('div', {}, b.items.map((it) => h('div', { class: 'row', style: 'padding:6px 0;border-bottom:1px solid var(--line)' },
        audioBtn(it.say, 'Название буквы ' + it.l),
        h('b', { style: 'font-size:22px;min-width:52px' }, it.l + it.l.toLowerCase()),
        h('span', { class: 'ipa', style: 'min-width:80px' }, it.ipa),
        h('span', { class: 'muted' }, it.word))));
    case 'say':
      return h('div', { class: 'row', style: 'margin:8px 0' }, b.items.map((it) => h('button', { class: 'chip', type: 'button', onclick: () => say(it.en), 'aria-label': 'Прослушать: ' + it.en },
        '🔊 ', it.note ? it.note + ' · ' : '', h('b', {}, it.en))));
    case 'table':
      return h('div', { style: 'overflow-x:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, c)))),
        h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
    default: return null;
  }
}

// ---------- общие помощники для разделов ----------

const SKILL_NAMES = { vocabulary: 'Слова', grammar: 'Грамматика', reading: 'Чтение', listening: 'Аудирование' };
const pct = (s) => (s && s.total ? Math.round((s.ok / s.total) * 100) : null);
const lessonDone = (id) => !!store.data.completedLessons[id];
const allDone = (ids) => (ids ?? []).every(lessonDone);

/** навык, к которому относится ответ: явный skill, либо по типу упражнения и урока */
function skillOf(ex, lesson) {
  if (ex.skill) return ex.skill;
  if (ex.type === 'listen') return 'listening';
  return lesson?.grammar ? 'grammar' : 'vocabulary';
}

function recordSkill(skill, correct) {
  const all = (store.data.skills ??= {});
  const s = (all[skill] ??= { ok: 0, total: 0 });
  s.total += 1;
  if (correct) s.ok += 1;
}

function lockedNote(course, ids) {
  const names = ids.filter((x) => !lessonDone(x)).map((x) => course.lessons.find((l) => l.id === x)?.title ?? x);
  return h('p', { class: 'muted' }, 'Откроется после уроков: ' + names.join(', ') + '.');
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// слова урока для подсветки в текстах: только однословные английские слова из словаря уровня
const vocabSetCache = new Map();
async function vocabSetFor(levelId) {
  if (vocabSetCache.has(levelId)) return vocabSetCache.get(levelId);
  const course = await loadCourse();
  const map = await loadVocabMap(course.lessons.filter((l) => l.levelId === levelId).map((l) => l.id));
  const set = new Set(Object.values(map).map((w) => w.en.toLowerCase()).filter((w) => /^[a-z']+$/.test(w)));
  vocabSetCache.set(levelId, set);
  return set;
}

function markVocab(text, set) {
  return text.split(/([A-Za-z']+)/).map((p) => (set.has(p.toLowerCase()) ? h('mark', { class: 'vocab' }, p) : p));
}

// последовательное воспроизведение с возможностью прерывания при смене страницы
let playToken = 0;
async function playSequence(texts, onLine) {
  const mine = ++playToken;
  for (let i = 0; i < texts.length; i++) {
    if (mine !== playToken) return;
    onLine?.(i);
    const r = await speak(texts[i], { accent: store.data.settings.accent, rate: store.data.settings.rate });
    if (mine !== playToken) return;
    if (!r.ok) { if (r.reason !== 'cancelled') toast(SPEAK_ERRORS[r.reason]); break; }
  }
  if (mine === playToken) onLine?.(-1);
}

function lineRows(lines, { who = false, vset = null } = {}) {
  return lines.map((ln) => {
    const ru = h('div', { class: 'muted', hidden: true }, ln.ru);
    const body = vset ? markVocab(ln.en, vset) : ln.en;
    const row = h('div', { class: 'row dline' }, audioBtn(ln.en), h('div', { style: 'flex:1;min-width:0' }, who ? h('b', {}, ln.who + ': ') : null, h('span', { class: 'en' }, body), ru));
    return { row, ru };
  });
}

function playControls(rows, lines) {
  const tbtn = h('button', { class: 'btn ghost', type: 'button' }, 'Показать перевод');
  tbtn.addEventListener('click', () => {
    const show = rows[0].ru.hidden;
    rows.forEach((r) => { r.ru.hidden = !show; });
    tbtn.textContent = show ? 'Скрыть перевод' : 'Показать перевод';
  });
  const pbtn = h('button', { class: 'btn secondary', type: 'button' }, '▶ Слушать целиком');
  pbtn.addEventListener('click', () => playSequence(lines.map((l) => l.en), (i) => rows.forEach((r, k) => r.row.classList.toggle('playing', k === i))));
  return h('div', { class: 'row', style: 'margin:8px 0' }, pbtn, tbtn);
}

function dialogueCard(d) {
  const rows = lineRows(d.lines, { who: true });
  return h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Диалог: ' + d.title), playControls(rows, d.lines), ...rows.map((r) => r.row));
}

function readingCard(r, vset, levelLabel = 'Pre-A1') {
  const rows = lineRows(r.sentences, { vset });
  return h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, 'Текст: ' + r.title), h('span', { class: 'tag' }, levelLabel + ' · ~' + (r.minutes ?? 1) + ' мин')),
    playControls(rows, r.sentences),
    ...rows.map((x) => x.row),
    h('p', { class: 'muted', style: 'margin-top:10px' }, 'Подсвечены слова, которые вы уже учили.'),
    r.glossary?.length ? h('p', { class: 'muted' }, 'Слова к тексту: ' + r.glossary.map((g) => g.en + ' — ' + g.ru).join('; ')) : null);
}

const readingContext = (r) => r.sentences.map((s) => s.en).join(' ');
const readingQuestions = (r) => r.questions.map((q) => ({ ...q, skill: 'reading', context: readingContext(r), contextSpeak: readingContext(r) }));

/** серия упражнений: с обратной связью после каждого или как экзамен (без ответов до конца) */
function session(list, { title, backHref = '#/more', exam = false, onEach, onFinish }) {
  const results = [];
  let i = 0;
  const step = () => {
    if (i >= list.length) return onFinish(results);
    const ex = list[i];
    const bar = h('div', { class: 'progress', style: 'margin-bottom:12px' }, h('i', { style: 'width:' + Math.round((i / list.length) * 100) + '%' }));
    fill($main,
      h('a', { href: backHref, class: 'muted' }, '← Выйти'),
      h('h1', {}, title),
      h('p', { class: 'muted' }, 'Вопрос ' + (i + 1) + ' из ' + list.length),
      runExercise(ex, { exam, showProgress: bar, onDone: (res) => { results.push({ ex, res }); onEach?.(ex, res); i += 1; step(); } }));
    window.scrollTo(0, 0);
  };
  step();
}

function summaryView(title, results, { backHref, backLabel = 'Назад', againHref = null, extra = [] }) {
  const ok = results.filter((r) => r.res.correct).length;
  const score = results.length ? Math.round((ok / results.length) * 100) : 0;
  fill($main,
    h('h1', {}, title),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, score + '%'), h('p', {}, 'Верно: ' + ok + ' из ' + results.length + '.'), ...extra),
    h('div', { class: 'row' },
      againHref ? h('a', { class: 'btn', href: againHref }, 'Ещё раз') : null,
      h('a', { class: 'btn secondary', href: backHref }, backLabel)));
}

function weakTopics(lessons) {
  const out = [];
  for (const l of lessons.filter((x) => x.grammar && lessonDone(x.id))) {
    for (const t of new Set((l.exercises ?? []).filter((e) => e.topic).map((e) => e.topic))) {
      const st = store.data.grammar[t];
      if (st && st.total >= 3 && pct(st) < 70) out.push({ topic: t, lessonId: l.id, pct: pct(st) });
    }
  }
  return out;
}

// ---------- плеер урока ----------

async function lessonView(lessonId) {
  const lesson = await loadLesson(lessonId);
  const course = await loadCourse();
  const pool = (await loadVocabMap(course.lessons.filter((l) => l.levelId === lesson.levelId).map((l) => l.id)));
  const poolList = Object.values(pool);
  const words = (lesson.vocab ?? []).map((v) => ({ ...v, lessonId: lesson.id, levelId: lesson.levelId, blockId: lesson.blockId }));
  const fresh = newItemsForLesson(words, store.data.srs);

  // сначала узнавание и слух, потом активное воспроизведение, потом упражнения урока
  const queue = [];
  for (const w of words) { queue.push({ ex: recognizeEx(w, poolList), word: w }); }
  for (const w of words) { queue.push({ ex: listenEx(w, poolList), word: w }); }
  for (const w of words) { queue.push({ ex: produceEx(w), word: w }); }
  for (const e of lesson.exercises ?? []) queue.push({ ex: e, word: null });
  if (lesson.reading) for (const q of readingQuestions(lesson.reading)) queue.push({ ex: q, word: null });
  const vset = lesson.reading ? await vocabSetFor(lesson.levelId) : new Set();

  const results = [];
  const retry = [];
  let i = 0;
  let phase = 'explain';

  function frame(...kids) {
    fill($main, 
      h('a', { href: '#/program', class: 'muted' }, '← К программе'),
      h('h1', {}, lesson.title),
      ...kids,
    );
    window.scrollTo(0, 0);
  }

  function showExplain() {
    frame(
      h('div', { class: 'card' }, h('b', {}, 'Цель урока: '), lesson.goal,
        h('p', { class: 'muted' }, fresh.length ? 'Новых слов: ' + fresh.length + ' из ' + words.length : 'Слова этого урока вы уже встречали, будет повторение.')),
      h('div', { class: 'card' }, lesson.explanation.map(renderBlock)),
      h('button', { class: 'btn wide', type: 'button', onclick: () => (fresh.length ? showVocab(0) : afterVocab()) }, fresh.length ? 'К новым словам' : 'К упражнениям'),
    );
  }

  function showVocab(n) {
    const w = fresh[n];
    const last = n === fresh.length - 1;
    frame(
      h('div', { class: 'progress', 'aria-label': 'Слова' }, h('i', { style: 'width:' + Math.round(((n + 1) / fresh.length) * 100) + '%' })),
      h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('span', { class: 'tag' }, 'Слово ' + (n + 1) + ' из ' + fresh.length), h('span', { class: 'muted' }, w.pos)),
        h('div', { class: 'big-en' }, w.en),
        h('div', { class: 'row' }, audioBtn(w.en), h('span', { class: 'ipa' }, w.ipa)),
        h('p', {}, h('b', {}, w.ru)),
        h('div', { class: 'hl' }, h('div', { class: 'row' }, audioBtn(w.example, 'Прослушать пример'), h('div', {}, h('div', { class: 'en' }, w.example), h('div', { class: 'muted' }, w.exampleRu)))),
        w.collocations?.length ? h('p', { class: 'muted' }, 'Часто вместе: ' + w.collocations.join(', ')) : null,
        w.note ? h('p', { class: 'muted' }, w.note) : null,
      ),
      h('div', { class: 'row' },
        n > 0 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => showVocab(n - 1) }, 'Назад') : null,
        h('button', { class: 'btn', type: 'button', style: 'flex:1', onclick: () => (last ? afterVocab() : showVocab(n + 1)) }, last ? 'К упражнениям' : 'Дальше')),
    );
  }

  function afterVocab() {
    if (!lesson.dialogue && !lesson.reading) return showPractice();
    frame(
      lesson.dialogue ? dialogueCard(lesson.dialogue) : null,
      lesson.reading ? readingCard(lesson.reading, vset) : null,
      h('button', { class: 'btn wide', type: 'button', onclick: showPractice }, 'К упражнениям'),
    );
  }

  function showPractice() {
    phase = 'practice';
    next();
  }

  function next() {
    const total = queue.length + retry.length;
    const current = i < queue.length ? queue[i] : null;
    if (!current) {
      if (retry.length) { queue.push(...retry.splice(0)); return next(); }
      return showResult();
    }
    const bar = h('div', { class: 'progress', style: 'margin-bottom:12px' }, h('i', { style: 'width:' + Math.round((i / queue.length) * 100) + '%' }));
    frame(runExercise(current.ex, {
      showProgress: bar,
      onDone: (res) => {
        const first = !current.retry;
        if (first) results.push(res.correct);
        recordAnswer(current.word, current.ex, res);
        if (first) {
          const sk = skillOf(current.ex, lesson);
          recordSkill(sk, res.correct);
          if (sk === 'grammar' && current.ex.topic) recordGrammar(current.ex, res.correct);
        }
        store.save();
        if (!res.correct && first) retry.push({ ...current, retry: true });
        i += 1;
        next();
      },
    }));
  }

  function showResult() {
    const ok = results.filter(Boolean).length;
    const score = results.length ? Math.round((ok / results.length) * 100) : 100;
    const prev = store.data.completedLessons[lesson.id];
    store.data.completedLessons[lesson.id] = { at: Date.now(), score: Math.max(score, prev?.score ?? 0) };
    logEvent('lesson', { lessonId: lesson.id, score });
    store.save();
    const due = dueItems(store.data.srs).length;
    frame(
      h('div', { class: 'card' },
        h('h2', {}, 'Урок пройден'),
        h('p', {}, 'Результат с первой попытки: ' + score + '% (' + ok + ' из ' + results.length + ').'),
        score < 70 ? h('p', { class: 'muted' }, 'Это ниже 70%. Загляните в объяснение ещё раз и пройдите урок повторно, слова будут повторяться по расписанию.') : h('p', { class: 'muted' }, 'Новые слова добавлены в повторение. Первое повторение появится завтра, ошибки вернутся раньше.'),
        due ? h('p', {}, 'Сейчас к повторению: ' + due) : null),
      h('div', { class: 'row' },
        h('a', { class: 'btn secondary', href: '#/program' }, 'К программе'),
        h('a', { class: 'btn', href: '#/home' }, 'На главную')),
    );
  }

  showExplain();
}

// ---------- повторение ----------

async function reviewView() {
  const dueAll = dueItems(store.data.srs);
  const lessonIds = [...new Set(dueAll.map((s) => s.lessonId))];
  const map = await loadVocabMap(lessonIds);
  const due = dueAll.filter((s) => map[s.id]).slice(0, 20);
  const pool = Object.values(map);

  if (!due.length) {
    fill($main, h('h1', {}, 'Повторение'), h('div', { class: 'card' },
      h('p', {}, 'Сейчас повторять нечего.'),
      h('p', { class: 'muted' }, Object.keys(store.data.srs).length ? 'Следующие слова придут по расписанию. Загляните завтра.' : 'Здесь появятся слова после первого пройденного урока.'),
      h('a', { class: 'btn', href: '#/program' }, 'К программе')));
    return;
  }

  let i = 0;
  let okCount = 0;
  const step = () => {
    if (i >= due.length) return finishReview();
    const state = store.data.srs[due[i].id];
    const word = map[state.id];
    const ex = reviewEx(word, state, pool);
    const bar = h('div', { class: 'progress', style: 'margin-bottom:12px' }, h('i', { style: 'width:' + Math.round((i / due.length) * 100) + '%' }));
    fill($main, h('h1', {}, 'Повторение'), h('p', { class: 'muted' }, (i + 1) + ' из ' + due.length), runExercise(ex, {
      showProgress: bar,
      onDone: (res) => {
        recordAnswer(word, ex, res);
        if (res.correct) okCount += 1;
        store.save();
        i += 1;
        step();
      },
    }));
  };
  const finishReview = () => {
    logEvent('review', { count: due.length, ok: okCount });
    store.save();
    const left = dueItems(store.data.srs).length;
    fill($main, h('h1', {}, 'Повторение завершено'), h('div', { class: 'card' },
      h('p', {}, 'Верно: ' + okCount + ' из ' + due.length + '.'),
      h('p', { class: 'muted' }, 'Неверные слова вернутся через несколько минут, верные уйдут на более длинный интервал.'),
      left ? h('a', { class: 'btn', href: '#/review' }, 'Ещё повторение (' + left + ')') : h('a', { class: 'btn', href: '#/home' }, 'На главную')));
  };
  step();
}

// ---------- главная, программа, словарь, статистика, настройки ----------

function nextLesson(course) {
  return course.lessons.find((l) => !store.data.completedLessons[l.id]) ?? null;
}

async function homeView() {
  const course = await loadCourse();
  const nl = nextLesson(course);
  const due = dueItems(store.data.srs).length;
  const learned = Object.keys(store.data.srs).length;
  const done = Object.keys(store.data.completedLessons).length;
  const lvl = course.levels.find((l) => l.id === store.data.level);
  const inLevel = course.lessons.filter((l) => l.levelId === store.data.level);
  const doneInLevel = inLevel.filter((l) => store.data.completedLessons[l.id]).length;
  const rec = await recommendationCard();
  fill($main, 
    h('h1', {}, 'Здравствуйте!'),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('b', {}, 'Уровень: ' + (lvl?.title ?? store.data.level)), h('span', { class: 'muted' }, doneInLevel + ' из ' + inLevel.length + ' уроков')),
      h('div', { class: 'progress', style: 'margin-top:10px' }, h('i', { style: 'width:' + (inLevel.length ? Math.round((doneInLevel / inLevel.length) * 100) : 0) + '%' }))),
    nl
      ? h('div', { class: 'card' }, h('span', { class: 'tag' }, done ? 'Продолжить' : 'Начать с нуля'), h('h2', { style: 'margin-top:8px' }, nl.title), h('p', { class: 'muted' }, nl.summary), h('a', { class: 'btn', href: '#/lesson/' + nl.id }, done ? 'Продолжить урок' : 'Начать первый урок'))
      : h('div', { class: 'card' }, h('p', {}, 'Все доступные уроки пройдены. Новые уроки добавляются по мере развития курса.')),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('div', {}, h('b', {}, 'Повторение на сегодня'), h('div', { class: 'muted' }, due ? 'Слов к повторению: ' + due : 'Пока ничего не накопилось')), due ? h('a', { class: 'btn', href: '#/review' }, 'Повторить') : null)),
    rec,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(done)), 'уроков пройдено'),
      h('div', { class: 'stat' }, h('b', {}, String(learned)), 'слов изучено'),
      h('div', { class: 'stat' }, h('b', {}, String(streak())), 'дней подряд')),
    !ttsSupported() ? h('div', { class: 'warn' }, 'Этот браузер не умеет озвучивать текст, кнопки со звуком будут сообщать об этом. Попробуйте Chrome, Safari или Edge.') : null,
    !store.persistent ? h('div', { class: 'warn' }, 'Браузер не разрешает сохранять данные (приватный режим?). Прогресс пропадёт при закрытии вкладки, сохраняйте резервную копию в «Настройках».') : null,
  );
}

function streak() {
  const days = new Set(store.data.log.map((e) => e.day));
  let n = 0;
  const d = new Date();
  if (!days.has(d.toISOString().slice(0, 10))) d.setTime(d.getTime() - DAY);
  while (days.has(d.toISOString().slice(0, 10))) { n += 1; d.setTime(d.getTime() - DAY); }
  return n;
}

async function programView() {
  const course = await loadCourse();
  fill($main, 
    h('h1', {}, 'Программа обучения'),
    h('p', { class: 'muted' }, 'Идите по порядку: каждый урок опирается на предыдущие. Уровни после доступного пока в разработке.'),
    ...course.levels.map((lv) => {
      const lessons = course.lessons.filter((l) => l.levelId === lv.id);
      return h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, lv.title), h('span', { class: 'tag' }, lv.cefr)),
        h('p', {}, lv.goal),
        lv.status === 'planned'
          ? h('p', { class: 'muted' }, 'Пока в разработке. Темы: ' + lv.topics.join(', ') + '.')
          : lessons.map((l, idx) => {
              const done = store.data.completedLessons[l.id];
              return h('a', { class: 'lesson-link', href: '#/lesson/' + l.id, style: 'padding:10px 0;border-top:1px solid var(--line)' },
                h('div', { class: 'row spread' }, h('b', {}, (idx + 1) + '. ' + l.title), done ? h('span', { class: 'tag done' }, done.score + '%') : h('span', { class: 'tag' }, 'новый')),
                h('div', { class: 'muted' }, l.summary));
            }));
    }),
  );
}

async function vocabView() {
  const ids = Object.keys(store.data.srs);
  const lessonIds = [...new Set(Object.values(store.data.srs).map((s) => s.lessonId))];
  const map = await loadVocabMap(lessonIds);
  const q = h('input', { type: 'text', placeholder: 'Поиск по слову или переводу', 'aria-label': 'Поиск' });
  const list = h('div');
  const status = (s) => (isMastered(s) ? 'освоено' : s.active.ok > 0 ? 'вспоминаете' : 'узнаёте');
  const draw = () => {
    const f = q.value.trim().toLowerCase();
    const rows = ids.map((id) => ({ w: map[id], s: store.data.srs[id] })).filter((r) => r.w && (!f || r.w.en.toLowerCase().includes(f) || r.w.ru.toLowerCase().includes(f)));
    fill(list, ...(rows.length ? rows.map(({ w, s }) => h('div', { class: 'card row spread' },
      h('div', { class: 'row' }, audioBtn(w.en), h('div', {}, h('div', { class: 'en' }, w.en + '  ', h('span', { class: 'ipa' }, w.ipa)), h('div', { class: 'muted' }, w.ru))),
      h('span', { class: 'tag' + (isMastered(s) ? ' done' : '') }, status(s)))) : [h('p', { class: 'muted' }, ids.length ? 'Ничего не найдено.' : 'Слова появятся здесь после первого урока.')]));
  };
  q.addEventListener('input', draw);
  fill($main, h('h1', {}, 'Словарь'), h('p', { class: 'muted' }, 'Изучено слов: ' + ids.length), q, list);
  draw();
}

async function statsView() {
  const states = Object.values(store.data.srs);
  const mastered = states.filter(isMastered).length;
  const active = states.filter((s) => s.active.ok > 0).length;
  const recent = states.flatMap((s) => s.history).sort((a, b) => b.t - a.t).slice(0, 100);
  const acc = recent.length ? Math.round((recent.filter((r) => r.ok).length / recent.length) * 100) : null;
  const grammar = Object.entries(store.data.grammar);
  fill($main, 
    h('h1', {}, 'Статистика'),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(Object.keys(store.data.completedLessons).length)), 'уроков'),
      h('div', { class: 'stat' }, h('b', {}, String(states.length)), 'слов изучается'),
      h('div', { class: 'stat' }, h('b', {}, String(active)), 'вспоминаете сами'),
      h('div', { class: 'stat' }, h('b', {}, String(mastered)), 'освоено'),
      h('div', { class: 'stat' }, h('b', {}, acc == null ? '—' : acc + '%'), 'точность за 100 ответов'),
      h('div', { class: 'stat' }, h('b', {}, String(streak())), 'дней подряд')),
    h('p', { class: 'muted' }, '«Освоено» значит: слово вспоминается без вариантов, интервал не меньше 21 дня, последние ответы верные.'),
    h('h2', {}, 'Навыки'),
    Object.keys(store.data.skills ?? {}).length ? h('div', { class: 'card' }, Object.entries(SKILL_NAMES).map(([k, name]) => { const st = (store.data.skills ?? {})[k]; return h('div', { class: 'row spread' }, h('span', {}, name), h('span', { class: 'muted' }, st ? pct(st) + '% (' + st.ok + ' из ' + st.total + ')' : 'нет данных')); })) : h('p', { class: 'muted' }, 'Появятся после первых упражнений.'),
    h('h2', {}, 'Контрольные'),
    store.data.tests.length ? h('div', { class: 'card' }, store.data.tests.slice(-5).reverse().map((t) => h('div', { class: 'row spread' }, h('span', { class: 'muted' }, new Date(t.at).toLocaleDateString('ru-RU')), h('span', { class: t.passed ? 'tag done' : 'tag' }, t.score + '% · ' + (t.passed ? 'зачёт' : 'не зачёт'))))) : h('p', { class: 'muted' }, 'Пока не проходили.'),
    h('h2', {}, 'Грамматика'),
    grammar.length ? h('div', { class: 'card' }, grammar.map(([t, g]) => h('div', { class: 'row spread' }, h('span', {}, t), h('span', { class: 'muted' }, g.ok + ' из ' + g.total + ' (' + Math.round((g.ok / g.total) * 100) + '%)')))) : h('p', { class: 'muted' }, 'Появится после упражнений по грамматике.'),
    h('h2', {}, 'Последние ошибки'),
    store.data.mistakes.length ? h('div', { class: 'card' }, store.data.mistakes.slice(0, 8).map((m) => h('div', {}, m.itemId + (m.given ? ': вы ответили «' + m.given + '»' : '')))) : h('p', { class: 'muted' }, 'Ошибок пока нет.'),
  );
}

function settingsView() {
  const s = store.data.settings;
  const sel = (label, key, options) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: String(s[key]) === v }, t)));
    el.addEventListener('change', () => { s[key] = key === 'rate' ? Number(el.value) : el.value; store.save(); applyTheme(); });
    return h('label', { class: 'card', style: 'display:block' }, h('b', {}, label), h('div', { style: 'margin-top:8px' }, el));
  };
  const file = h('input', { type: 'file', accept: 'application/json', style: 'display:none' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    const r = store.importJSON(await f.text());
    toast(r.ok ? 'Прогресс восстановлен' : 'Не получилось: ' + r.error);
    if (r.ok) { applyTheme(); settingsView(); }
  });
  fill($main, 
    h('h1', {}, 'Настройки'),
    sel('Тема', 'theme', [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']]),
    sel('Произношение', 'accent', [['en-GB', 'Британское'], ['en-US', 'Американское']]),
    sel('Скорость речи', 'rate', [['0.7', 'Медленно'], ['0.9', 'Спокойно'], ['1', 'Обычно']]),
    h('div', { class: 'card' },
      h('b', {}, 'Резервная копия прогресса'),
      h('p', { class: 'muted' }, 'Прогресс хранится в этом браузере на этом устройстве. Если очистить данные сайта, он пропадёт. Скачайте копию и храните у себя; на другом устройстве её можно загрузить обратно.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => {
          const blob = new Blob([store.exportJSON()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'english-path-' + todayKey() + '.json' });
          a.click();
          URL.revokeObjectURL(a.href);
        } }, 'Скачать копию'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => file.click() }, 'Загрузить копию'), file)),
    h('div', { class: 'card' },
      h('b', {}, 'Сбросить всё'),
      h('p', { class: 'muted' }, 'Удалит прогресс из этого браузера. Сначала скачайте копию.'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => {
        if (confirm('Точно удалить весь прогресс? Это нельзя отменить.')) {
          Object.assign(store.data, JSON.parse(JSON.stringify({ ...store.data, completedLessons: {}, srs: {}, grammar: {}, tests: [], mistakes: [], personalWords: [], bookmarks: [], log: [] })));
          store.save();
          toast('Прогресс удалён');
          location.hash = '#/home';
        }
      } }, 'Удалить прогресс')),
  );
}

// ---------- разделы: ещё, грамматика, чтение, аудирование, диалоги, письмо, контрольные ----------

function moreView() {
  const items = [
    ['grammar', 'Грамматика', 'Объяснения на русском и тренировка слабых тем'],
    ['reading', 'Чтение', 'Тексты по уровню, озвучка и вопросы на понимание'],
    ['listening', 'Аудирование', 'Диктанты и узнавание слов на слух'],
    ['talk', 'Диалоги и письмо', 'Диалоги по ролям и письменные задания'],
    ['tests', 'Контрольные работы', 'Проверка пройденного блока и допуск на следующий уровень'],
    ['stats', 'Статистика', 'Прогресс, навыки, история контрольных'],
    ['settings', 'Настройки', 'Тема, озвучка, резервная копия прогресса'],
  ];
  fill($main, h('h1', {}, 'Ещё'), ...items.map(([id, t, d]) => h('a', { class: 'card lesson-link', href: '#/' + id }, h('b', {}, t), h('div', { class: 'muted' }, d))));
}

async function grammarView() {
  const { lessons } = await loadAllLessons();
  const weak = weakTopics(lessons);
  const cards = lessons.filter((l) => l.grammar).map((l) => {
    const topics = [...new Set((l.exercises ?? []).filter((e) => e.topic).map((e) => e.topic))];
    const done = lessonDone(l.id);
    return h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, l.title), h('span', { class: done ? 'tag done' : 'tag' }, done ? 'пройден' : 'не пройден')),
      h('p', { class: 'muted' }, l.goal),
      ...topics.map((t) => {
        const st = store.data.grammar[t];
        return h('div', { class: 'row spread', style: 'padding:6px 0;border-top:1px solid var(--line)' },
          h('span', {}, t),
          h('span', { class: 'row' },
            h('span', { class: 'muted' }, st ? pct(st) + '% (' + st.ok + ' из ' + st.total + ')' : 'нет данных'),
            done ? h('a', { class: 'btn secondary', href: '#/drill/' + encodeURIComponent(t), style: 'min-height:36px;padding:6px 12px' }, 'Тренировать') : null));
      }),
      h('div', { style: 'margin-top:10px' }, h('a', { class: 'btn ghost', href: '#/explain/' + l.id }, 'Прочитать объяснение')));
  });
  fill($main,
    h('h1', {}, 'Грамматика'),
    h('p', { class: 'muted' }, 'Объяснения собраны из уроков. Тренировка берёт упражнения только из пройденных уроков.'),
    weak.length ? h('div', { class: 'warn' }, h('b', {}, 'Слабые темы: '), weak.map((w) => w.topic + ' (' + w.pct + '%)').join(', '), '. Потренируйте их ниже.') : null,
    ...cards);
}

async function explainView(lessonId) {
  const l = await loadLesson(lessonId);
  fill($main,
    h('a', { href: '#/grammar', class: 'muted' }, '← К грамматике'),
    h('h1', {}, l.title),
    h('div', { class: 'card' }, l.explanation.map(renderBlock)),
    h('a', { class: 'btn', href: '#/lesson/' + l.id }, 'Открыть урок с упражнениями'));
}

async function drillView(topic) {
  const { lessons } = await loadAllLessons();
  const pool = lessons.filter((l) => l.grammar && lessonDone(l.id)).flatMap((l) => (l.exercises ?? []).filter((e) => e.topic === topic).map((e) => ({ ...e, skill: 'grammar' })));
  if (!pool.length) {
    fill($main, h('h1', {}, 'Тренировка'), h('div', { class: 'card' }, h('p', {}, 'По теме «' + topic + '» пока нет упражнений из пройденных уроков.'), h('a', { class: 'btn', href: '#/grammar' }, 'К грамматике')));
    return;
  }
  const list = shuffled(pool).slice(0, 10);
  session(list, {
    title: 'Тренировка: ' + topic, backHref: '#/grammar',
    onEach: (ex, res) => { recordGrammar(ex, res.correct); recordSkill('grammar', res.correct); store.save(); },
    onFinish: (results) => { logEvent('drill', { topic }); store.save(); summaryView('Тренировка завершена', results, { backHref: '#/grammar', backLabel: 'К грамматике', againHref: '#/drill/' + encodeURIComponent(topic) }); },
  });
}

async function readingListView() {
  const course = await loadCourse();
  const { lessons } = await loadAllLessons();
  const extra = await loadReadings();
  const items = [
    ...lessons.filter((l) => l.reading).map((l) => ({ id: 'lesson:' + l.id, title: l.reading.title, minutes: l.reading.minutes, requires: [l.id] })),
    ...extra.map((r) => ({ id: r.id, title: r.title, minutes: r.minutes, requires: r.requires })),
  ];
  const reads = store.data.reads ?? {};
  fill($main,
    h('h1', {}, 'Чтение'),
    h('p', { class: 'muted' }, 'Тексты Pre-A1 написаны только на изученных конструкциях. Слушайте, читайте, переводите по необходимости.'),
    ...items.map((it) => {
      const open = allDone(it.requires);
      const r = reads[it.id];
      return h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, it.title), h('span', { class: r ? 'tag done' : 'tag' }, r ? r.score + '%' : 'Pre-A1 · ~' + (it.minutes ?? 1) + ' мин')),
        open ? h('div', { style: 'margin-top:10px' }, h('a', { class: 'btn', href: '#/read/' + encodeURIComponent(it.id) }, r ? 'Прочитать ещё раз' : 'Читать')) : lockedNote(course, it.requires));
    }));
}

async function readView(id) {
  const { lessons } = await loadAllLessons();
  const extra = await loadReadings();
  let r, levelId = 'preA1';
  if (id.startsWith('lesson:')) { const l = lessons.find((x) => x.id === id.slice(7)); r = l?.reading; levelId = l?.levelId ?? levelId; }
  else r = extra.find((x) => x.id === id);
  if (!r) throw new Error('Текст не найден');
  const vset = await vocabSetFor(levelId);
  const go = h('button', { class: 'btn wide', type: 'button' }, 'Ответить на вопросы');
  go.addEventListener('click', () => session(readingQuestions(r), {
    title: r.title, backHref: '#/reading',
    onEach: (ex, res) => { recordSkill('reading', res.correct); },
    onFinish: (results) => {
      const ok = results.filter((x) => x.res.correct).length;
      (store.data.reads ??= {})[id] = { at: Date.now(), score: Math.round((ok / results.length) * 100) };
      logEvent('reading', { id }); store.save();
      summaryView('Вопросы к тексту', results, { backHref: '#/reading', backLabel: 'К текстам' });
    },
  }));
  fill($main, h('a', { href: '#/reading', class: 'muted' }, '← К текстам'), h('h1', {}, r.title), readingCard(r, vset), go);
}

async function listeningView() {
  const states = Object.values(store.data.srs);
  const map = await loadVocabMap([...new Set(states.map((s) => s.lessonId))]);
  const words = states.map((s) => map[s.id]).filter(Boolean);
  const start = (kind) => {
    const ws = shuffled(words);
    const list = kind === 'dictation'
      ? ws.slice(0, 8).map((w) => ({ id: 'dict:' + w.id, type: 'type', skill: 'listening', topic: 'Диктант', audio: w.example, prompt: 'Напишите предложение, которое услышали', accepted: [w.example], explain: w.example + ' — ' + w.exampleRu }))
      : ws.slice(0, 10).map((w) => listenEx(w, words));
    session(list, {
      title: kind === 'dictation' ? 'Диктант' : 'Слова на слух', backHref: '#/listening',
      onEach: (ex, res) => { recordSkill('listening', res.correct); store.save(); },
      onFinish: (results) => { logEvent('listening', { kind }); store.save(); summaryView('Аудирование завершено', results, { backHref: '#/listening', backLabel: 'К аудированию' }); },
    });
  };
  fill($main,
    h('h1', {}, 'Аудирование'),
    h('p', { class: 'muted' }, 'Звук создаёт синтезатор речи вашего устройства. Скорость и акцент меняются в настройках. Диктовка и узнавание берут слова, которые вы уже изучали.'),
    words.length < 4
      ? h('div', { class: 'card' }, h('p', {}, 'Откроется после первого урока: нужно хотя бы 4 изученных слова.'), h('a', { class: 'btn', href: '#/program' }, 'К программе'))
      : [
        h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Диктант'), h('p', { class: 'muted' }, 'Прослушайте предложение и напишите его. Регистр и пунктуация не важны.'), h('button', { class: 'btn', type: 'button', onclick: () => start('dictation') }, 'Начать диктант (8)')),
        h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Слово на слух'), h('p', { class: 'muted' }, 'Услышьте слово и выберите его среди похожих.'), h('button', { class: 'btn', type: 'button', onclick: () => start('words') }, 'Начать (10)')),
      ],
    h('p', { class: 'muted' }, 'Сейчас озвучка идёт голосом браузера. Записей живых носителей в этой версии нет.'));
}

async function talkView() {
  const course = await loadCourse();
  const { lessons } = await loadAllLessons();
  const writing = store.data.writing ?? [];
  fill($main,
    h('h1', {}, 'Диалоги и письмо'),
    h('h2', {}, 'Диалоги'),
    ...lessons.filter((l) => l.dialogue).map((l) => h('div', { class: 'card' },
      h('b', {}, l.dialogue.title), h('div', { class: 'muted' }, 'Урок: ' + l.title),
      lessonDone(l.id) ? h('div', { style: 'margin-top:10px' }, h('a', { class: 'btn', href: '#/dialogue/' + l.id }, 'Открыть')) : lockedNote(course, [l.id]))),
    h('h2', {}, 'Письменные задания'),
    ...(course.writing ?? []).map((w) => {
      const done = writing.some((x) => x.id === w.id && x.ok);
      return h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('b', {}, w.title), h('span', { class: done ? 'tag done' : 'tag' }, done ? 'выполнено' : 'не выполнено')),
        allDone(w.requires) ? h('div', { style: 'margin-top:10px' }, h('a', { class: 'btn', href: '#/write/' + w.id }, 'Писать')) : lockedNote(course, w.requires));
    }));
}

async function dialogueView(lessonId) {
  const l = await loadLesson(lessonId);
  const d = l.dialogue;
  if (!d) throw new Error('В этом уроке нет диалога');
  const speakers = [...new Set(d.lines.map((x) => x.who))];
  const play = (who) => {
    const list = [];
    d.lines.forEach((ln, k) => {
      if (ln.who !== who) return;
      const prev = d.lines[k - 1];
      const others = shuffled(d.lines.filter((x) => x.en !== ln.en).map((x) => x.en)).slice(0, 2);
      const options = shuffled([ln.en, ...others]);
      list.push({
        id: 'role:' + k, type: 'choice', topic: 'Диалог', skill: 'vocabulary', prompt: 'Выберите вашу реплику (' + who + ')',
        context: prev ? prev.who + ': ' + prev.en : 'Вы начинаете разговор.', contextSpeak: prev?.en,
        options, answer: options.indexOf(ln.en), explain: '«' + ln.en + '» — ' + ln.ru,
      });
    });
    session(list, {
      title: 'Диалог: роль ' + who, backHref: '#/dialogue/' + lessonId,
      onFinish: (results) => { logEvent('dialogue', { lessonId }); store.save(); summaryView('Диалог сыгран', results, { backHref: '#/dialogue/' + lessonId, backLabel: 'К диалогу' }); },
    });
  };
  fill($main,
    h('a', { href: '#/talk', class: 'muted' }, '← Назад'),
    h('h1', {}, l.title),
    dialogueCard(d),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Сыграть роль'), h('p', { class: 'muted' }, 'Собеседник говорит, вы выбираете свою реплику.'),
      h('div', { class: 'row' }, ...speakers.map((s) => h('button', { class: 'btn secondary', type: 'button', onclick: () => play(s) }, 'Я — ' + s)))));
}

async function writeView(id) {
  const course = await loadCourse();
  const w = (course.writing ?? []).find((x) => x.id === id);
  if (!w) throw new Error('Задание не найдено');
  const area = h('textarea', { rows: '6', 'aria-label': 'Ваш текст', spellcheck: 'false', placeholder: 'Пишите по-английски здесь' });
  const out = h('div');
  const btn = h('button', { class: 'btn', type: 'button' }, 'Проверить');
  btn.addEventListener('click', () => {
    const text = area.value.trim();
    if (text.length < 10) return toast('Напишите хотя бы одно предложение');
    const norm = text.replace(/[’‘`´]/g, "'");
    const res = w.checks.map((c) => ({ label: c.label, ok: new RegExp(c.pattern, c.flags ?? '').test(norm) }));
    const ok = res.every((r) => r.ok);
    const log = (store.data.writing ??= []);
    log.unshift({ id: w.id, at: Date.now(), text, ok });
    log.length = Math.min(log.length, 30);
    logEvent('writing', { id: w.id, ok }); store.save();
    fill(out,
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, ok ? 'Все признаки на месте' : 'Не хватает признаков'),
        ...res.map((r) => h('div', { class: 'row', style: 'padding:3px 0' }, h('b', { style: 'color:' + (r.ok ? 'var(--ok)' : 'var(--bad)') }, r.ok ? '✓' : '✗'), h('span', {}, r.label)))),
      h('div', { class: 'hl' }, h('b', {}, 'Образец: '), w.sample),
      h('p', { class: 'muted' }, 'Это проверка структуры по заданным признакам. Она не оценивает грамматику и естественность, поэтому сравните свой текст с образцом. Сказанное иначе не обязательно неверно.'));
  });
  fill($main, h('a', { href: '#/talk', class: 'muted' }, '← Назад'), h('h1', {}, w.title), h('div', { class: 'card' }, h('p', {}, w.prompt), area, h('div', { style: 'margin-top:10px' }, btn)), out);
}

function writingDone(meta, course) {
  const log = store.data.writing ?? [];
  return (meta.writingIds ?? []).filter((id) => log.some((x) => x.id === id && x.ok)).length;
}

async function testsView() {
  const course = await loadCourse();
  fill($main,
    h('h1', {}, 'Контрольные работы'),
    h('p', { class: 'muted' }, 'Правильные ответы показываются только после завершения. Проверяются слова, грамматика, чтение и аудирование на новых примерах, а ещё письменные задания.'),
    ...(course.tests ?? []).map((meta) => {
      const open = allDone(meta.lessonIds);
      const tries = store.data.tests.filter((t) => t.id === meta.id);
      const wd = writingDone(meta, course);
      return h('div', { class: 'card' },
        h('h2', { style: 'margin-top:0' }, meta.title),
        h('p', { class: 'muted' }, 'Письменные задания: ' + wd + ' из ' + (meta.writingIds?.length ?? 0) + ' выполнено.'),
        tries.length ? h('div', {}, ...tries.slice(-3).reverse().map((t) => h('div', { class: 'row spread' }, h('span', { class: 'muted' }, new Date(t.at).toLocaleDateString('ru-RU')), h('span', { class: t.passed ? 'tag done' : 'tag' }, t.score + '% · ' + (t.passed ? 'зачёт' : 'не зачёт'))))) : null,
        open ? h('div', { style: 'margin-top:10px' }, h('a', { class: 'btn', href: '#/test/' + meta.id }, tries.length ? 'Пройти ещё раз' : 'Начать')) : lockedNote(course, meta.lessonIds));
    }));
}

async function buildTest(meta) {
  const test = await loadTest(meta);
  const lessons = await Promise.all(meta.lessonIds.map(loadLesson));
  const words = lessons.flatMap((l) => (l.vocab ?? []).map((v) => ({ ...v, lessonId: l.id, levelId: l.levelId, blockId: l.blockId })));
  const mix = shuffled(words);
  const rec = mix.slice(0, 8).map((w) => recognizeEx(w, words));
  const prod = mix.slice(8, 16).map((w) => produceEx(w));
  const lis = mix.slice(16, 21).map((w) => listenEx(w, words));
  const reading = readingQuestions(test.reading);
  return { test, items: [...shuffled([...rec, ...prod, ...test.grammar]), ...reading, ...shuffled([...lis, ...test.listening])] };
}

async function testView(id) {
  const course = await loadCourse();
  const meta = (course.tests ?? []).find((t) => t.id === id);
  if (!meta) throw new Error('Контрольная не найдена');
  if (!allDone(meta.lessonIds)) return fill($main, h('h1', {}, meta.title), lockedNote(course, meta.lessonIds));
  const { test, items } = await buildTest(meta);
  const begin = () => session(items, {
    title: meta.title, backHref: '#/tests', exam: true,
    onFinish: (results) => finishTest(meta, test, results),
  });
  fill($main,
    h('a', { href: '#/tests', class: 'muted' }, '← Назад'), h('h1', {}, meta.title),
    h('div', { class: 'card' },
      h('p', {}, 'Вопросов: ' + items.length + '. Подсказок нет, ответы и разбор появятся после последнего вопроса.'),
      h('p', { class: 'muted' }, 'Чтобы засчитать блок: ' + Object.entries(test.passRule).map(([k, v]) => SKILL_NAMES[k] + ' от ' + v + '%').join(', ') + ' и выполненные письменные задания.'),
      h('button', { class: 'btn wide', type: 'button', onclick: begin }, 'Начать')));
}

function finishTest(meta, test, results) {
  const course = { tests: [meta] };
  const by = tallySkills(results, (ex) => skillOf(ex));
  for (const { ex, res } of results) {
    recordSkill(skillOf(ex), res.correct);
    if (skillOf(ex) === 'grammar' && ex.topic) recordGrammar(ex, res.correct);
    if (!res.correct) store.data.mistakes.unshift({ itemId: ex.itemId ?? ex.id, at: Date.now(), given: String(res.given ?? '') });
  }
  store.data.mistakes.length = Math.min(store.data.mistakes.length, 100);
  const total = results.length;
  const okAll = results.filter((r) => r.res.correct).length;
  const score = Math.round((okAll / total) * 100);
  const wd = writingDone(meta, course);
  const wTotal = meta.writingIds?.length ?? 0;
  const { rows: skillRows, passed } = evaluate(by, test.passRule, wd, wTotal);
  store.data.tests.push({ id: meta.id, at: Date.now(), score, passed, skills: by });
  logEvent('test', { id: meta.id, score });
  store.save();

  const wrong = results.filter((r) => !r.res.correct);
  const topics = [...new Set(wrong.map((r) => r.ex.topic).filter(Boolean))];
  const weakest = [...skillRows].filter((r) => !r.ok).sort((a, b) => a.p - b.p)[0];
  const advice = passed
    ? 'Блок засчитан. Можно двигаться дальше, а слова продолжат приходить на повторение.'
    : weakest
      ? 'Подтяните «' + SKILL_NAMES[weakest.skill] + '» (' + weakest.p + '% при нужных ' + weakest.need + '%): ' + ({ vocabulary: 'пройдите повторение слов', grammar: 'потренируйте слабые темы в грамматике', reading: 'прочитайте тексты в разделе «Чтение»', listening: 'сделайте несколько диктантов' }[weakest.skill]) + '.'
      : 'Выполните все письменные задания в разделе «Диалоги и письмо».';
  fill($main,
    h('h1', {}, passed ? 'Зачёт!' : 'Пока не зачтено'),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Общий результат: ' + score + '%'),
      ...skillRows.map((r) => h('div', { class: 'row spread', style: 'padding:6px 0;border-top:1px solid var(--line)' }, h('span', {}, SKILL_NAMES[r.skill] + ' (нужно ' + r.need + '%)'), h('span', { class: r.ok ? 'tag done' : 'tag' }, r.p + '% · ' + r.detail))),
      h('div', { class: 'row spread', style: 'padding:6px 0;border-top:1px solid var(--line)' }, h('span', {}, 'Письменные задания'), h('span', { class: wd === wTotal ? 'tag done' : 'tag' }, wd + ' из ' + wTotal)),
      h('p', { style: 'margin-top:12px' }, advice)),
    topics.length ? h('div', { class: 'warn' }, h('b', {}, 'Темы для повторения: '), topics.join(', ')) : null,
    h('h2', {}, 'Разбор ошибок (' + wrong.length + ')'),
    ...(wrong.length ? wrong.map(({ ex, res }) => h('div', { class: 'card' },
      h('b', {}, ex.prompt), ex.context ? h('div', { class: 'muted' }, ex.context) : null,
      h('div', {}, 'Ваш ответ: ' + (res.given ?? '—')), h('div', {}, 'Правильно: ' + res.expected),
      h('div', { class: 'muted' }, ex.explain),
      ex.lessonId ? h('a', { href: '#/lesson/' + ex.lessonId }, 'Повторить урок') : null)) : [h('p', { class: 'muted' }, 'Ошибок нет.')]),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/test/' + meta.id }, 'Пройти ещё раз'), h('a', { class: 'btn secondary', href: '#/tests' }, 'К контрольным')));
}

async function recommendationCard() {
  const { course, lessons } = await loadAllLessons();
  const weak = weakTopics(lessons)[0];
  if (weak) return h('div', { class: 'card' }, h('span', { class: 'tag' }, 'Рекомендация'), h('p', {}, 'Тема «' + weak.topic + '» даётся пока на ' + weak.pct + '%. Потренируйте её.'), h('a', { class: 'btn secondary', href: '#/drill/' + encodeURIComponent(weak.topic) }, 'Тренировать'));
  const t = (course.tests ?? []).find((x) => allDone(x.lessonIds) && !store.data.tests.some((a) => a.id === x.id && a.passed));
  if (t) return h('div', { class: 'card' }, h('span', { class: 'tag' }, 'Рекомендация'), h('p', {}, 'Все уроки блока пройдены. Пора проверить себя: «' + t.title + '».'), h('a', { class: 'btn secondary', href: '#/test/' + t.id }, 'К контрольной'));
  return null;
}


// ---------- навигация ----------

const NAV = [
  ['home', 'Главная', '🏠'], ['program', 'Курс', '🗺️'], ['review', 'Повтор', '🔁'],
  ['vocab', 'Словарь', '📖'], ['more', 'Ещё', '☰'],
];
// к какому пункту меню относится страница
const NAV_GROUP = {
  lesson: 'program', grammar: 'more', explain: 'more', drill: 'more', reading: 'more', read: 'more', listening: 'more',
  talk: 'more', dialogue: 'more', write: 'more', tests: 'more', test: 'more', stats: 'more', settings: 'more',
};

function drawNav(route) {
  fill($nav, ...NAV.map(([id, label, ic]) => h('a', { href: '#/' + id, 'aria-current': (NAV_GROUP[route] ?? route) === id ? 'page' : null }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), label)));
}

async function route() {
  stopSpeaking();
  const [, name = 'home', rawArg] = location.hash.split('/');
  const arg = rawArg ? decodeURIComponent(rawArg) : rawArg;
  playToken += 1;
  drawNav(name);
  try {
    if (name === 'home') await homeView();
    else if (name === 'program') await programView();
    else if (name === 'lesson') await lessonView(arg);
    else if (name === 'review') await reviewView();
    else if (name === 'vocab') await vocabView();
    else if (name === 'stats') await statsView();
    else if (name === 'settings') settingsView();
    else if (name === 'more') moreView();
    else if (name === 'grammar') await grammarView();
    else if (name === 'explain') await explainView(arg);
    else if (name === 'drill') await drillView(arg);
    else if (name === 'reading') await readingListView();
    else if (name === 'read') await readView(arg);
    else if (name === 'listening') await listeningView();
    else if (name === 'talk') await talkView();
    else if (name === 'dialogue') await dialogueView(arg);
    else if (name === 'write') await writeView(arg);
    else if (name === 'tests') await testsView();
    else if (name === 'test') await testView(arg);
    else location.hash = '#/home';
  } catch (e) {
    console.error(e);
    fill($main, h('h1', {}, 'Что-то пошло не так'), h('div', { class: 'warn' }, String(e.message ?? e)), h('a', { class: 'btn', href: '#/home' }, 'На главную'));
  }
  $main.focus({ preventScroll: true });
}

applyTheme();
window.addEventListener('hashchange', route);
// ссылка на ту же страницу, на которой мы уже стоим, не вызывает hashchange: перерисовываем сами
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#/"]');
  if (a && a.getAttribute('href') === location.hash) { e.preventDefault(); route(); }
});
route();
