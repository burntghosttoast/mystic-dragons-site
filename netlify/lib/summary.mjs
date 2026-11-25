// Builds and posts the raid signup summary to Discord (DISCORD_WEBHOOK_URL).
const ORDER = ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS'];

export async function postSummary(s, { reason = '' } = {}) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return { ok: false, error: 'DISCORD_WEBHOOK_URL isn’t set up yet.' };
  const { blobs } = await s.list({ prefix: 'char/' });
  const chars = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(c => c && c.key && c.in_guild !== false);
  const signs = await Promise.all(chars.map(c => s.get(`signup/dec9/${c.key}`, { type: 'json' })));
  const rows = chars.map((c, i) => ({ c, sg: signs[i] })).filter(r => r.sg);
  const by = a => rows.filter(r => r.sg.dec9 === a);
  const yes = by('Yes'), maybe = by('Probably'), unsure = by('Not sure yet');
  const going = yes.concat(maybe);
  const at60 = chars.filter(c => c.level >= 60).length;
  const days = Math.round((Date.UTC(2026, 11, 9) - Date.UTC(...todayET())) / 86400000);
  const when = days > 1 ? `${days} days to go` : days === 1 ? 'Tomorrow!' : days === 0 ? 'Tonight!' : '';
  // Class icons are server emojis officers paste in on the officer page.
  const icons = (await s.get('meta/class-emojis', { type: 'json' })) || {};
  const md = t => String(t).replace(/([\\*_~`|>])/g, '\\$1');
  const line = r => {
    const ic = icons[r.c.cls] || '';
    const lvl = r.c.level && r.c.level < 60 ? ` · ${r.c.level}` : '';
    const tag = ic ? '' : ` · ${r.c.cls}`;
    return r.sg.dec9 === 'Yes' ? `${ic} **${md(r.c.name)}**${tag}${lvl}`.trim() : `${ic} *${md(r.c.name)}*${tag}${lvl} · probably`.trim();
  };
  const fit = (lines) => { let out = ''; for (let i = 0; i < lines.length; i++) { const next = (out ? out + '\n' : '') + lines[i]; if (next.length > 990) return out + `\n…and ${lines.length - i} more`; out = next; } return out || '—'; };
  const sortR = (a, b) => (a.sg.dec9 === 'Yes' ? 0 : 1) - (b.sg.dec9 === 'Yes' ? 0 : 1) || String(a.c.cls).localeCompare(String(b.c.cls)) || String(a.c.name).localeCompare(String(b.c.name));
  const groups = ORDER.map(k => [k, going.filter(r => r.c.main_role === k)]);
  const noRole = going.filter(r => !ORDER.includes(r.c.main_role));
  const roleName = { Tank: 'Tanks', Healer: 'Healers', 'Melee DPS': 'Melee DPS', 'Ranged DPS': 'Ranged DPS' };
  const blank = { name: '​', value: '​', inline: true };
  const fields = [];
  groups.forEach(([k, list], i) => {
    fields.push({ name: `${roleName[k]} · ${list.length}`, value: fit(list.sort(sortR).map(line)), inline: true });
    if (i % 2 === 1) fields.push(blank); // two roles per row
  });
  if (noRole.length) fields.push({ name: `No role picked · ${noRole.length}`, value: fit(noRole.sort(sortR).map(line)), inline: false });
  if (unsure.length) fields.push({ name: `Not sure yet · ${unsure.length}`, value: fit([unsure.sort(sortR).map(r => md(r.c.name)).join(', ')]), inline: false });
  const embed = {
    title: 'December 9 raid signups' + (when ? ` · ${when}` : ''),
    url: 'https://mysticdragons.org/signup',
    color: 0xA3BC6E,
    description: `**${yes.length}** yes · **${maybe.length}** probably · **${unsure.length}** not sure\n${chars.length - rows.length} of ${chars.length} members haven’t signed up · ${at60} are level 60`,
    fields,
    footer: { text: 'Bold = yes, italic = probably. Sign up or change your answer at mysticdragons.org/signup' }
  };
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Mystic Dragons', content: reason, embeds: [embed], allowed_mentions: { parse: [] } }) });
  if (!r.ok) return { ok: false, error: `Discord said ${r.status}` };
  return { ok: true };
}

export function todayET() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  const g = t => parseInt(p.find(x => x.type === t).value, 10);
  return [g('year'), g('month') - 1, g('day')];
}
