// Blizzard game data shared by the API and the scheduled recipe indexer.
export const API = 'https://us.api.blizzard.com';
export const NS = 'profile-forever-us';
const STATIC = 'static-forever-us';
export const RECIPE_V = 2; // bump to rebuild cached recipe details
export const STANDINGS = ['Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];

export async function blizzToken(s) {
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

export async function bget(token, path, ns = NS) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}namespace=${ns}&locale=en_US`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return { status: r.status, body: null };
  return { status: 200, body: await r.json() };
}

// Item icons are static game data: look each one up once and keep it.
// Forever's own namespace first, then Classic and Retail (item ids are shared).
export async function iconFor(s, token, id) {
  let url = await s.get(`icon/${id}`);
  if (url && url.startsWith('none:') && Date.now() - Number(url.slice(5)) < 86400000) return '';
  if (!url || url.startsWith('none:')) {
    for (const ns of [STATIC, 'static-classic1x-us', 'static-us']) {
      const r = await bget(token, `/data/wow/media/item/${id}`, ns);
      url = (r.body?.assets || []).find(a => a.key === 'icon')?.value || '';
      if (url) break;
    }
    await s.set(`icon/${id}`, url || 'none:' + Date.now());
  }
  return /^https:\/\//.test(url || '') ? url : '';
}

const nm = o => (typeof o?.name === 'object' ? o.name?.en_US : o?.name) ?? '';
const ds = x => x?.display_string || x?.display?.display_string || '';

// The item that teaches a recipe ("Pattern: X", "Formula: X"…), found by name.
async function patternFor(token, recipeName) {
  const r = await bget(token, `/data/wow/search/item?name.en_US=${encodeURIComponent(recipeName)}&_pageSize=20`, STATIC);
  const want = ': ' + recipeName.toLowerCase();
  const hit = (r.body?.results || []).map(x => x.data).find(d => d?.item_class?.id === 9 && String(d.name?.en_US || '').toLowerCase().endsWith(want));
  if (!hit) return null;
  const it = (await bget(token, `/data/wow/item/${hit.id}`, STATIC)).body;
  const rq = it?.preview_item?.requirements || {};
  const rep = rq.reputation?.faction ? {
    faction: nm(rq.reputation.faction), fid: rq.reputation.faction.id, level: rq.reputation.min_reputation_level ?? null,
    text: rq.reputation.display_string || ''
  } : null;
  return { id: hit.id, name: hit.name?.en_US || '', quality: hit.quality?.type || '', skill: rq.skill?.level ?? null, rep };
}

// Everything the site shows about one recipe: the item it makes, reagents, and how it’s learned.
export async function recipeDetail(s, token, id) {
  const rec = (await bget(token, `/data/wow/recipe/${id}`, STATIC)).body;
  if (!rec) return null;
  const itemRef = rec.crafted_item || rec.alliance_crafted_item || rec.horde_crafted_item;
  const out = {
    v: RECIPE_V, id, name: nm(rec), description: rec.description || '',
    quantity: rec.crafted_quantity?.value ?? rec.crafted_quantity?.minimum ?? null,
    reagents: (rec.reagents || []).map(r => ({ name: nm(r.reagent), qty: r.quantity })),
    item: null, pattern: null, icon: ''
  };
  const jobs = [patternFor(token, out.name).catch(() => null)];
  if (itemRef?.id) jobs.push(bget(token, `/data/wow/item/${itemRef.id}`, STATIC).then(r => r.body));
  const [pattern, it] = await Promise.all(jobs);
  out.pattern = pattern;
  if (it) {
    const pv = it.preview_item || {};
    out.item = {
      id: itemRef.id, name: nm(it), quality: it.quality?.type || pv.quality?.type || '',
      binding: nm(pv.binding), slot: nm(pv.inventory_type), type: nm(pv.item_subclass) || nm(it.item_subclass),
      armor: ds(pv.armor), damage: ds(pv.weapon?.damage), speed: ds(pv.weapon?.attack_speed), dps: ds(pv.weapon?.dps),
      stats: (pv.stats || []).map(ds).filter(Boolean),
      spells: (pv.spells || []).map(sp => sp.description).filter(Boolean),
      durability: ds(pv.durability), level: ds(pv.requirements?.level), skill: ds(pv.requirements?.skill),
      description: pv.description || '', icon: ''
    };
    out.item.icon = await iconFor(s, token, itemRef.id);
  }
  // Enchants and the like make no item: use the recipe item’s icon instead.
  out.icon = out.item?.icon || (pattern ? await iconFor(s, token, pattern.id) : '');
  return out;
}

// The short version every search needs: one line of stats and the words to search in.
export function compact(d, prof) {
  const it = d.item;
  const short = t => String(t).replace(/^(Equip|Use|Chance on hit): /i, '');
  const bits = it
    ? [it.slot && it.slot !== 'Non-equippable' ? it.slot : '', it.type && it.type !== it.slot ? it.type : '', it.armor, it.dps, ...it.stats, ...it.spells.map(short)]
    : [d.description];
  const line = bits.filter(Boolean).join(' · ');
  return {
    n: d.name, p: prof, q: it?.quality || '', ic: d.icon || '', l: line.slice(0, 240),
    // Extra words to search beyond the name and stat line: flavor text and reagents.
    t: [it?.description, it ? d.description : '', ...(d.reagents || []).map(r => r.name)].filter(Boolean).join(' | ').toLowerCase().slice(0, 300),
    sk: d.pattern?.skill ?? null,
    src: d.pattern ? { id: d.pattern.id, name: d.pattern.name } : null,
    rep: d.pattern?.rep || null
  };
}

// Every recipe each profession has, from Blizzard's profession data.
// Season of Discovery categories exist in the data but not on Forever, so they’re left out.
export async function buildCatalog(token) {
  const idx = (await bget(token, '/data/wow/profession/index', STATIC)).body;
  const profs = {};
  for (const p of idx?.professions || []) {
    const pr = (await bget(token, `/data/wow/profession/${p.id}`, STATIC)).body;
    const recipes = [];
    for (const t of pr?.skill_tiers || []) {
      const tb = (await bget(token, `/data/wow/profession/${p.id}/skill-tier/${t.id}`, STATIC)).body;
      for (const c of tb?.categories || []) {
        if (/season of discovery/i.test(c.name || '')) continue;
        for (const r of c.recipes || []) if (r.id && r.name) recipes.push([r.id, r.name, c.name]);
      }
    }
    if (recipes.length) profs[p.name] = { id: p.id, recipes };
  }
  return { at: Date.now(), profs };
}
