// Guild roster API for Mystic Dragons (WoW Forever).
// - Syncs the guild roster from Blizzard's Forever API (no realms; profile-forever-us).
// - Characters are claimed per browser (random device id); no logins.
// - Raid signups and a change log live in Netlify Blobs (store "guild").
import { getStore } from '@netlify/blobs';

const CLASSES = {
  Warrior: ['Tank', 'Melee DPS'], Paladin: ['Tank', 'Healer', 'Melee DPS'], Hunter: ['Ranged DPS', 'Melee DPS'],
  Rogue: ['Melee DPS'], Priest: ['Healer', 'Ranged DPS'], Shaman: ['Healer', 'Melee DPS', 'Ranged DPS'],
  Mage: ['Ranged DPS'], Warlock: ['Ranged DPS'], Druid: ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS']
};
const CLASS_IDS = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
const DEC9 = ['Yes', 'Probably', 'Not sure yet', 'No'];
const LATER = ['Yes', 'Probably', 'Not sure yet', 'Not planning to raid'];
const ETA = ['Sometime in December', 'After the holidays', 'No idea yet'];
const ATTUNE = ['I’ve done it', 'I’ll try to do it', 'I’ll need help', 'What attunement?', 'Probably won’t have time'];

const GUILD = 'mystic-dragons';
const API = 'https://us.api.blizzard.com';
const NS = 'profile-forever-us';
const SYNC_EVERY_MS = 20 * 60 * 1000;
const CATCHUP_EVERY_MS = 60 * 1000; // while names/races are still missing
const PROFILE_EVERY_MS = 6 * 60 * 60 * 1000;
const INFO_TTL_MS = 30 * 60 * 1000;

const store = () => getStore({ name: 'guild', consistency: 'strong' });
const slug = n => String(n || '').trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const pick = (v, list) => (list.includes(v) ? v : '');
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const manualKey = name => 'm-' + slug(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function allChars(s) {
  const { blobs } = await s.list({ prefix: 'char/' });
  const docs = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
  return docs.filter(Boolean);
}
async function log(s, action, name, device, details = {}) {
  const at = new Date().toISOString();
  await s.setJSON(`log/${at}-${Math.random().toString(36).slice(2, 8)}`, { at, action, character: name, device: String(device).slice(0, 12), ...details });
}
function roleFields(body, cls, prev = {}) {
  const roles = CLASSES[cls] || [];
  const main = roles.includes(body.main_role) ? body.main_role : (roles.length === 1 ? roles[0] : (roles.includes(prev.main_role) ? prev.main_role : ''));
  const also = (Array.isArray(body.also_play) ? body.also_play : String(body.also_play || '').split(','))
    .map(x => String(x).trim()).filter(x => roles.includes(x) && x !== main);
  return { main_role: main, also_play: [...new Set(also)] };
}
const publicChar = c => ({
  key: c.key, name: c.name, first: c.first || c.name, cls: c.cls, level: c.level, race: c.race || '', rank: c.rank ?? null,
  main_role: c.main_role || '', also_play: c.also_play || [], synced: !!c.synced, in_guild: c.in_guild !== false,
  claimed: (c.claims || []).length > 0, updated_at: c.updated_at
});
async function moveSignup(s, fromKey, toKey) {
  const sign = await s.get(`signup/dec9/${fromKey}`, { type: 'json' });
  if (sign && !(await s.get(`signup/dec9/${toKey}`))) await s.setJSON(`signup/dec9/${toKey}`, sign);
  if (sign) await s.delete(`signup/dec9/${fromKey}`);
}

/* ---------- Blizzard ---------- */
async function blizzToken(s) {
  const cached = await s.get('meta/blizz-token', { type: 'json' });
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  const id = process.env.BLIZZARD_CLIENT_ID, secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) return null;
  const d = await r.json();
  await s.setJSON('meta/blizz-token', { token: d.access_token, expires: Date.now() + (d.expires_in || 3600) * 1000 });
  return d.access_token;
}
async function bget(token, path, ns = NS) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}namespace=${ns}&locale=en_US`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return { status: r.status, body: null };
  return { status: 200, body: await r.json() };
}
// The Forever character slug is "first-last"; take it from the roster's link when it has one.
const slugFromHref = href => { const m = /\/profile\/wow\/character\/(?:[^/?]+\/)?([^/?]+)\?/.exec(String(href || '')); return m ? decodeURIComponent(m[1]) : ''; };
const titleCase = sl => sl.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function syncDue(meta, force) {
  if (force || !meta) return true;
  return Date.now() - meta.at > (meta.pending ? CATCHUP_EVERY_MS : SYNC_EVERY_MS);
}
async function syncGuild(s, force) {
  const meta = await s.get('meta/sync', { type: 'json' });
  if (!syncDue(meta, force)) return meta;
  await s.setJSON('meta/sync', { ...(meta || {}), at: Date.now() });
  try {
    const token = await blizzToken(s);
    if (!token) return meta;
    const res = await bget(token, `/data/wow/guild/${GUILD}/roster`);
    if (!res.body) return meta;
    const members = (res.body.members || []).map(m => ({
      id: m.character?.id, first: clean(m.character?.name, 24), level: parseInt(m.character?.level, 10) || 1,
      cls: CLASS_IDS[m.character?.playable_class?.id] || '', rank: m.rank, bslug: slugFromHref(m.character?.key?.href)
    })).filter(m => m.id && m.first && m.cls);

    let existing = await allChars(s);
    const byKey = new Map(existing.map(c => [c.key, c]));
    const now = new Date().toISOString();
    const firstCount = {};
    members.forEach(m => { firstCount[slug(m.first)] = (firstCount[slug(m.first)] || 0) + 1; });

    const writes = [];
    for (const m of members) {
      const key = 'b' + m.id;
      let doc = byKey.get(key);
      const fresh = !doc;
      if (!doc) {
        // Carry over anything saved before the sync existed (keyed by first or full name).
        const legacy = existing.find(c => !c.bid && c.key !== key && (
          slug(c.name) === slug(m.first) || (firstCount[slug(m.first)] === 1 && slug(c.name).split(' ')[0] === slug(m.first))));
        doc = { key, claims: [], created_at: now };
        if (legacy) {
          doc.claims = legacy.claims || [];
          if (legacy.cls === m.cls) { doc.main_role = legacy.main_role; doc.also_play = legacy.also_play; doc.cls = m.cls; }
          if (slug(legacy.name).includes(' ')) doc.typed_name = legacy.name;
          await moveSignup(s, legacy.key || slug(legacy.name), key);
          await s.delete(`char/${legacy.key || slug(legacy.name)}`);
          existing = existing.filter(c => c !== legacy);
          byKey.delete(legacy.key);
          await log(s, 'merge', m.first, 'system', { from: legacy.name });
        }
      }
      const roles = CLASSES[m.cls];
      const keepRoles = doc.cls ? doc.cls === m.cls : false;
      const bslug = m.bslug && m.bslug.includes('-') ? m.bslug : (doc.bslug || '');
      const next = {
        ...doc, key, bid: m.id, first: m.first, cls: m.cls, level: Math.max(m.level, doc.cls === m.cls ? doc.profile_level || 0 : 0), rank: m.rank, synced: true, in_guild: true,
        bslug, name: doc.surname ? `${m.first} ${doc.surname}` : (bslug ? titleCase(bslug) : (doc.typed_name || m.first)),
        main_role: keepRoles ? doc.main_role || '' : (roles.length === 1 ? roles[0] : ''),
        also_play: keepRoles ? doc.also_play || [] : [],
        updated_at: !fresh && doc.level === Math.max(m.level, doc.profile_level || 0) && doc.cls === m.cls ? doc.updated_at : now
      };
      if (JSON.stringify(doc) !== JSON.stringify(next)) writes.push([`char/${key}`, next]);
      byKey.set(key, next);
    }
    for (let i = 0; i < writes.length; i += 25) await Promise.all(writes.slice(i, i + 25).map(([k, v]) => s.setJSON(k, v)));
    const ids = new Set(members.map(m => 'b' + m.id));
    for (const c of byKey.values()) if (c.synced && c.in_guild && !ids.has(c.key)) await s.setJSON(`char/${c.key}`, { ...c, in_guild: false });

    // Fold any remaining hand-added or older copies into the matching guild character.
    const aliases = (await s.get('meta/aliases', { type: 'json' })) || {};
    for (const c of [...byKey.values()]) {
      if (c.bid || !c.key) continue;
      const first = slug(c.name).split(' ')[0];
      const twin = members.filter(m => slug(m.first) === first && (!c.cls || m.cls === c.cls));
      if (twin.length !== 1) continue;
      const key = 'b' + twin[0].id, target = byKey.get(key);
      if (!target) continue;
      target.claims = [...new Set([...(target.claims || []), ...(c.claims || [])])].slice(-10);
      if (!target.main_role && c.cls === target.cls) { target.main_role = c.main_role || ''; target.also_play = c.also_play || []; }
      if (!target.typed_name && slug(c.name).includes(' ')) target.typed_name = c.name;
      await s.setJSON(`char/${key}`, target);
      await moveSignup(s, c.key, key);
      await s.delete(`char/${c.key}`);
      byKey.delete(c.key);
      aliases[c.key] = key;
      await log(s, 'merge', target.first, 'system', { from: c.name });
    }
    await s.setJSON('meta/aliases', aliases);

    // Fill in surnames and race from character profiles, a few per sync.
    const todo = [...byKey.values()].filter(c => c.synced && ids.has(c.key) && (!c.profile_at || Date.now() - c.profile_at > PROFILE_EVERY_MS))
      .sort((a, b) => (a.profile_at || 0) - (b.profile_at || 0));
    const batchTodo = todo.slice(0, 30);
    for (let i = 0; i < batchTodo.length; i += 10) {
      await Promise.all(batchTodo.slice(i, i + 10).map(async c => {
        const tries = [c.bslug, c.typed_name && slug(c.typed_name).replace(/ /g, '-')].filter(Boolean);
        let prof = null;
        for (const t of tries) { const r = await bget(token, `/profile/wow/character/${encodeURIComponent(t)}`); if (r.body) { prof = r.body; c.bslug = t; break; } }
        const upd = { ...c, profile_at: Date.now() };
        if (prof) {
          upd.surname = clean(prof.surname, 24);
          upd.name = upd.surname ? `${c.first} ${upd.surname}` : (c.bslug ? titleCase(c.bslug) : c.first);
          upd.race = clean(prof.race?.name, 24);
          if (prof.level) { upd.profile_level = prof.level; upd.level = Math.max(upd.level || 1, prof.level); }
          upd.faction = clean(prof.faction?.name, 16);
        }
        await s.setJSON(`char/${c.key}`, upd);
      }));
    }
    const out = { at: Date.now(), ok: true, members: members.length, pending: todo.length > batchTodo.length };
    await s.setJSON('meta/sync', out);
    return out;
  } catch (_) { return meta; }
}

// Everything Blizzard has on one character, cached for half an hour.
async function characterInfo(s, c) {
  const cached = await s.get(`info/${c.key}`, { type: 'json' });
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached;
  const token = await blizzToken(s);
  if (!token || !c.bslug) return { at: Date.now(), available: false };
  const base = `/profile/wow/character/${encodeURIComponent(c.bslug)}`;
  const parts = ['', '/character-media', '/equipment', '/professions', '/specializations', '/reputations', '/pvp-summary', '/titles',
    '/encounters/raids', '/encounters/dungeons', '/collections/mounts', '/collections/pets', '/collections/toys', '/achievements', '/achievements/statistics', '/quests/completed'];
  const res = {};
  for (let i = 0; i < parts.length; i += 6) {
    const batch = await Promise.all(parts.slice(i, i + 6).map(p => bget(token, base + p)));
    batch.forEach((r, j) => { res[parts[i + j] || 'profile'] = r.body; });
  }
  const p = res.profile || {};
  const nm = o => o?.name ?? '';
  const info = {
    at: Date.now(), available: !!res.profile,
    profile: res.profile && {
      name: p.name, surname: p.surname, level: p.level, experience: p.experience, race: nm(p.race), cls: nm(p.character_class),
      gender: nm(p.gender), faction: nm(p.faction), guild: nm(p.guild), ruleset: nm(p.ruleset), title: p.active_title?.display_string || '',
      item_level: p.equipped_item_level ?? p.average_item_level ?? null, achievement_points: p.achievement_points ?? null,
      last_login: p.last_login_timestamp || null
    },
    media: (res['/character-media']?.assets || []).map(a => ({ key: a.key, url: a.value })).filter(a => /^https:\/\//.test(a.url)),
    equipment: (res['/equipment']?.equipped_items || []).map(it => ({
      slot: nm(it.slot), name: nm(it), quality: it.quality?.type || '', level: it.level?.value ?? null, id: it.item?.id ?? null,
      stats: (it.stats || []).map(st => st.display?.display_string).filter(Boolean),
      enchant: (it.enchantments || []).map(e => e.display_string).filter(Boolean)
    })),
    professions: ['primaries', 'secondaries'].flatMap(k => (res['/professions']?.[k] || []).map(pr => ({
      name: nm(pr.profession), primary: k === 'primaries',
      tiers: (pr.tiers || [pr]).map(t => ({ name: nm(t.tier) || nm(pr.profession), skill: t.skill_points ?? null, max: t.max_skill_points ?? null }))
    }))),
    specs: (res['/specializations']?.specialization_groups || []).map(g => ({
      active: !!g.is_active,
      trees: (g.specializations || []).map(sp => ({ name: sp.specialization_name || nm(sp.specialization), points: sp.spent_points ?? null }))
    })),
    reputations: (res['/reputations']?.reputations || []).map(r => ({ name: nm(r.faction), standing: nm(r.standing), value: r.standing?.value ?? null, max: r.standing?.max ?? null })),
    pvp: res['/pvp-summary'] ? { honorable_kills: res['/pvp-summary'].honorable_kills ?? null, rank: res['/pvp-summary'].pvp_rank ?? null } : null,
    titles: (res['/titles']?.titles || []).map(nm),
    raids: (res['/encounters/raids']?.expansions || []).flatMap(x => (x.instances || []).map(inst => ({
      name: nm(inst.instance),
      modes: (inst.modes || []).map(md => ({ mode: nm(md.difficulty), status: nm(md.status), done: md.progress?.completed_count ?? null, total: md.progress?.total_count ?? null }))
    }))),
    dungeons: (res['/encounters/dungeons']?.expansions || []).flatMap(x => (x.instances || []).map(inst => ({
      name: nm(inst.instance),
      kills: (inst.modes || []).reduce((n, md) => n + (md.progress?.encounters || []).reduce((a, e) => a + (e.completed_count || 0), 0), 0)
    }))),
    collections: {
      mounts: (res['/collections/mounts']?.mounts || []).length,
      pets: (res['/collections/pets']?.pets || []).length,
      toys: (res['/collections/toys']?.toys || []).length
    },
    achievements: res['/achievements'] ? { points: res['/achievements'].total_points ?? null, count: res['/achievements'].total_quantity ?? null } : null,
    quests_completed: (res['/quests/completed']?.quests || []).length,
    statistics: (res['/achievements/statistics']?.categories || []).map(cat => ({
      name: cat.name,
      stats: [...(cat.statistics || []), ...(cat.sub_categories || []).flatMap(sc => sc.statistics || [])].map(st => ({ name: st.name, value: st.quantity }))
    })).filter(cat => cat.stats.length)
  };
  // Item icons (static game data, cached for good).
  const ids = [...new Set(info.equipment.map(it => it.id).filter(Boolean))];
  const icons = await Promise.all(ids.map(async id => {
    let url = await s.get(`icon/${id}`);
    if (url == null) {
      const r = await bget(token, `/data/wow/media/item/${id}`, 'static-forever-us');
      url = (r.body?.assets || []).find(a => a.key === 'icon')?.value || '';
      if (r.status === 200 || r.status === 404) await s.set(`icon/${id}`, url);
    }
    return [id, /^https:\/\//.test(url) ? url : ''];
  }));
  const iconMap = Object.fromEntries(icons);
  info.equipment.forEach(it => { it.icon = iconMap[it.id] || ''; });
  await s.setJSON(`info/${c.key}`, info);
  return info;
}

// One-time import of signups made through the old Netlify form.
async function seedFromForms(s, context) {
  if (await s.get('meta/seeded')) return;
  await s.set('meta/seeded', new Date().toISOString());
  const token = process.env.NETLIFY_TOKEN;
  if (!token) return;
  const headers = { Authorization: `Bearer ${token}` };
  const siteId = context?.site?.id || process.env.SITE_ID;
  try {
    const forms = await (await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, { headers })).json();
    const form = Array.isArray(forms) && forms.find(f => f.name === 'raid-signup');
    if (!form) return;
    let subs = [];
    for (let page = 1; page < 20; page++) {
      const b = await (await fetch(`https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=100&page=${page}`, { headers })).json();
      if (!Array.isArray(b) || !b.length) break;
      subs = subs.concat(b);
      if (b.length < 100) break;
    }
    subs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const latest = new Map();
    for (const sub of subs) { const d = sub.data || {}; if (d.character && CLASSES[d.class]) latest.set(slug(d.character), { d, at: sub.created_at }); }
    for (const [, { d, at }] of latest) {
      const name = clean(d.character, 32), key = manualKey(name);
      await s.setJSON(`char/${key}`, { key, name, cls: d.class, level: Math.min(60, parseInt(d.level, 10) || 1), ...roleFields(d, d.class), claims: [], created_at: at, updated_at: at });
      await s.setJSON(`signup/dec9/${key}`, {
        dec9: pick(d.dec9, DEC9), later: pick(d.raid_after, LATER), eta: pick(d.ready_by, ETA),
        attune: pick(d.attunement, ATTUNE), discord: clean(d.discord, 40), notes: clean(d.notes, 1000), at
      });
    }
    await log(s, 'import', `${latest.size} characters`, 'system');
  } catch (_) { /* keep whatever was imported */ }
}

// Earlier versions stored characters under their name; give them keys.
async function migrateKeys(s) {
  if (await s.get('meta/keys-v2')) return;
  for (const c of await allChars(s)) {
    if (c.key) continue;
    const oldKey = slug(c.name), key = manualKey(c.name);
    const { synced, ...rest } = c;
    await s.setJSON(`char/${key}`, { ...rest, key });
    await moveSignup(s, oldKey, key);
    await s.delete(`char/${oldKey}`);
  }
  await s.set('meta/keys-v2', '1');
}

export default async (req, context) => {
  const s = store();
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '');

  try {
    await migrateKeys(s);

    if (req.method === 'GET' && route === 'roster') {
      await seedFromForms(s, context);
      const force = url.searchParams.get('sync') === '1';
      let sync = await s.get('meta/sync', { type: 'json' });
      if (!sync || !sync.ok) sync = await syncGuild(s, force); // very first sync: wait for it
      else if (syncDue(sync, force)) { const job = syncGuild(s, force); if (context?.waitUntil) context.waitUntil(job); else await job; }
      const chars = (await allChars(s)).filter(c => c.key && (c.in_guild !== false || (c.claims || []).length));
      const sign = await Promise.all(chars.map(c => s.get(`signup/dec9/${c.key}`, { type: 'json' })));
      return json({
        characters: chars.map((c, i) => ({
          ...publicChar(c),
          signup: sign[i] ? { dec9: sign[i].dec9, attune: sign[i].attune, later: sign[i].later, eta: sign[i].eta } : null
        })),
        synced_at: sync && sync.ok ? sync.at : null,
        aliases: (await s.get('meta/aliases', { type: 'json' })) || {}
      });
    }

    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body = await req.json().catch(() => ({}));
    const device = clean(body.device, 64);
    if (device.length < 8) return json({ error: 'Missing device id' }, 400);

    if (route === 'verify') {
      // One-time guild check per browser: Discord name + the guild password (GUILD_PASSWORD env var).
      const expected = process.env.GUILD_PASSWORD;
      if (!expected) return json({ error: 'The guild password hasn’t been set up yet. Ask an officer.' }, 503);
      const discord = clean(body.discord, 40);
      if (!discord) return json({ error: 'Add your Discord name' }, 400);
      const tries = (await s.get(`tries/${device}`, { type: 'json' })) || { n: 0, at: 0 };
      if (tries.n >= 5 && Date.now() - tries.at < 10 * 60 * 1000) return json({ error: 'Too many tries. Wait a few minutes and try again.' }, 429);
      const ok = String(body.password || '') === expected;
      if (!ok) {
        await s.setJSON(`tries/${device}`, { n: Date.now() - tries.at > 10 * 60 * 1000 ? 1 : tries.n + 1, at: Date.now() });
        return json({ error: 'That’s not the guild password. Ask in Discord if you’re not sure.' }, 403);
      }
      await s.setJSON(`verified/${device}`, { discord, at: new Date().toISOString() });
      await s.delete(`tries/${device}`);
      await log(s, 'verify', discord, device);
      return json({ ok: true, discord });
    }

    if (route === 'claim') {
      const verified = await s.get(`verified/${device}`, { type: 'json' });
      if (!verified) return json({ error: 'Enter your Discord name and the guild password first.', needsVerify: true }, 403);
      let c = body.key ? await s.get(`char/${clean(body.key, 40)}`, { type: 'json' }) : null;
      if (!c && !body.key) {
        // Not in the guild roster: add it by hand.
        const name = clean(body.name, 32);
        if (!name) return json({ error: 'Add your character’s name' }, 400);
        c = (await allChars(s)).find(x => slug(x.name) === slug(name));
        if (!c) {
          if (!CLASSES[body.cls]) return json({ error: 'Pick a class' }, 400);
          const f = roleFields(body, body.cls);
          if (!f.main_role) return json({ error: 'Pick a main role' }, 400);
          const key = manualKey(name), now = new Date().toISOString();
          c = { key, name, cls: body.cls, level: Math.max(1, Math.min(60, parseInt(body.level, 10) || 1)), ...f, claims: [device], created_at: now, updated_at: now };
          await s.setJSON(`char/${key}`, c);
          await log(s, 'create', name, device, { discord: verified.discord });
          return json({ ok: true, created: true, character: publicChar(c) });
        }
      }
      if (!c) return json({ error: 'That character isn’t on the roster' }, 404);
      const claims = c.claims || [];
      if (claims.length && !claims.includes(device) && !body.confirm) return json({ needsConfirm: true, name: c.name, key: c.key });
      if (!claims.includes(device)) {
        c.claims = [...claims, device].slice(-10);
        await s.setJSON(`char/${c.key}`, c);
        await log(s, claims.length ? 'claim-again' : 'claim', c.name, device, { discord: verified.discord });
      }
      return json({ ok: true, character: publicChar(c) });
    }

    const c = await s.get(`char/${clean(body.key, 40)}`, { type: 'json' });
    if (!c) return json({ error: 'That character isn’t on the roster anymore' }, 404);
    if (route === 'info') {
      const info = await characterInfo(s, c);
      // The character profile is fresher than the guild roster; keep the higher level (cached data too).
      const pl = info.profile?.level;
      if (pl && (pl > (c.level || 0) || pl !== c.profile_level)) {
        Object.assign(c, { profile_level: pl, level: Math.max(c.level || 0, pl), updated_at: new Date().toISOString() });
        await s.setJSON(`char/${c.key}`, c);
      }
      return json({ ok: true, character: publicChar(c), info });
    }
    if (!(c.claims || []).includes(device)) return json({ error: 'Claim this character first' }, 403);

    if (route === 'unclaim') {
      c.claims = (c.claims || []).filter(d => d !== device);
      await s.setJSON(`char/${c.key}`, c);
      await log(s, 'unclaim', c.name, device);
      return json({ ok: true });
    }

    if (route === 'character') {
      const cls = c.synced ? c.cls : (CLASSES[body.cls] ? body.cls : c.cls);
      const level = c.synced ? c.level : Math.max(1, Math.min(60, parseInt(body.level, 10) || c.level || 1));
      const f = roleFields(body, cls, c);
      const next = { ...c, cls, level, ...f };
      const changed = ['cls', 'level', 'main_role', 'also_play'].filter(k => JSON.stringify(next[k]) !== JSON.stringify(c[k]));
      if (changed.length) { next.updated_at = new Date().toISOString(); await s.setJSON(`char/${c.key}`, next); await log(s, 'update', c.name, device, { changed }); }
      return json({ ok: true, character: publicChar(next) });
    }

    if (route === 'signup') {
      const dec9 = pick(body.dec9, DEC9);
      if (!dec9) return json({ error: 'Pick an answer for December 9' }, 400);
      const doc = {
        dec9,
        attune: dec9 === 'Yes' || dec9 === 'Probably' ? pick(body.attune, ATTUNE) : '',
        later: dec9 === 'No' ? pick(body.later, LATER) : '',
        eta: dec9 === 'No' ? pick(body.eta, ETA) : '',
        discord: clean(body.discord, 40), notes: clean(body.notes, 1000), at: new Date().toISOString()
      };
      await s.setJSON(`signup/dec9/${c.key}`, doc);
      await log(s, 'signup', c.name, device, { dec9 });
      return json({ ok: true });
    }

    if (route === 'mine') return json({ ok: true, signup: (await s.get(`signup/dec9/${c.key}`, { type: 'json' })) || null });

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
};

export const config = { path: '/api/*' };
