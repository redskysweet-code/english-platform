// загрузка и проверка учебного контента
// контент лежит в json, логика приложения про него ничего не знает

const cache = new Map();

export async function loadJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error('Не удалось загрузить ' + path + ' (' + res.status + ')');
  const data = await res.json();
  cache.set(path, data);
  return data;
}

export const loadCourse = () => loadJSON('content/course.json');

export async function loadLesson(lessonId) {
  const course = await loadCourse();
  const meta = course.lessons.find((l) => l.id === lessonId);
  if (!meta) throw new Error('Нет такого урока: ' + lessonId);
  return loadJSON('content/' + meta.file);
}

export async function loadAllLessons() {
  const course = await loadCourse();
  const lessons = await Promise.all(course.lessons.map((m) => loadJSON('content/' + m.file)));
  return { course, lessons };
}

export async function loadReadings() {
  const course = await loadCourse();
  return course.readings ? loadJSON('content/' + course.readings.file) : [];
}

export const loadTest = async (meta) => loadJSON('content/' + meta.file);

/** все слова из нужных уроков в одной карте id -> слово */
export async function loadVocabMap(lessonIds) {
  const map = {};
  for (const id of lessonIds) {
    try {
      const lesson = await loadLesson(id);
      for (const v of lesson.vocab ?? []) map[v.id] = { ...v, lessonId: lesson.id, levelId: lesson.levelId, blockId: lesson.blockId };
    } catch {
      // урок мог исчезнуть из курса, пропускаю, чтобы повторение не падало целиком
    }
  }
  return map;
}

export const EX_TYPES = ['choice', 'type', 'gap', 'listen'];
export const SKILLS = ['vocabulary', 'grammar', 'reading', 'listening'];

/** проверка одного упражнения, возвращает список ошибок */
export function validateExercise(e, where) {
  const err = [];
  const need = (cond, msg) => { if (!cond) err.push(where + ' ' + (e?.id ?? '?') + ': ' + msg); };
  need(e && typeof e === 'object', 'не объект');
  if (!e || typeof e !== 'object') return err;
  need(EX_TYPES.includes(e.type), 'неизвестный тип ' + e.type);
  need(typeof e.id === 'string' && e.id, 'нет id');
  need(typeof e.prompt === 'string' && e.prompt, 'нет prompt');
  need(typeof e.explain === 'string' && e.explain, 'нет объяснения ответа');
  if (e.skill !== undefined) need(SKILLS.includes(e.skill), 'неизвестный skill ' + e.skill);
  if (e.type === 'choice' || e.type === 'listen') {
    need(Array.isArray(e.options) && e.options.length >= 2, 'мало вариантов');
    need(Number.isInteger(e.answer) && e.answer >= 0 && e.answer < (e.options?.length ?? 0), 'неверный answer');
    need(!e.options || new Set(e.options).size === e.options.length, 'повтор вариантов');
    if (e.type === 'listen') need(typeof e.audio === 'string' && e.audio, 'нет audio');
  } else {
    need(Array.isArray(e.accepted) && e.accepted.length > 0, 'нет accepted');
    if (e.type === 'gap') need(/_/.test(e.prompt ?? ''), 'в gap нет пропуска');
  }
  return err;
}

function validateTexts(l, err) {
  const need = (cond, msg) => { if (!cond) err.push(l.id + ': ' + msg); };
  if (l.dialogue) {
    need(Array.isArray(l.dialogue.lines) && l.dialogue.lines.length >= 2, 'в диалоге мало реплик');
    for (const ln of l.dialogue.lines ?? []) need(ln.who && ln.en && ln.ru, 'реплика без who/en/ru');
    need(new Set((l.dialogue.lines ?? []).map((x) => x.who)).size >= 2, 'в диалоге меньше двух говорящих');
  }
  if (l.reading) validateReading(l.reading, l.id, err);
}

export function validateReading(r, where, err = []) {
  const need = (cond, msg) => { if (!cond) err.push(where + ': ' + msg); };
  need(typeof r.title === 'string' && r.title, 'у текста нет названия');
  need(Array.isArray(r.sentences) && r.sentences.length >= 3, 'в тексте мало предложений');
  for (const s of r.sentences ?? []) need(s.en && s.ru, 'предложение без en/ru');
  need(Array.isArray(r.questions) && r.questions.length >= 2, 'у текста мало вопросов');
  for (const q of r.questions ?? []) err.push(...validateExercise(q, where + ' вопрос'));
  return err;
}

/** проверка структуры урока, возвращает список ошибок (пустой список значит все хорошо) */
export function validateLesson(l) {
  const err = [];
  const need = (cond, msg) => { if (!cond) err.push(l?.id + ': ' + msg); };
  need(l && typeof l === 'object', 'урок не объект');
  if (!l || typeof l !== 'object') return err;
  for (const k of ['id', 'levelId', 'blockId', 'title', 'goal']) need(typeof l[k] === 'string' && l[k], 'нет поля ' + k);
  need(Array.isArray(l.explanation) && l.explanation.length > 0, 'нет объяснения');
  const ids = new Set();
  for (const v of l.vocab ?? []) {
    for (const k of ['id', 'en', 'ru', 'pos', 'ipa', 'example', 'exampleRu']) need(typeof v[k] === 'string' && v[k], 'слово без поля ' + k + ' ' + (v.id ?? ''));
    need(!ids.has(v.id), 'повтор id слова ' + v.id);
    ids.add(v.id);
  }
  const exIds = new Set();
  for (const e of l.exercises ?? []) {
    need(!exIds.has(e.id), 'повтор id упражнения ' + e.id);
    exIds.add(e.id);
    err.push(...validateExercise(e, l.id));
  }
  validateTexts(l, err);
  return err;
}
