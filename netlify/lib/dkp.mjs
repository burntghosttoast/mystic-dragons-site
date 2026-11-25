// DKP: one balance per person (a main plus its alts), kept as a ledger of changes.
// Officers enter raid nights, awards and adjustments as drafts; approving the sheet
// makes them official. Weekly decay is added as a draft early each Tuesday.
//
//   dkp/settings     { cap, start, attendStart, attendEnd, decay }
//   dkp/state        { approved: {person: balance}, approvedAt, approvedBy, started: {person: true} }
//   dkp/tx/<id>      { id, at, entered, source, person, delta, kind, status: draft|approved, night?, char?, item?, note?, by }
//                    source: manual (officer form), edit (changed after the night was entered), example; later addon/bot
//   dkp/nights/<id>  { id, date, group, by, at }
//   dkp/sheets/<at>  snapshot of balances at each approval
//   dkpaudit/<at>-<id>   append-only trail of every DKP action (never deleted, not even by Start over)
//   dkparchive/<at>      full copy of all DKP data, saved right before any wipe
// A character's person is its main: char.alt_of when set, otherwise its own key.

export const DEFAULTS = { cap: 100, start: 20, attendStart: 5, attendEnd: 5, decay: 5 };
const rid = () => Math.random().toString(36).slice(2, 8);
const stamp = (t = Date.now()) => new Date(t).toISOString();

// Paper trail. Lives outside dkp/ so nothing that wipes DKP data can touch it.
export async function audit(s, action, by, summary, detail = {}) {
  const at = stamp();
  await s.setJSON(`dkpaudit/${at}-${rid()}`, { at, action, by: by || '', summary, ...detail });
}
export async function auditAll(s) {
  const { blobs } = await s.list({ prefix: 'dkpaudit/' });
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
}
// Everything, in one object: used for backups before a wipe.
export async function snapshot(s) {
  const out = { settings: await s.get('dkp/settings', { type: 'json' }), state: await s.get('dkp/state', { type: 'json' }) };
  for (const k of ['tx', 'nights', 'sheets']) {
    const { blobs } = await s.list({ prefix: `dkp/${k}/` });
    out[k] = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean);
  }
  return out;
}

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

let SRC = 'manual';
export async function addTx(s, t) {
  const at = t.at || stamp();
  const id = `${at.replace(/[:.]/g, '')}-${rid()}`;
  // entered = when it was really typed in (at can be back-dated to the raid). source says how it got here.
  const doc = { id, status: 'draft', source: SRC, ...t, at, entered: stamp() };
  await s.setJSON(`dkp/tx/${id}`, doc);
  return doc;
}

// Attendance for one raid night. Each person counts once even if several of their
// characters are listed. Bench gets both start and end points.
export async function recordNight(s, { date, group, start = [], end = [], bench = [], by, at: when }, charsByKey) {
  const cfg = await settings(s), st = await state(s);
  const drafts = await allTx(s, 'draft');
  const startedDraft = new Set(drafts.filter(t => t.kind === 'start').map(t => t.person));
  // Same date and group already entered: refuse rather than double-count.
  const { blobs: existing } = await s.list({ prefix: `dkp/nights/${date}-` });
  for (const b of existing) { const n = await s.get(b.key, { type: 'json' }); if (n && (n.group || '') === (group || '')) return { duplicate: n }; }
  const night = { id: `${date}-${rid()}`, date, group: group || '', by, at: when || stamp() };
  await s.setJSON(`dkp/nights/${night.id}`, night);
  const people = new Map();
  const mark = (keys, field) => keys.forEach(k => { const c = charsByKey[k]; if (!c) return; const p = personOf(c); const e = people.get(p) || { char: c.key }; e[field] = true; people.set(p, e); });
  mark(start, 'start'); mark(end, 'end'); mark(bench, 'bench');
  // One timestamp for the whole night; ord keeps each person's lines in order.
  const at = when || stamp();
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

const ATT = ['attend-start', 'attend-end', 'bench'];
const ATT_LABEL = { 'attend-start': 'raid start', 'attend-end': 'raid end', bench: 'bench' };
// Change who was at a night after the fact. Draft lines for the night are rewritten;
// approved lines stay (they're on a signed sheet) and get a draft correction instead.
export async function editNight(s, nightId, { start = [], end = [], bench = [], by }, charsByKey) {
  const night = await s.get(`dkp/nights/${nightId}`, { type: 'json' });
  if (!night) return { error: 'That raid night isn’t there anymore.' };
  const cfg = await settings(s), st = await state(s);
  const all = await allTx(s);
  const mine = all.filter(t => t.night === nightId);
  const want = new Map();
  const mark = (keys, field) => keys.forEach(k => { const c = charsByKey[k]; if (!c) return; const p = personOf(c); const e = want.get(p) || { char: c.key }; e[field] = true; want.set(p, e); });
  mark(start, 'start'); mark(end, 'end'); mark(bench, 'bench');
  const people = new Set([...want.keys(), ...mine.filter(t => ATT.includes(t.kind) || t.kind === 'attend-fix' || t.kind === 'start').map(t => t.person)]);
  const amount = { 'attend-start': cfg.attendStart, 'attend-end': cfg.attendEnd, bench: cfg.attendStart + cfg.attendEnd };
  const at = night.at; let ord = 1000 + mine.reduce((m, t) => Math.max(m, t.ord || 0), 0);
  const changes = [];
  for (const person of people) {
    const w = want.get(person);
    const desired = !w ? [] : w.bench ? ['bench'] : [w.start && 'attend-start', w.end && 'attend-end'].filter(Boolean);
    const lines = mine.filter(t => t.person === person);
    // Throw out this night's draft attendance lines; they get rebuilt below.
    for (const t of lines.filter(t => t.status === 'draft' && (ATT.includes(t.kind) || t.kind === 'attend-fix'))) await s.delete(`dkp/tx/${t.id}`);
    // What the approved sheet already gave this person for this night.
    const have = {};
    for (const t of lines.filter(t => t.status === 'approved')) {
      if (ATT.includes(t.kind)) have[t.kind] = (have[t.kind] || 0) + 1;
      if (t.kind === 'attend-fix') have[t.undo] = (have[t.undo] || 0) + (t.delta < 0 ? -1 : 1);
    }
    const char = w?.char || lines[0]?.char;
    for (const k of ATT) {
      const need = desired.includes(k) ? 1 : 0, got = have[k] || 0;
      for (let i = got; i < need; i++) await addTx(s, { at, ord: ord++, person, delta: amount[k], kind: k, night: nightId, char, by, note: 'Attendance fix', source: 'edit' });
      for (let i = need; i < got; i++) {
        const orig = lines.find(t => t.status === 'approved' && t.kind === k);
        await addTx(s, { at, ord: ord++, person, delta: -(orig?.delta || amount[k]), kind: 'attend-fix', undo: k, night: nightId, char, by, note: `Took back ${ATT_LABEL[k]}`, source: 'edit' });
      }
    }
    // Starting DKP follows whether they were there at all.
    const draftStart = lines.find(t => t.kind === 'start' && t.status === 'draft');
    const startedElsewhere = st.started[person] || all.some(t => t.kind === 'start' && t.person === person && t.night !== nightId);
    if (desired.length && !draftStart && !startedElsewhere && !lines.some(t => t.kind === 'start')) await addTx(s, { at, ord: ord++, person, delta: cfg.start, kind: 'start', night: nightId, char, note: 'Starting DKP', by, source: 'edit' });
    if (!desired.length && draftStart) await s.delete(`dkp/tx/${draftStart.id}`);
    const eff = {};
    for (const t of lines) { if (ATT.includes(t.kind)) eff[t.kind] = (eff[t.kind] || 0) + 1; if (t.kind === 'attend-fix') eff[t.undo] = (eff[t.undo] || 0) + (t.delta < 0 ? -1 : 1); }
    const before = ATT.filter(k => (eff[k] || 0) > 0);
    if (before.join() !== desired.join()) changes.push({ person, before, after: desired });
  }
  return { night, changes };
}

// The draft sheet: last approved balances plus every draft change.
export async function draftSheet(s) {
  const cfg = await settings(s), st = await state(s), drafts = await allTx(s, 'draft');
  return { cfg, st, drafts, balances: apply(st.approved, drafts, cfg.cap) };
}

export async function approve(s, by, when) {
  const { cfg, st, drafts, balances } = await draftSheet(s);
  const at = when || stamp();
  for (const t of drafts) { if (t.kind === 'start') st.started[t.person] = true; await s.setJSON(`dkp/tx/${t.id}`, { ...t, status: 'approved', approvedAt: at }); }
  const next = { ...st, approved: balances, approvedAt: at, approvedBy: by };
  await s.setJSON('dkp/state', next);
  await s.setJSON(`dkp/sheets/${at}`, { at, by, balances, changes: drafts.length, cap: cfg.cap });
  return { at, changes: drafts.length, people: Object.keys(balances).length, balances };
}

// Weekly decay as draft lines, for everyone holding DKP. Runs early Tuesday.
export async function addDecay(s, by = 'Weekly decay', force = false, when) {
  const { cfg, balances } = await draftSheet(s);
  const week = (when || stamp()).slice(0, 10);
  const st = await state(s);
  if (st.lastDecay === week && !force) return 0;
  let n = 0;
  for (const [person, bal] of Object.entries(balances)) if (bal > 0) { await addTx(s, { at: when, person, delta: -cfg.decay, kind: 'decay', note: 'Weekly decay', by, source: 'auto' }); n++; }
  await s.setJSON('dkp/state', { ...st, lastDecay: week });
  if (n && !when) await audit(s, 'decay', by, `Weekly decay: -${cfg.decay} for ${n} ${n === 1 ? 'person' : 'people'}`, { people: n, amount: cfg.decay });
  return n;
}

// Wipes all DKP history and balances (settings and alt links stay). For clearing test data.
export async function resetAll(s, by = '', why = 'Start over') {
  const snap = await snapshot(s), at = stamp();
  if (snap.tx.length || snap.nights.length || snap.sheets.length) {
    await s.setJSON(`dkparchive/${at}`, { at, by, why, ...snap });
    await audit(s, 'backup', by, `Backed up ${snap.tx.length} lines and ${snap.nights.length} raid nights before: ${why}`, { archive: at });
  }
  let n = 0;
  for (const prefix of ['dkp/tx/', 'dkp/nights/', 'dkp/sheets/']) {
    const { blobs } = await s.list({ prefix });
    for (const b of blobs) { await s.delete(b.key); n++; }
  }
  await s.delete('dkp/state');
  return n;
}

// Example data for trying the officer tools: six November raid nights (Mon/Wed),
// the last one left as drafts to review. Uses the given characters as raiders.
export async function seedDemo(s, raiders, charsByKey, by) {
  await resetAll(s, by, 'Fill with example data');
  SRC = 'example';
  try { return await seedDemoInner(s, raiders, charsByKey, by); } finally { SRC = 'manual'; }
}
async function seedDemoInner(s, raiders, charsByKey, by) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pickN = (arr, n) => arr.slice().sort(() => rnd() - 0.5).slice(0, n);
  const ITEMS = ['Band of Accuria', 'Onyxia Tooth Pendant', 'Cenarion Boots', 'Felheart Gloves', 'Giantstalker’s Belt', 'Lawbringer Bracers',
    'Nightslayer Shoulder Pads', 'Earthshaker', 'Choker of Enlightenment', 'Helm of Wrath', 'Robe of Volatile Power', 'Ring of Spell Power',
    'Medallion of Steadfast Might', 'Sorcerous Dagger', 'Fireproof Cloak', 'Gutgore Ripper', 'Arcanist Crown', 'Vis’kag the Bloodletter',
    'Head of Onyxia', 'Eskhandar’s Right Claw', 'Mana Igniting Cord', 'Aged Core Leather Gloves', 'Wristguards of Stability', 'Heavy Dark Iron Ring'];
  const nights = ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18'];
  const profile = new Map(raiders.map(c => { const r = rnd(); return [c.key, r < 0.5 ? 'regular' : r < 0.8 ? 'some' : 'two']; }));
  const twoNights = new Map(raiders.map(c => [c.key, pickN([0, 1, 2, 3, 4, 5], 2)]));
  const cfg = await settings(s);
  const spend = {};
  for (let n = 0; n < nights.length; n++) {
    const date = nights[n], at = `${date}T23:30:00.000Z`;
    const here = raiders.filter(c => { const p = profile.get(c.key); return p === 'regular' ? rnd() > 0.05 : p === 'some' ? rnd() < 0.65 : twoNights.get(c.key).includes(n); });
    const missing = raiders.filter(c => !here.includes(c) && profile.get(c.key) === 'regular');
    const bench = missing.length && rnd() < 0.5 ? [missing[0].key] : [];
    const start = here.map(c => c.key), end = here.filter(() => rnd() > 0.15).map(c => c.key);
    await recordNight(s, { date, start, end, bench, by, at }, charsByKey);
    // Loot: 2–4 items to people who were there at the start, within what they can spend.
    const { st } = await draftSheet(s);
    const drafts = await allTx(s, 'draft');
    const avail = apply(st.approved, drafts.filter(t => t.delta < 0 || t.kind === 'start'), cfg.cap);
    const nItems = 2 + Math.floor(rnd() * 3);
    for (const item of pickN(ITEMS, nItems)) {
      const who = pickN(here, here.length).find(c => (avail[personOf(c)] || 0) >= 5);
      if (!who) continue;
      const p = personOf(who), max = Math.min(avail[p], 45);
      const bid = 5 + Math.floor(rnd() * (max - 4));
      avail[p] -= bid; spend[p] = (spend[p] || 0) + bid;
      await addTx(s, { at: `${date}T23:45:00.000Z`, ord: Math.floor(rnd() * 100), person: p, char: who.key, delta: -bid, kind: 'award', item, by });
    }
    if (n === 2) { const c = here[0]; if (c) await addTx(s, { at: `${date}T23:50:00.000Z`, person: personOf(c), char: c.key, delta: 3, kind: 'adjust', note: 'Brought feasts for the raid', by }); }
    if (n === 4) { const c = here[here.length - 1]; if (c) await addTx(s, { at: `${date}T23:50:00.000Z`, person: personOf(c), char: c.key, delta: -5, kind: 'adjust', note: 'Showed up after the first pull', by }); }
    if (n === nights.length - 1) break; // last night stays as drafts to review
    const d = new Date(date + 'T12:00:00Z'), mon = d.getUTCDay() === 1;
    await approve(s, by, new Date(d.getTime() + (mon ? 29 : 29) * 3600e3).toISOString());
  }
  return { nights: nights.length, raiders: raiders.length };
}
