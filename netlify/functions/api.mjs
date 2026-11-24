// Guild roster API: characters people claim, and their raid signups.
// Data lives in Netlify Blobs (store "guild"). No logins: each browser has a random
// device id, and a character can be claimed from more than one device.
import { getStore } from '@netlify/blobs';

const CLASSES = {
  Warrior: ['Tank', 'Melee DPS'], Paladin: ['Tank', 'Healer', 'Melee DPS'], Hunter: ['Ranged DPS', 'Melee DPS'],
  Rogue: ['Melee DPS'], Priest: ['Healer', 'Ranged DPS'], Shaman: ['Healer', 'Melee DPS', 'Ranged DPS'],
  Mage: ['Ranged DPS'], Warlock: ['Ranged DPS'], Druid: ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS']
};
const DEC9 = ['Yes', 'Probably', 'Not sure yet', 'No'];
const LATER = ['Yes', 'Probably', 'Not sure yet', 'Not planning to raid'];
const ETA = ['Sometime in December', 'After the holidays', 'No idea yet'];
const ATTUNE = ['I’ve done it', 'I’ll try to do it', 'I’ll need help', 'What attunement?', 'Probably won’t have time'];

const CLASS_IDS = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
const GUILD = 'mystic-dragons';
const SYNC_EVERY_MS = 20 * 60 * 1000;

const store = () => getStore({ name: 'guild', consistency: 'strong' });
const slug = n => String(n || '').trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const pick = (v, list) => (list.includes(v) ? v : '');
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

async function allChars(s) {
  const { blobs } = await s.list({ prefix: 'char/' });
  const docs = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
  return docs.filter(Boolean);
}
async function log(s, action, name, device, details = {}) {
  const at = new Date().toISOString();
  await s.setJSON(`log/${at}-${Math.random().toString(36).slice(2, 8)}`, { at, action, character: name, device: String(device).slice(0, 12), ...details });
}
function charFields(body, prev = {}) {
  const cls = CLASSES[body.cls] ? body.cls : prev.cls || '';
  const roles = CLASSES[cls] || [];
  const main = roles.includes(body.main_role) ? body.main_role : (roles.length === 1 ? roles[0] : prev.main_role || '');
  const also = (Array.isArray(body.also_play) ? body.also_play : String(body.also_play || '').split(','))
    .map(x => String(x).trim()).filter(x => roles.includes(x) && x !== main);
  const level = Math.max(1, Math.min(60, parseInt(body.level, 10) || prev.level || 1));
  return { cls, level, main_role: main, also_play: [...new Set(also)] };
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
    subs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); // oldest first, newest wins
    const latest = new Map();
    for (const sub of subs) { const d = sub.data || {}; if (d.character && CLASSES[d.class]) latest.set(slug(d.character), { d, at: sub.created_at }); }
    for (const [key, { d, at }] of latest) {
      const f = charFields({ cls: d.class, level: d.level, main_role: d.main_role, also_play: d.also_play });
      await s.setJSON(`char/${key}`, { name: clean(d.character, 24), ...f, claims: [], created_at: at, updated_at: at });
      await s.setJSON(`signup/dec9/${key}`, {
        dec9: pick(d.dec9, DEC9), later: pick(d.raid_after, LATER), eta: pick(d.ready_by, ETA),
        attune: pick(d.attunement, ATTUNE), discord: clean(d.discord, 40), notes: clean(d.notes, 1000), at
      });
    }
    await log(s, 'import', `${latest.size} characters`, 'system');
  } catch (_) { /* leave whatever imported */ }
}

// Pull the WoW Forever guild roster from Blizzard (no realms: guild by name, profile-forever-us).
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
async function syncGuild(s, force) {
  const meta = await s.get('meta/sync', { type: 'json' });
  if (!force && meta && Date.now() - meta.at < SYNC_EVERY_MS) return meta;
  await s.setJSON('meta/sync', { ...(meta || {}), at: Date.now() }); // claim this sync window
  try {
    const token = await blizzToken(s);
    if (!token) return meta;
    const r = await fetch(`https://us.api.blizzard.com/data/wow/guild/${GUILD}/roster?namespace=profile-forever-us&locale=en_US`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return meta;
    const members = ((await r.json()).members || []).map(m => ({
      name: clean(m.character?.name, 24), level: parseInt(m.character?.level, 10) || 1,
      cls: CLASS_IDS[m.character?.playable_class?.id] || '', rank: m.rank
    })).filter(m => m.name && m.cls);
    const existing = await allChars(s);
    const now = new Date().toISOString();
    for (const m of members) {
      const key = slug(m.name);
      let doc = existing.find(c => slug(c.name) === key);
      if (!doc) {
        // Someone typed "First Last" before the sync existed: merge it into the guild character.
        doc = existing.find(c => !c.synced && slug(c.name).split(' ')[0] === key);
        if (doc) {
          const oldKey = slug(doc.name);
          const sign = await s.get(`signup/dec9/${oldKey}`, { type: 'json' });
          if (sign) { await s.setJSON(`signup/dec9/${key}`, sign); await s.delete(`signup/dec9/${oldKey}`); }
          await s.delete(`char/${oldKey}`);
          doc.full_name = doc.name;
          await log(s, 'merge', m.name, 'system', { from: doc.name });
        }
      }
      const roles = CLASSES[m.cls];
      const keepRoles = doc && doc.cls === m.cls;
      const next = {
        claims: [], created_at: now, ...(doc || {}),
        name: m.name, cls: m.cls, level: m.level, rank: m.rank, synced: true, in_guild: true,
        main_role: keepRoles ? doc.main_role : (roles.length === 1 ? roles[0] : ''),
        also_play: keepRoles ? (doc.also_play || []) : [],
        updated_at: doc && doc.level === m.level && doc.cls === m.cls ? doc.updated_at : now
      };
      if (!doc || JSON.stringify(doc) !== JSON.stringify(next)) await s.setJSON(`char/${key}`, next);
    }
    const names = new Set(members.map(m => slug(m.name)));
    for (const c of existing) if (c.synced && c.in_guild && !names.has(slug(c.name))) await s.setJSON(`char/${slug(c.name)}`, { ...c, in_guild: false });
    const out = { at: Date.now(), ok: true, members: members.length };
    await s.setJSON('meta/sync', out);
    return out;
  } catch (_) { return meta; }
}

export default async (req, context) => {
  const s = store();
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '');

  try {
    if (req.method === 'GET' && route === 'roster') {
      await seedFromForms(s, context);
      const sync = await syncGuild(s, url.searchParams.get('sync') === '1');
      const chars = (await allChars(s)).filter(c => c.in_guild !== false || (c.claims || []).length);
      const sign = await Promise.all(chars.map(c => s.get(`signup/dec9/${slug(c.name)}`, { type: 'json' })));
      return json({
        characters: chars.map((c, i) => ({
          name: c.name, cls: c.cls, level: c.level, main_role: c.main_role, also_play: c.also_play,
          claimed: (c.claims || []).length > 0, updated_at: c.updated_at, synced: !!c.synced,
          signup: sign[i] ? { dec9: sign[i].dec9, attune: sign[i].attune, later: sign[i].later, eta: sign[i].eta } : null
        })),
        synced_at: sync && sync.ok ? sync.at : null
      });
    }

    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body = await req.json().catch(() => ({}));
    const device = clean(body.device, 64);
    if (device.length < 8) return json({ error: 'Missing device id' }, 400);
    const name = clean(body.name, 24);
    const key = slug(name);
    if (!key) return json({ error: 'Missing character name' }, 400);
    const prev = await s.get(`char/${key}`, { type: 'json' });

    if (route === 'claim') {
      // Claim an existing character, or create a new one.
      if (!prev) {
        const f = charFields(body);
        if (!f.cls) return json({ error: 'Pick a class' }, 400);
        if (!f.main_role) return json({ error: 'Pick a main role' }, 400);
        const now = new Date().toISOString();
        const doc = { name, ...f, claims: [device], created_at: now, updated_at: now };
        await s.setJSON(`char/${key}`, doc);
        await log(s, 'create', name, device);
        return json({ ok: true, created: true, character: { name, ...f } });
      }
      const claims = prev.claims || [];
      if (claims.length && !claims.includes(device) && !body.confirm) return json({ needsConfirm: true, name: prev.name });
      if (!claims.includes(device)) {
        prev.claims = [...claims, device].slice(-10);
        await s.setJSON(`char/${key}`, prev);
        await log(s, claims.length ? 'claim-again' : 'claim', prev.name, device);
      }
      const { claims: _, ...pub } = prev;
      return json({ ok: true, character: pub });
    }

    if (!prev) return json({ error: 'That character isn’t on the roster yet' }, 404);
    if (!(prev.claims || []).includes(device)) return json({ error: 'Claim this character first' }, 403);

    if (route === 'character') {
      const f = charFields(prev.synced ? { ...body, cls: prev.cls, level: prev.level } : body, prev);
      const changed = Object.keys(f).filter(k => JSON.stringify(f[k]) !== JSON.stringify(prev[k]));
      Object.assign(prev, f, { updated_at: new Date().toISOString() });
      await s.setJSON(`char/${key}`, prev);
      if (changed.length) await log(s, 'update', prev.name, device, { changed });
      const { claims: _, ...pub } = prev;
      return json({ ok: true, character: pub });
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
      await s.setJSON(`signup/dec9/${key}`, doc);
      await log(s, 'signup', prev.name, device, { dec9 });
      return json({ ok: true });
    }

    if (route === 'mine') {
      // A device's own signup, including its private notes and Discord name.
      const sign = await s.get(`signup/dec9/${key}`, { type: 'json' });
      return json({ ok: true, signup: sign || null });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: 'Something went wrong. Try again in a moment.' }, 500);
  }
};

export const config = { path: '/api/*' };
