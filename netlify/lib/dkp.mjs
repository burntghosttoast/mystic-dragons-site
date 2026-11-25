// DKP: one balance per person (a main plus its alts), kept as a ledger of changes.
// Officers enter raid nights, awards and adjustments as drafts; approving the sheet
// makes them official. Weekly decay is added as a draft early each Tuesday.
//
//   dkp/settings     { cap, start, attendStart, attendEnd, decay }
//   dkp/state        { approved: {person: balance}, approvedAt, approvedBy, started: {person: true} }
//   dkp/tx/<id>      { id, at, person, delta, kind, status: draft|approved, night?, char?, item?, note?, by }
//   dkp/nights/<id>  { id, date, group, by, at }
//   dkp/sheets/<at>  snapshot of balances at each approval
// A character's person is its main: char.alt_of when set, otherwise its own key.

export const DEFAULTS = { cap: 100, start: 20, attendStart: 5, attendEnd: 5, decay: 5 };
const rid = () => Math.random().toString(36).slice(2, 8);
const stamp = (t = Date.now()) => new Date(t).toISOString();

export const personOf = c => (c && c.alt_of) || (c && c.key) || '';

export async function settings(s) {
  return { ...DEFAULTS, ...((await s.get('dkp/settings', { type: 'json' })) || {}) };
}
export async function state(s) {
  return { approved: {}, started: {}, ...((await s.get('dkp/state', { type: 'json' })) || {}) };
}

export async function allTx(s, status) {
  const { blobs } = await s.list({ prefix: 'dkp/tx/' });
  const list = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean);
  return list.filter(t => !status || t.status === status).sort((a, b) => a.at.localeCompare(b.at) || (a.ord || 0) - (b.ord || 0) || a.id.localeCompare(b.id));
}

// Balances after applying changes in order: gains stop at the cap, spending stops at 0.
export function apply(balances, txs, cap) {
  const out = { ...balances };
  for (const t of txs) {
    const cur = out[t.person] || 0;
    out[t.person] = t.delta >= 0 ? Math.min(cap, cur + t.delta) : Math.max(0, cur + t.delta);
  }
  return out;
}

export async function addTx(s, t) {
  const at = t.at || stamp();
  const id = `${at.replace(/[:.]/g, '')}-${rid()}`;
  const doc = { id, at, status: 'draft', ...t, at };
  await s.setJSON(`dkp/tx/${id}`, doc);
  return doc;
}

// Attendance for one raid night. Each person counts once even if several of their
// characters are listed. Bench gets both start and end points.
export async function recordNight(s, { date, group, start = [], end = [], bench = [], by }, charsByKey) {
  const cfg = await settings(s), st = await state(s);
  const drafts = await allTx(s, 'draft');
  const startedDraft = new Set(drafts.filter(t => t.kind === 'start').map(t => t.person));
  const night = { id: `${date}-${rid()}`, date, group: group || '', by, at: stamp() };
  await s.setJSON(`dkp/nights/${night.id}`, night);
  const people = new Map();
  const mark = (keys, field) => keys.forEach(k => { const c = charsByKey[k]; if (!c) return; const p = personOf(c); const e = people.get(p) || { char: c.key }; e[field] = true; people.set(p, e); });
  mark(start, 'start'); mark(end, 'end'); mark(bench, 'bench');
  // One timestamp for the whole night; ord keeps each person's lines in order.
  const at = stamp();
  let n = 0;
  for (const [person, e] of people) {
    const o = n * 3; n++;
    if (!st.started[person] && !startedDraft.has(person)) await addTx(s, { at, ord: o, person, delta: cfg.start, kind: 'start', night: night.id, char: e.char, note: 'Starting DKP', by });
    if (e.bench) { await addTx(s, { at, ord: o + 1, person, delta: cfg.attendStart + cfg.attendEnd, kind: 'bench', night: night.id, char: e.char, note: 'Benched', by }); continue; }
    if (e.start) await addTx(s, { at, ord: o + 1, person, delta: cfg.attendStart, kind: 'attend-start', night: night.id, char: e.char, by });
    if (e.end) await addTx(s, { at, ord: o + 2, person, delta: cfg.attendEnd, kind: 'attend-end', night: night.id, char: e.char, by });
  }
  return { night, people: people.size };
}

// The draft sheet: last approved balances plus every draft change.
export async function draftSheet(s) {
  const cfg = await settings(s), st = await state(s), drafts = await allTx(s, 'draft');
  return { cfg, st, drafts, balances: apply(st.approved, drafts, cfg.cap) };
}

export async function approve(s, by) {
  const { cfg, st, drafts, balances } = await draftSheet(s);
  const at = stamp();
  for (const t of drafts) { if (t.kind === 'start') st.started[t.person] = true; await s.setJSON(`dkp/tx/${t.id}`, { ...t, status: 'approved', approvedAt: at }); }
  const next = { ...st, approved: balances, approvedAt: at, approvedBy: by };
  await s.setJSON('dkp/state', next);
  await s.setJSON(`dkp/sheets/${at}`, { at, by, balances, changes: drafts.length, cap: cfg.cap });
  return { at, changes: drafts.length, people: Object.keys(balances).length };
}

// Weekly decay as draft lines, for everyone holding DKP. Runs early Tuesday.
export async function addDecay(s, by = 'Weekly decay', force = false) {
  const { cfg, balances } = await draftSheet(s);
  const week = stamp().slice(0, 10);
  const st = await state(s);
  if (st.lastDecay === week && !force) return 0;
  let n = 0;
  for (const [person, bal] of Object.entries(balances)) if (bal > 0) { await addTx(s, { person, delta: -cfg.decay, kind: 'decay', note: 'Weekly decay', by }); n++; }
  await s.setJSON('dkp/state', { ...st, lastDecay: week });
  return n;
}

// Wipes all DKP history and balances (settings and alt links stay). For clearing test data.
export async function resetAll(s) {
  let n = 0;
  for (const prefix of ['dkp/tx/', 'dkp/nights/', 'dkp/sheets/']) {
    const { blobs } = await s.list({ prefix });
    for (const b of blobs) { await s.delete(b.key); n++; }
  }
  await s.delete('dkp/state');
  return n;
}
