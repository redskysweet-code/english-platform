// озвучка через браузерный Web Speech API
// качество и набор голосов зависят от устройства, поэтому все ошибки возвращаем наружу

export function ttsSupported() {
  return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';
}

function loadVoices() {
  return new Promise((resolve) => {
    const synth = globalThis.speechSynthesis;
    const now = synth.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500); // на некоторых устройствах событие не приходит
  });
}

/** подбираем английский голос под нужный акцент (en-GB или en-US), иначе любой английский */
export async function pickVoice(accent = 'en-GB') {
  const voices = await loadVoices();
  const norm = (v) => v.lang.replace('_', '-');
  return (
    voices.find((v) => norm(v) === accent) ||
    voices.find((v) => norm(v).startsWith('en')) ||
    null
  );
}

/**
 * speak(text, { accent, rate }) -> { ok: true } или { ok: false, reason }
 * reason: 'unsupported' | 'no-voice' | 'error'
 */
export async function speak(text, { accent = 'en-GB', rate = 0.9 } = {}) {
  if (!ttsSupported()) return { ok: false, reason: 'unsupported' };
  const voice = await pickVoice(accent);
  if (!voice) return { ok: false, reason: 'no-voice' };
  const synth = globalThis.speechSynthesis;
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    u.onend = () => resolve({ ok: true });
    u.onerror = (e) => resolve({ ok: false, reason: e.error === 'canceled' || e.error === 'interrupted' ? 'cancelled' : 'error' });
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (ttsSupported()) globalThis.speechSynthesis.cancel();
}
