// Temporary diagnostic: finds which Blizzard API namespace/realm WoW Forever uses
// and whether the "Mystic Dragons" guild roster can be read. Safe to delete later.
const GUILD = 'mystic-dragons';
const NS = ['dynamic-us', 'dynamic-classic-us', 'dynamic-classic1x-us', 'dynamic-forever-us', 'dynamic-classic-forever-us', 'dynamic-classicann-us', 'dynamic-classic2x-us'];

async function token() {
  const id = process.env.BLIZZARD_CLIENT_ID, secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) throw new Error('missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET');
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('token request failed: ' + r.status);
  return (await r.json()).access_token;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);

export default async () => {
  const out = { token: false, namespaces: {}, guild: [] };
  let t;
  try { t = await token(); out.token = true; } catch (e) { out.error = e.message; return Response.json(out); }
  const H = { Authorization: 'Bearer ' + t };
  const get = async (path, ns) => {
    const r = await withTimeout(fetch(`https://us.api.blizzard.com${path}?namespace=${ns}&locale=en_US`, { headers: H }), 4000);
    if (!r) return { status: 'timeout' };
    return { status: r.status, body: r.ok ? await r.json() : null };
  };
  const realmLists = await Promise.all(NS.map(ns => get('/data/wow/realm/index', ns)));
  const candidates = [];
  NS.forEach((ns, i) => {
    const res = realmLists[i];
    const realms = (res.body && res.body.realms) || [];
    out.namespaces[ns] = { status: res.status, realms: realms.length, sample: realms.slice(0, 40).map(r => r.name) };
    if (!realms.length) return;
    const profileNs = ns.replace('dynamic-', 'profile-');
    const pick = ns === 'dynamic-us' ? realms.filter(r => /forever/i.test(r.name)) : realms;
    pick.slice(0, 60).forEach(r => candidates.push({ ns: profileNs, slug: r.slug, name: r.name }));
  });
  const results = await Promise.all(candidates.map(c => get(`/data/wow/guild/${c.slug}/${GUILD}/roster`, c.ns).then(res => ({ c, res }))));
  for (const { c, res } of results) {
    if (res.status === 200 && res.body) {
      const m = res.body.members || [];
      out.guild.push({ namespace: c.ns, realm: c.name, slug: c.slug, members: m.length,
        sample: m.slice(0, 5).map(x => ({ name: x.character?.name, level: x.character?.level, class_id: x.character?.playable_class?.id })) });
    }
  }
  out.guildChecks = candidates.length;
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
};
