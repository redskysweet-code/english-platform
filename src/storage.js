// хранилище прогресса: localStorage + резервная копия в файл
// если localStorage недоступен (приватный режим), работаем в памяти и честно говорим об этом

export const SCHEMA_VERSION = 1;
const KEY = 'english-path:progress';

export function emptyProgress() {
  return {
    schema: SCHEMA_VERSION,
    profileId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    createdAt: Date.now(),
    level: 'preA1',
    completedLessons: {}, // lessonId -> { at, score }
    srs: {}, // itemId -> состояние из srs.js
    grammar: {}, // topicId -> { ok, total }
    tests: [], // история контрольных
    mistakes: [], // последние ошибки { itemId, at, given }
    personalWords: [],
    bookmarks: [],
    settings: { theme: 'auto', accent: 'en-GB', rate: 0.9 },
    log: [], // история занятий { at, type, lessonId }
  };
}

export function validateProgress(data) {
  if (!data || typeof data !== 'object') return 'это не объект';
  if (data.schema !== SCHEMA_VERSION) return 'неизвестная версия формата: ' + data.schema;
  for (const k of ['completedLessons', 'srs', 'grammar', 'settings']) {
    if (typeof data[k] !== 'object' || data[k] === null) return 'нет поля ' + k;
  }
  for (const k of ['tests', 'mistakes', 'personalWords', 'bookmarks', 'log']) {
    if (!Array.isArray(data[k])) return 'нет списка ' + k;
  }
  if (typeof data.profileId !== 'string') return 'нет profileId';
  return null;
}

export class Store {
  constructor(backend) {
    this.backend = backend ?? Store.pickBackend();
    this.persistent = this.backend.persistent;
    this.data = this.load();
  }

  static pickBackend() {
    try {
      const k = '__probe__';
      globalThis.localStorage.setItem(k, '1');
      globalThis.localStorage.removeItem(k);
      return {
        persistent: true,
        get: (key) => globalThis.localStorage.getItem(key),
        set: (key, v) => globalThis.localStorage.setItem(key, v),
      };
    } catch {
      const mem = new Map();
      return { persistent: false, get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
    }
  }

  load() {
    const raw = this.backend.get(KEY);
    if (!raw) return emptyProgress();
    try {
      const parsed = JSON.parse(raw);
      const err = validateProgress(parsed);
      if (err) throw new Error(err);
      return parsed;
    } catch {
      // битые данные не затираем молча: кладём копию рядом, потом начинаем с чистого
      this.backend.set(KEY + ':broken:' + Date.now(), raw);
      return emptyProgress();
    }
  }

  save() {
    this.backend.set(KEY, JSON.stringify(this.data));
  }

  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  }

  /** импорт с проверкой: при ошибке текущий прогресс остаётся нетронутым */
  importJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'файл не читается как JSON' };
    }
    const err = validateProgress(parsed);
    if (err) return { ok: false, error: err };
    this.data = parsed;
    this.save();
    return { ok: true };
  }
}
