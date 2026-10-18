// интервальное повторение: упрощённая схема в духе SM-2
// я специально разделил "узнавание" и "активное воспроизведение",
// слово не считается освоенным, пока человек не вспомнил его сам

export const DAY = 24 * 60 * 60 * 1000;
export const MIN = 60 * 1000;

/** создаёт состояние элемента при первом знакомстве */
export function createState(item, now = Date.now()) {
  return {
    id: item.id,
    levelId: item.levelId,
    lessonId: item.lessonId,
    blockId: item.blockId ?? null,
    reps: 0,
    lapses: 0,
    ease: 2.3,
    interval: 0, // в днях
    due: now, // сразу доступно для первой проверки
    lastReview: null,
    recog: { ok: 0, total: 0 },
    active: { ok: 0, total: 0 },
    history: [],
  };
}

/**
 * результат ответа: { correct, active, hints, errors, ms }
 * active = true, если человек вводил/вспоминал сам (не выбирал из вариантов)
 */
export function review(state, result, now = Date.now()) {
  const s = structuredClone(state);
  const hints = result.hints ?? 0;
  const errors = result.errors ?? 0;
  const bucket = result.active ? s.active : s.recog;
  bucket.total += 1;
  s.history.push({ t: now, ok: !!result.correct, active: !!result.active, hints, errors, ms: result.ms ?? null });
  if (s.history.length > 50) s.history.shift();

  if (!result.correct) {
    s.lapses += 1;
    s.reps = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.interval = 0;
    s.due = now + 10 * MIN; // забытое возвращаем быстро
  } else {
    bucket.ok += 1;
    s.reps += 1;
    // подсказки и ошибки перед правильным ответом делают результат "трудным"
    const hard = hints > 0 || errors > 0;
    // слишком долгий ответ тоже считаем признаком шаткого знания
    const slow = result.ms != null && result.ms > 15000;
    if (hard || slow) s.ease = Math.max(1.3, s.ease - 0.08);
    else s.ease = Math.min(2.8, s.ease + 0.04);

    let next;
    if (s.reps === 1) next = 1;
    else if (s.reps === 2) next = 3;
    else next = Math.round(s.interval * s.ease);
    if (hard || slow) next = Math.max(1, Math.round(next * 0.6));
    s.interval = Math.max(next, s.interval > 0 && !hard ? s.interval + 1 : 1);
    s.due = now + s.interval * DAY;
  }
  s.lastReview = now;
  return s;
}

/** освоено = вспоминает сам, интервал уже длинный, ошибок в недавней истории нет */
export function isMastered(s) {
  if (s.active.ok < 2 || s.interval < 21) return false;
  const recent = s.history.slice(-3);
  return recent.length > 0 && recent.every((h) => h.ok);
}

export function isDue(s, now = Date.now()) {
  return s.lastReview !== null && s.due <= now;
}

/** то, что пора повторить: только уже виденные элементы, самые просроченные первыми */
export function dueItems(states, now = Date.now()) {
  return Object.values(states)
    .filter((s) => isDue(s, now))
    .sort((a, b) => a.due - b.due);
}

/** новый материал урока: всё, что ещё ни разу не проходили */
export function newItemsForLesson(lessonItems, states) {
  return lessonItems.filter((it) => !states[it.id] || states[it.id].lastReview === null);
}
