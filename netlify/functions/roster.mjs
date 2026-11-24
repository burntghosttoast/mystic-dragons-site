// Returns the public part of the raid-signup form submissions:
// character, class, level, roles and Dec 9 answer. Discord names and notes stay private.
// Needs a NETLIFY_TOKEN environment variable (a Netlify personal access token).
const API = 'https://api.netlify.com/api/v1';

export default async (req, context) => {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) return Response.json({ error: 'NETLIFY_TOKEN is not set' }, { status: 500 });
  const headers = { Authorization: `Bearer ${token}` };
  const siteId = context?.site?.id || process.env.SITE_ID;
  try {
    const formsUrl = siteId ? `${API}/sites/${siteId}/forms` : `${API}/forms`;
    const forms = await (await fetch(formsUrl, { headers })).json();
    const form = Array.isArray(forms) && forms.find(f => f.name === 'raid-signup');
    if (!form) return Response.json({ rows: [] });

    let all = [], page = 1;
    while (page < 50) {
      const res = await fetch(`${API}/forms/${form.id}/submissions?per_page=100&page=${page}`, { headers });
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      all = all.concat(batch);
      if (batch.length < 100) break;
      page++;
    }

    // Keep only each character's latest signup.
    const latest = new Map();
    for (const s of all) {
      const d = s.data || {};
      const name = String(d.character || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = latest.get(key);
      if (!prev || new Date(s.created_at) > new Date(prev.created_at)) latest.set(key, s);
    }
    const rows = [...latest.values()].map(s => {
      const d = s.data || {};
      return {
        character: String(d.character || '').trim().slice(0, 40),
        cls: String(d.class || '').slice(0, 20),
        level: parseInt(d.level, 10) || 0,
        main_role: String(d.main_role || '').slice(0, 20),
        also_play: String(d.also_play || '').slice(0, 60),
        dec9: String(d.dec9 || '').slice(0, 20)
      };
    });
    return Response.json({ rows }, { headers: { 'Cache-Control': 'public, max-age=60' } });
  } catch (e) {
    return Response.json({ error: 'Could not load submissions' }, { status: 502 });
  }
};
