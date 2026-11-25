// Scheduled hourly: fills in the recipe search index a little at a time.
// 1. The catalog of every recipe per profession (rebuilt weekly).
// 2. Short details for each recipe (stats line, icon, how it's learned, rep needed),
//    recipes guildies already know first. Each recipe is looked up once.
// 3. Guildies' reputations, refreshed every 12 hours, for rep-gated recipes.
// New recipes guildies learn show up within the hour.
import { getStore } from '@netlify/blobs';
import { blizzToken, bget, recipeDetail, compact, buildCatalog, RECIPE_V, COMPACT_V } from '../lib/gamedata.mjs';

const CATALOG_EVERY_MS = 7 * 24 * 3600 * 1000;
const REP_EVERY_MS = 12 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000;

export default async () => {
  const start = Date.now(), left = () => 22000 - (Date.now() - start);
  const s = getStore({ name: 'guild', consistency: 'strong' });
  const token = await blizzToken(s);
  if (!token) return new Response('no token');

  let cat = await s.get('meta/recipe-catalog', { type: 'json' });
  if (!cat || Date.now() - cat.at > CATALOG_EVERY_MS) {
    const fresh = await buildCatalog(token);
    if (Object.keys(fresh.profs).length) { await s.setJSON('meta/recipe-catalog', fresh); cat = fresh; }
    if (left() < 8000) return new Response('catalog built');
  }

  // Which recipes exist, which profession each belongs to, and which ones guildies know.
  const { blobs: charBlobs } = await s.list({ prefix: 'char/' });
  const chars = (await Promise.all(charBlobs.map(b => s.get(b.key, { type: 'json' })))).filter(c => c && c.synced && c.in_guild !== false && c.bslug);
  const profDocs = await Promise.all(chars.map(c => s.get(`prof/${c.key}`, { type: 'json' })));
  const profOf = new Map(), known = new Set();
  for (const [name, p] of Object.entries(cat?.profs || {})) for (const [id] of p.recipes) profOf.set(id, name);
  profDocs.forEach(list => (list || []).forEach(p => p.recipes.forEach(r => { if (r?.id) { known.add(r.id); if (!profOf.has(r.id)) profOf.set(r.id, p.name); } })));

  // Who knows what, in one small file the Discord bot can search quickly.
  const knownBy = {};
  chars.forEach((c, n) => (profDocs[n] || []).forEach(p => p.recipes.forEach(r => {
    const name = typeof r === 'string' ? r : r.name;
    const k = r?.id ? 'i' + r.id : 'n' + name;
    const e = knownBy[k] || (knownBy[k] = { id: r?.id || null, n: name, p: p.name, k: [] });
    e.k.push([c.key, p.skill]);
  })));
  await s.setJSON('meta/craft-known', { at: Date.now(), r: knownBy,
    c: Object.fromEntries(chars.map(c => [c.key, { name: c.name, cls: c.cls, level: c.level, main_spec: c.main_spec || '', main_role: c.main_role || '' }])) });

  const idx = (await s.get('meta/recipe-index', { type: 'json' })) || { v: RECIPE_V, e: {}, miss: {} };
  if (idx.v !== RECIPE_V) { idx.v = RECIPE_V; idx.e = {}; idx.miss = {}; }
  idx.miss = idx.miss || {};
  const todo = [...profOf.keys()].filter(id => !idx.e[id] && !(idx.miss[id] && Date.now() - idx.miss[id] < RETRY_MS))
    .sort((a, b) => known.has(b) - known.has(a));
  let added = 0;
  // Redo short entries saved in an older format from the stored details.
  const stale = Object.keys(idx.e).filter(id => idx.e[id].cv !== COMPACT_V);
  for (let i = 0; i < stale.length && left() > 12000; i += 40) {
    await Promise.all(stale.slice(i, i + 40).map(async id => {
      const d = await s.get(`recipe/${id}`, { type: 'json' });
      if (d) { idx.e[id] = compact(d, idx.e[id].p); added++; } else delete idx.e[id];
    }));
  }
  for (let i = 0; i < todo.length && left() > 9000; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async id => {
      try {
        const d = await recipeDetail(s, token, id);
        if (!d) { idx.miss[id] = Date.now(); return; }
        await s.setJSON(`recipe/${id}`, d);
        idx.e[id] = compact(d, profOf.get(id));
        delete idx.miss[id]; added++;
      } catch (_) { idx.miss[id] = Date.now(); }
    }));
  }
  if (added || todo.length === 0) { idx.at = Date.now(); await s.setJSON('meta/recipe-index', idx); }

  // Reputations, oldest first, with whatever time is left.
  const repDocs = await Promise.all(chars.map(c => s.get(`rep/${c.key}`, { type: 'json' })));
  const repTodo = chars.map((c, i) => [c, repDocs[i]?.at || 0]).filter(([, at]) => Date.now() - at > REP_EVERY_MS);
  repTodo.sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < repTodo.length && left() > 3000; i += 8) {
    await Promise.all(repTodo.slice(i, i + 8).map(async ([c]) => {
      const r = await bget(token, `/profile/wow/character/${encodeURIComponent(c.bslug)}/reputations`);
      if (!r.body && r.status !== 404) return;
      const f = {};
      for (const x of r.body?.reputations || []) if (x.faction?.id) f[x.faction.id] = [x.standing?.tier ?? 3, x.standing?.value ?? 0, x.standing?.max ?? 0, x.faction.name || ''];
      await s.setJSON(`rep/${c.key}`, { at: Date.now(), f });
    }));
  }
  return new Response(`recipes +${added}, ${todo.length - added} to go; reps ${repTodo.length} stale`);
};

export const config = { schedule: '17 * * * *' }; // once an hour (Netlify bills compute per run)
