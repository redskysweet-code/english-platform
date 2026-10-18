// подсчёт результатов контрольной: отдельно от интерфейса, чтобы это можно было проверить тестами

/** results: [{ ex, res }]; skillOf: функция, определяющая навык вопроса */
export function tallySkills(results, skillOf) {
  const by = {};
  for (const { ex, res } of results) {
    const s = skillOf(ex);
    const b = (by[s] ??= { ok: 0, total: 0 });
    b.total += 1;
    if (res.correct) b.ok += 1;
  }
  return by;
}

/**
 * passRule: { навык: минимальный процент }
 * зачёт только если каждый навык достиг своего порога и выполнены все письменные задания
 * навык без единого вопроса считается не сданным: нельзя получить зачёт, ничего не проверив
 */
export function evaluate(by, passRule, writingDone, writingTotal) {
  const rows = Object.entries(passRule).map(([skill, need]) => {
    const st = by[skill];
    const p = st && st.total ? Math.round((st.ok / st.total) * 100) : 0;
    return { skill, need, p, ok: !!st && st.total > 0 && p >= need, detail: st ? st.ok + ' из ' + st.total : 'нет вопросов' };
  });
  const writingOk = writingDone >= writingTotal;
  return { rows, writingOk, passed: rows.every((r) => r.ok) && writingOk };
}
