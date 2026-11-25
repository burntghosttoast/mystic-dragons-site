// Guild roster API for Mystic Dragons (WoW Forever).
// - Syncs the guild roster from Blizzard's Forever API (no realms; profile-forever-us).
// - Characters are claimed per browser (random device id); no logins.
// - Raid signups and a change log live in Netlify Blobs (store "guild").
import { getStore } from '@netlify/blobs';
import { postSummary, DEFAULT_CODES } from '../lib/summary.mjs';
import { handleDiscord, refreshBoard, registerCommands } from '../lib/discordbot.mjs';
import * as DKP from '../lib/dkp.mjs';
import { blizzToken, bget, iconFor, recipeDetail, RECIPE_V } from '../lib/gamedata.mjs';

const CLASSES = {
  Warrior: ['Tank', 'Melee DPS'], Paladin: ['Tank', 'Healer', 'Melee DPS'], Hunter: ['Ranged DPS', 'Melee DPS'],
  Rogue: ['Melee DPS'], Priest: ['Healer', 'Ranged DPS'], Shaman: ['Healer', 'Melee DPS', 'Ranged DPS'],
  Mage: ['Ranged DPS'], Warlock: ['Ranged DPS'], Druid: ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS']
};
// Specs people pick on the site, and the raid role each one fills.
const SPECS = {
  Warrior: [['Arms', 'Melee DPS'], ['Fury', 'Melee DPS'], ['Protection', 'Tank']],
  Paladin: [['Holy', 'Healer'], ['Protection', 'Tank'], ['Retribution', 'Melee DPS']],
  Hunter: [['Beast Mastery', 'Ranged DPS'], ['Marksmanship', 'Ranged DPS'], ['Survival', 'Ranged DPS']],
  Rogue: [['Assassination', 'Melee DPS'], ['Combat', 'Melee DPS'], ['Subtlety', 'Melee DPS']],
  Priest: [['Discipline', 'Healer'], ['Holy', 'Healer'], ['Shadow', 'Ranged DPS']],
  Shaman: [['Elemental', 'Ranged DPS'], ['Enhancement', 'Melee DPS'], ['Restoration', 'Healer']],
  Mage: [['Arcane', 'Ranged DPS'], ['Fire', 'Ranged DPS'], ['Frost', 'Ranged DPS']],
  Warlock: [['Affliction', 'Ranged DPS'], ['Demonology', 'Ranged DPS'], ['Destruction', 'Ranged DPS']],
  Druid: [['Balance', 'Ranged DPS'], ['Feral (Cat)', 'Melee DPS'], ['Feral (Bear)', 'Tank'], ['Restoration', 'Healer']]
};
const CLASS_IDS = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
const DEC9 = ['Yes', 'Probably', 'Not sure yet', 'No'];
const LATER = ['Yes', 'Probably', 'Not sure yet', 'Not planning to raid'];
const ETA = ['Sometime in December', 'After the holidays', 'No idea yet'];
const ATTUNE = ['I’ve done it', 'I’ll try to do it', 'I’ll need help', 'What attunement?', 'Probably won’t have time'];

const GUILD = 'mystic-dragons';
const SYNC_EVERY_MS = 20 * 60 * 1000;
const CATCHUP_EVERY_MS = 60 * 1000; // while names/races are still missing
const PROFILE_EVERY_MS = 6 * 60 * 60 * 1000;
const PROF_EVERY_MS = 6 * 60 * 60 * 1000; // professions and known recipes
const PROF_V = 2; // bump to re-collect professions after format changes
const INFO_TTL_MS = 30 * 60 * 1000;
const INFO_V = 3; // bump to refresh cached game data after format changes

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
  const specs = SPECS[cls] || [], roleOf = n => (specs.find(x => x[0] === n) || [])[1];
  if (typeof body.main_spec === 'string') {
    // Specs picked: the roles follow from them.
    const main = roleOf(body.main_spec) ? body.main_spec : '';
    const also = [...new Set((Array.isArray(body.also_specs) ? body.also_specs : []).map(String).filter(x => roleOf(x) && x !== main))];
    const mainRole = main ? roleOf(main) : '';
    return { main_spec: main, also_specs: also, main_role: mainRole, also_play: [...new Set(also.map(roleOf))].filter(r => r !== mainRole) };
  }
  const roles = CLASSES[cls] || [];
  const main = roles.includes(body.main_role) ? body.main_role : (roles.length === 1 ? roles[0] : (roles.includes(prev.main_role) ? prev.main_role : ''));
  const also = (Array.isArray(body.also_play) ? body.also_play : String(body.also_play || '').split(','))
    .map(x => String(x).trim()).filter(x => roles.includes(x) && x !== main);
  return { main_role: main, also_play: [...new Set(also)], main_spec: prev.main_spec && roleOf(prev.main_spec) === main ? prev.main_spec : '', also_specs: prev.also_specs || [] };
}
const publicChar = c => ({
  key: c.key, name: c.name, first: c.first || c.name, cls: c.cls, level: c.level, race: c.race || '', rank: c.rank ?? null,
  main_role: c.main_role || '', also_play: c.also_play || [], main_spec: c.main_spec || '', also_specs: c.also_specs || [], synced: !!c.synced, in_guild: c.in_guild !== false,
  claimed: (c.claims || []).length > 0, updated_at: c.updated_at
});
async function moveSignup(s, fromKey, toKey) {
  const sign = await s.get(`signup/dec9/${fromKey}`, { type: 'json' });
  if (sign && !(await s.get(`signup/dec9/${toKey}`))) await s.setJSON(`signup/dec9/${toKey}`, sign);
  if (sign) await s.delete(`signup/dec9/${fromKey}`);
}

/* ---------- Blizzard ---------- */
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
          if (legacy.cls === m.cls) { doc.main_role = legacy.main_role; doc.also_play = legacy.also_play; doc.main_spec = legacy.main_spec || ''; doc.also_specs = legacy.also_specs || []; doc.cls = m.cls; }
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
        main_spec: keepRoles ? doc.main_spec || '' : '',
        also_specs: keepRoles ? doc.also_specs || [] : [],
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
      if (!target.main_role && c.cls === target.cls) { target.main_role = c.main_role || ''; target.also_play = c.also_play || []; target.main_spec = c.main_spec || ''; target.also_specs = c.also_specs || []; }
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
    // Professions and known recipes for the crafting directory, a few per sync.
    const profTodo = [...byKey.values()].filter(c => c.synced && ids.has(c.key) && c.bslug && (!c.prof_at || c.prof_v !== PROF_V || Date.now() - c.prof_at > PROF_EVERY_MS))
      .sort((a, b) => (a.prof_at || 0) - (b.prof_at || 0));
    const profBatch = profTodo.slice(0, 30);
    for (let i = 0; i < profBatch.length; i += 10) {
      await Promise.all(profBatch.slice(i, i + 10).map(async c => {
        const r = await bget(token, `/profile/wow/character/${encodeURIComponent(c.bslug)}/professions`);
        if (r.body) await s.setJSON(`prof/${c.key}`, profList(r.body));
        else if (r.status === 404) await s.setJSON(`prof/${c.key}`, []);
        const cur = (await s.get(`char/${c.key}`, { type: 'json' })) || c;
        await s.setJSON(`char/${c.key}`, { ...cur, prof_at: Date.now(), prof_v: PROF_V });
      }));
    }
    const out = { at: Date.now(), ok: true, members: members.length, pending: todo.length > batchTodo.length || profTodo.length > profBatch.length };
    await s.setJSON('meta/sync', out);
    return out;
  } catch (_) { return meta; }
}

// Item icons are static game data: look each one up once and keep it.
// Forever's own namespace first, then Classic and Retail (item ids are shared).
async function addIcons(s, token, info) {
  const ids = [...new Set((info.equipment || []).map(it => it.id).filter(Boolean))];
  const icons = await Promise.all(ids.map(async id => [id, await iconFor(s, token, id)]));
  const map = Object.fromEntries(icons);
  (info.equipment || []).forEach(it => { it.icon = map[it.id] || ''; });
  info.icons_v = 2;
}

// Everything Blizzard has on one character, cached for half an hour.
async function characterInfo(s, c) {
  const cached = await s.get(`info/${c.key}`, { type: 'json' });
  if (cached && cached.v === INFO_V && Date.now() - cached.at < INFO_TTL_MS) {
    if (cached.available && cached.icons_v !== 2) {
      const token = await blizzToken(s);
      if (token) { await addIcons(s, token, cached); await s.setJSON(`info/${c.key}`, cached); }
    }
    return cached;
  }
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
    v: INFO_V, at: Date.now(), available: !!res.profile,
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
      tiers: (pr.tiers || [pr]).map(t => ({ name: nm(t.tier) || nm(pr.profession), skill: t.skill_points ?? null, max: t.max_skill_points ?? null,
        recipes: Array.isArray(t.known_recipes) ? t.known_recipes.map(nm).filter(Boolean) : null }))
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
  await addIcons(s, token, info);
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

function profList(body) {
  const nm = o => o?.name ?? '';
  return ['primaries', 'secondaries'].flatMap(k => (body?.[k] || []).map(pr => {
    const tiers = pr.tiers || [pr];
    return {
      name: nm(pr.profession), primary: k === 'primaries',
      skill: Math.max(0, ...tiers.map(t => t.skill_points || 0)), max: Math.max(0, ...tiers.map(t => t.max_skill_points || 0)),
      recipes: [...new Map(tiers.flatMap(t => (t.known_recipes || []).filter(r => nm(r)).map(r => [nm(r), { id: r.id ?? null, name: nm(r) }]))).values()]
        .sort((a, b) => a.name.localeCompare(b.name))
    };
  })).filter(p => p.name);
}

/* ---------- Officers ---------- */
const rid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
async function officerRoute(s, route, body) {
  if (route === 'officer/login') {
    const expected = process.env.OFFICER_PASSWORD;
    if (!expected) return json({ error: 'The officer password hasn’t been set up yet.' }, 503);
    const who = clean(body.name, 40);
    const key = 'officer-tries/' + clean(body.device, 64);
    const tries = (await s.get(key, { type: 'json' })) || { n: 0, at: 0 };
    if (tries.n >= 5 && Date.now() - tries.at < 10 * 60 * 1000) return json({ error: 'Too many tries. Wait a few minutes.' }, 429);
    if (String(body.password || '') !== expected) {
      await s.setJSON(key, { n: Date.now() - tries.at > 10 * 60 * 1000 ? 1 : tries.n + 1, at: Date.now() });
      return json({ error: 'That’s not the officer password.' }, 403);
    }
    const token = rid() + rid();
    await s.setJSON(`officer-session/${token}`, { who: who || 'Officer', at: Date.now() });
    await log(s, 'officer-login', who || 'Officer', body.device || 'web');
    return json({ ok: true, token, who: who || 'Officer' });
  }
  const sess = body.token ? await s.get(`officer-session/${clean(body.token, 100)}`, { type: 'json' }) : null;
  if (!sess || Date.now() - sess.at > 60 * 24 * 60 * 60 * 1000) return json({ error: 'Officer login expired. Log in again.', needsLogin: true }, 401);
  const who = sess.who;

  if (route === 'officer/data') {
    const chars = await allChars(s);
    const signs = await Promise.all(chars.map(c => s.get(`signup/dec9/${c.key}`, { type: 'json' })));
    const { blobs } = await s.list({ prefix: 'log/' });
    const recent = blobs.map(b => b.key).sort().reverse().slice(0, 200);
    const logs = (await Promise.all(recent.map(k => s.get(k, { type: 'json' })))).filter(Boolean);
    return json({
      who,
      characters: chars.filter(c => c.key).map((c, i) => ({ ...publicChar(c), claims: (c.claims || []).length, signup: signs[i] || null })),
      log: logs
    });
  }
  const c = body.key ? await s.get(`char/${clean(body.key, 40)}`, { type: 'json' }) : null;
  if (route === 'officer/remove-signup') {
    if (!c) return json({ error: 'Character not found' }, 404);
    await s.delete(`signup/dec9/${c.key}`);
    await log(s, 'officer-remove-signup', c.name, 'officer', { by: who });
    await refreshBoard(s).catch(() => {});
    return json({ ok: true });
  }
  if (route === 'officer/release') {
    if (!c) return json({ error: 'Character not found' }, 404);
    await s.setJSON(`char/${c.key}`, { ...c, claims: [] });
    await log(s, 'officer-release', c.name, 'officer', { by: who });
    return json({ ok: true });
  }
  if (route === 'officer/delete-char') {
    if (!c) return json({ error: 'Character not found' }, 404);
    if (c.synced && c.in_guild !== false) return json({ error: 'This character is in the guild roster, so it would come right back on the next sync. Release the claim or remove the signup instead.' }, 400);
    await s.delete(`char/${c.key}`);
    await s.delete(`signup/dec9/${c.key}`);
    await s.delete(`info/${c.key}`);
    await log(s, 'officer-delete', c.name, 'officer', { by: who });
    return json({ ok: true });
  }
  if (route === 'officer/emojis') {
    // Server emoji codes for the Discord summary: paste any text holding <:name:id> codes.
    const cur = (await s.get('meta/emoji-codes', { type: 'json' })) || {};
    if (typeof body.text === 'string') {
      const found = {};
      for (const m of body.text.slice(0, 20000).matchAll(/<(a?):(\w{2,32}):(\d{5,25})>/g)) found[m[2]] = `<${m[1]}:${m[2]}:${m[3]}>`;
      if (!Object.keys(found).length) return json({ error: 'No emoji codes found. They look like <:paladin_holy:1234567890>.' }, 400);
      const next = { ...cur, ...found };
      await s.setJSON('meta/emoji-codes', next);
      return json({ ok: true, added: Object.keys(found), codes: { ...DEFAULT_CODES, ...next } });
    }
    return json({ codes: { ...DEFAULT_CODES, ...cur } });
  }
  if (route === 'officer/board') {
    // Old-school bulletin board for site and officer ideas.
    const action = body.action;
    if (action === 'add') {
      const text = clean(body.text, 1000);
      if (!text) return json({ error: 'Write something first' }, 400);
      const id = new Date().toISOString() + '-' + Math.random().toString(36).slice(2, 6);
      await s.setJSON(`board/${id}`, { id, text, tag: ['site', 'officer', 'other'].includes(body.tag) ? body.tag : 'site', by: clean(body.by, 40) || who, status: 'open', at: new Date().toISOString() });
    } else if (action === 'status' || action === 'delete') {
      const id = clean(body.id, 80), doc = await s.get(`board/${id}`, { type: 'json' });
      if (!doc) return json({ error: 'Post not found' }, 404);
      if (action === 'delete') await s.delete(`board/${id}`);
      else await s.setJSON(`board/${id}`, { ...doc, status: ['open', 'doing', 'done'].includes(body.status) ? body.status : doc.status });
    }
    const { blobs } = await s.list({ prefix: 'board/' });
    const posts = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
    return json({ ok: true, posts });
  }
  /* ---------- DKP ---------- */
  if (route.startsWith('officer/dkp-')) {
    const chars = (await allChars(s)).filter(x => x.key);
    const byKey = Object.fromEntries(chars.map(x => [x.key, x]));
    const pname = p => byKey[p]?.name || p;
    const num = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    if (route === 'officer/dkp-data') {
      const { cfg, st, drafts, balances } = await DKP.draftSheet(s);
      const { blobs: nb } = await s.list({ prefix: 'dkp/nights/' });
      const nights = (await Promise.all(nb.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
      const people = [...new Set([...Object.keys(st.approved), ...Object.keys(balances)])].map(p => ({
        person: p, name: pname(p), alts: chars.filter(x => x.alt_of === p).map(x => x.name),
        approved: st.approved[p] || 0, draft: balances[p] || 0
      })).sort((a, b) => b.draft - a.draft || a.name.localeCompare(b.name));
      return json({ settings: cfg, approvedAt: st.approvedAt || null, approvedBy: st.approvedBy || '', people, nights,
        drafts: drafts.map(t => ({ ...t, name: pname(t.person), charName: byKey[t.char]?.name || '' })),
        links: chars.filter(x => x.alt_of).map(x => ({ key: x.key, name: x.name, main: x.alt_of, mainName: pname(x.alt_of) })) });
    }
    if (route === 'officer/dkp-night') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
      const list = k => (Array.isArray(body[k]) ? body[k] : []).map(x => clean(x, 40)).filter(x => byKey[x]);
      const r = await DKP.recordNight(s, { date, group: clean(body.group, 40), start: list('start'), end: list('end'), bench: list('bench'), by: who }, byKey);
      if (!r.people) return json({ error: 'Tick at least one person.' }, 400);
      await log(s, 'dkp-night', `${date}${r.night.group ? ' ' + r.night.group : ''}`, 'officer', { by: who, people: r.people });
      return json({ ok: true, people: r.people });
    }
    if (route === 'officer/dkp-award' || route === 'officer/dkp-adjust') {
      const ch = byKey[clean(body.char, 40)];
      if (!ch) return json({ error: 'Pick a character from the list.' }, 400);
      const award = route === 'officer/dkp-award';
      const amt = num(body.amount, award ? 0 : -1000, 1000);
      if (amt === null) return json({ error: 'Enter a whole number.' }, 400);
      if (award && !clean(body.item, 80)) return json({ error: 'Enter the item name.' }, 400);
      if (!award && !clean(body.note, 120)) return json({ error: 'Add a short reason.' }, 400);
      if (award) {
        // Spendable = last approved balance, minus anything already spent or taken since.
        // Points earned since then don't count until the sheet is approved; starting DKP counts right away.
        const { cfg, st, drafts } = await DKP.draftSheet(s);
        const have = DKP.apply(st.approved, drafts.filter(t => t.delta < 0 || t.kind === 'start'), cfg.cap)[DKP.personOf(ch)] || 0;
        if (amt > have) return json({ error: `${byKey[DKP.personOf(ch)]?.name || ch.name} only has ${have} DKP to spend. Points from raids since the last approved sheet don’t count yet.` }, 400);
      }
      const t = await DKP.addTx(s, { person: DKP.personOf(ch), char: ch.key, delta: award ? -amt : amt, kind: award ? 'award' : 'adjust',
        item: award ? clean(body.item, 80) : undefined, night: clean(body.night, 40) || undefined, note: clean(body.note, 120) || undefined, by: who });
      await log(s, award ? 'dkp-award' : 'dkp-adjust', ch.name, 'officer', { by: who, delta: t.delta, item: t.item, note: t.note });
      return json({ ok: true });
    }
    if (route === 'officer/dkp-tx-delete') {
      const t = await s.get(`dkp/tx/${clean(body.id, 80)}`, { type: 'json' });
      if (!t) return json({ error: 'Already gone.' }, 404);
      if (t.status !== 'draft') return json({ error: 'Approved changes can’t be removed. Add an adjustment instead.' }, 400);
      await s.delete(`dkp/tx/${t.id}`);
      return json({ ok: true });
    }
    if (route === 'officer/dkp-approve') {
      const r = await DKP.approve(s, who);
      if (!r.changes) return json({ error: 'Nothing new to approve.' }, 400);
      await log(s, 'dkp-approve', `${r.changes} changes`, 'officer', { by: who });
      return json({ ok: true, ...r });
    }
    if (route === 'officer/dkp-link') {
      const alt = byKey[clean(body.alt, 40)];
      if (!alt) return json({ error: 'Pick the alt from the list.' }, 400);
      if (body.main) {
        const main = byKey[clean(body.main, 40)];
        if (!main) return json({ error: 'Pick the main from the list.' }, 400);
        const root = DKP.personOf(main);
        if (root === alt.key) return json({ error: 'That would make a character its own alt.' }, 400);
        if (chars.some(x => x.alt_of === alt.key)) return json({ error: `${alt.name} has alts of its own. Move those first.` }, 400);
        await s.setJSON(`char/${alt.key}`, { ...alt, alt_of: root });
        await log(s, 'dkp-link', alt.name, 'officer', { by: who, main: byKey[root]?.name });
      } else {
        const { alt_of, ...rest } = alt;
        await s.setJSON(`char/${alt.key}`, rest);
        await log(s, 'dkp-unlink', alt.name, 'officer', { by: who });
      }
      return json({ ok: true });
    }
    if (route === 'officer/dkp-decay') {
      const n = await DKP.addDecay(s, who, true);
      await log(s, 'dkp-decay', `${n} people`, 'officer', { by: who });
      return json({ ok: true, people: n });
    }
    if (route === 'officer/dkp-reset') {
      if (body.confirm !== 'RESET') return json({ error: 'Type RESET to confirm.' }, 400);
      const n = await DKP.resetAll(s);
      await log(s, 'dkp-reset', `${n} records`, 'officer', { by: who });
      return json({ ok: true, removed: n });
    }
    if (route === 'officer/dkp-settings') {
      const cur = await DKP.settings(s), next = { ...cur };
      for (const [k, lo, hi] of [['cap', 1, 10000], ['start', 0, 1000], ['attendStart', 0, 100], ['attendEnd', 0, 100], ['decay', 0, 100]]) {
        if (body[k] !== undefined) { const n = num(body[k], lo, hi); if (n === null) return json({ error: `Check the ${k} number.` }, 400); next[k] = n; }
      }
      await s.setJSON('dkp/settings', next);
      await log(s, 'dkp-settings', 'DKP settings', 'officer', { by: who, ...next });
      return json({ ok: true, settings: next });
    }
    return json({ error: 'Not found' }, 404);
  }
  if (route === 'officer/discord-setup') {
    // Adds the bot's /signup commands to Discord and hands back the invite link.
    const r = await registerCommands();
    if (!r.ok) return json({ error: r.error }, 400);
    const board = await s.get('meta/discord-board', { type: 'json' });
    return json({ ok: true, invite: r.invite, board: !!board });
  }
  if (route === 'officer/post-summary') {
    const r = await postSummary(s, { reason: '' });
    if (r.ok) await log(s, 'officer-post-summary', 'Discord', 'officer', { by: who });
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
  }
  return json({ error: 'Not found' }, 404);
}

export default async (req, context) => {
  const s = store();
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '');

  try {
    if (req.method === 'POST' && route === 'discord') {
      // Discord bot: clicks and commands, checked against Discord's signature.
      return await handleDiscord(req, s, context, { clean, slug, allChars, roleFields, SPECS, DEC9, ATTUNE, LATER, ETA, log });
    }
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
          signup: sign[i] ? { dec9: sign[i].dec9, attune: sign[i].attune, later: sign[i].later, eta: sign[i].eta, discord: sign[i].discord || '' } : null
        })),
        synced_at: sync && sync.ok ? sync.at : null,
        aliases: (await s.get('meta/aliases', { type: 'json' })) || {}
      });
    }

    if (req.method === 'GET' && route === 'recipe') {
      const id = parseInt(url.searchParams.get('id'), 10);
      if (!id) return json({ error: 'Missing recipe id' }, 400);
      const cached = await s.get(`recipe/${id}`, { type: 'json' });
      if (cached && cached.v === RECIPE_V) return Response.json(cached, { headers: { 'Cache-Control': 'public, max-age=86400' } });
      const token = await blizzToken(s);
      if (!token) return json({ error: 'Game data unavailable' }, 503);
      const out = await recipeDetail(s, token, id);
      if (!out) return json({ error: 'Recipe not found' }, 404);
      await s.setJSON(`recipe/${id}`, out);
      return Response.json(out, { headers: { 'Cache-Control': 'public, max-age=86400' } });
    }

    if (req.method === 'GET' && route === 'class-icons') {
      let icons = await s.get('meta/class-icons', { type: 'json' });
      if (!icons) {
        const token = await blizzToken(s);
        if (!token) return json({ error: 'Game data unavailable' }, 503);
        icons = {};
        await Promise.all(Object.entries(CLASS_IDS).map(async ([id, cls]) => {
          for (const ns of ['static-forever-us', 'static-classic1x-us', 'static-us']) {
            const r = await bget(token, `/data/wow/media/playable-class/${id}`, ns);
            const u = (r.body?.assets || []).find(a => a.key === 'icon')?.value;
            if (u) { icons[cls] = u; break; }
          }
        }));
        if (Object.keys(icons).length) await s.setJSON('meta/class-icons', icons);
      }
      return Response.json(icons, { headers: { 'Cache-Control': 'public, max-age=86400' } });
    }

    if (req.method === 'GET' && route === 'recipe-index') {
      // Every recipe in the game (by profession) plus the short details the search uses.
      const [cat, idx] = await Promise.all([s.get('meta/recipe-catalog', { type: 'json' }), s.get('meta/recipe-index', { type: 'json' })]);
      const entries = idx?.e || {};
      const total = new Set(Object.values(cat?.profs || {}).flatMap(p => p.recipes.map(r => r[0]))).size;
      return Response.json({ catalog: cat?.profs || {}, index: entries, done: Object.keys(entries).length, total },
        { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    if (req.method === 'GET' && route === 'crafting') {
      const meta = await s.get('meta/sync', { type: 'json' });
      if (syncDue(meta, false)) { const job = syncGuild(s, false); if (context?.waitUntil) context.waitUntil(job); else await job; }
      const chars = (await allChars(s)).filter(c => c.key && c.synced && c.in_guild !== false);
      const profs = await Promise.all(chars.map(c => s.get(`prof/${c.key}`, { type: 'json' })));
      const out = {};
      chars.forEach((c, i) => (profs[i] || []).forEach(p => {
        const P = out[p.name] || (out[p.name] = { primary: p.primary, crafters: [], recipes: {} });
        const P2 = out[p.name]; P2.ids = P2.ids || {};
        P.crafters.push({ key: c.key, name: c.name, cls: c.cls, level: c.level, skill: p.skill, max: p.max, count: p.recipes.length });
        p.recipes.forEach(r => {
          const name = typeof r === 'string' ? r : r.name;
          if (r && r.id) P2.ids[name] = r.id;
          (P.recipes[name] || (P.recipes[name] = [])).push(c.key);
        });
      }));
      const scanned = chars.filter(c => c.prof_at).length;
      // Standings with the factions that sell recipes, for everyone who crafts.
      const idx = await s.get('meta/recipe-index', { type: 'json' });
      const fids = new Set(Object.values(idx?.e || {}).map(e => e.rep?.fid).filter(Boolean).map(String));
      const crafters = chars.filter((c, i) => (profs[i] || []).length);
      const repDocs = await Promise.all(crafters.map(c => s.get(`rep/${c.key}`, { type: 'json' })));
      const reps = {};
      crafters.forEach((c, i) => { const r = repDocs[i]; if (!r) return; reps[c.key] = Object.fromEntries(Object.entries(r.f || {}).filter(([f]) => fids.has(f))); });
      return json({ professions: out, scanned, total: chars.length, reps });
    }

    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body = await req.json().catch(() => ({}));
    if (route.startsWith('officer/')) return await officerRoute(s, route, body);
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

    if (route === 'discord') {
      // Change the Discord name tied to this browser (and its saved signups).
      const discord = clean(body.discord, 40);
      if (!discord) return json({ error: 'Add your Discord name' }, 400);
      const verified = await s.get(`verified/${device}`, { type: 'json' });
      const all = await allChars(s);
      const owned = all.filter(c => (c.claims || []).includes(device));
      if (!verified && !owned.length) return json({ error: 'Claim a character first.' }, 403);
      if (verified) await s.setJSON(`verified/${device}`, { ...verified, discord });
      else await s.setJSON(`discord/${device}`, { discord, at: new Date().toISOString() });
      for (const c of owned) {
        const sg = await s.get(`signup/dec9/${c.key}`, { type: 'json' });
        if (sg) await s.setJSON(`signup/dec9/${c.key}`, { ...sg, discord });
      }
      await log(s, 'discord', discord, device, { from: verified?.discord || '' });
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
          if (!f.main_role) return json({ error: 'Pick a main spec' }, 400);
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
      const changed = ['cls', 'level', 'main_role', 'also_play', 'main_spec', 'also_specs'].filter(k => JSON.stringify(next[k]) !== JSON.stringify(c[k]));
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
        discord: '', notes: clean(body.notes, 1000), at: new Date().toISOString()
      };
      // Discord name comes from the one-time guild check; older browsers can still send it.
      const verified = await s.get(`verified/${device}`, { type: 'json' });
      const prevSign = await s.get(`signup/dec9/${c.key}`, { type: 'json' });
      const named = verified ? null : await s.get(`discord/${device}`, { type: 'json' });
      doc.discord = clean(verified?.discord || named?.discord || body.discord || prevSign?.discord, 40);
      await s.setJSON(`signup/dec9/${c.key}`, doc);
      await log(s, 'signup', c.name, device, { dec9 });
      if (context?.waitUntil) context.waitUntil(refreshBoard(s).catch(() => {}));
      return json({ ok: true });
    }

    if (route === 'withdraw') {
      await s.delete(`signup/dec9/${c.key}`);
      await log(s, 'withdraw', c.name, device);
      if (context?.waitUntil) context.waitUntil(refreshBoard(s).catch(() => {}));
      return json({ ok: true });
    }

    if (route === 'mine') return json({ ok: true, signup: (await s.get(`signup/dec9/${c.key}`, { type: 'json' })) || null });

    if (route === 'dkp') {
      // Approved DKP for this character's person (main plus alts), with recent history.
      const person = DKP.personOf(c);
      const [st, main, txs] = await Promise.all([DKP.state(s), s.get(`char/${person}`, { type: 'json' }), DKP.allTx(s, 'approved')]);
      const mine = txs.filter(t => t.person === person).slice(-40).reverse()
        .map(t => ({ at: t.at, delta: t.delta, kind: t.kind, item: t.item || '', note: t.note || '' }));
      return json({ ok: true, person, main: main?.name || c.name, balance: st.approved[person] || 0, approvedAt: st.approvedAt || null, history: mine });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
};

export const config = { path: '/api/*' };
