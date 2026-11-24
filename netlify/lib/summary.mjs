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
  const role = k => going.filter(r => r.c.main_role === k).length;
  const at60 = chars.filter(c => c.level >= 60).length;
  const days = Math.round((Date.UTC(2026, 11, 9) - Date.UTC(...todayET())) / 86400000);
  const when = days > 1 ? `${days} days to go` : days === 1 ? 'Tomorrow!' : days === 0 ? 'Tonight!' : '';
  const embed = {
    title: 'December 9 raid signups' + (when ? ` · ${when}` : ''),
    url: 'https://mysticdragons.org/signup',
    color: 0xA3BC6E,
    fields: [
      { name: 'Yes', value: String(yes.length), inline: true },
      { name: 'Probably', value: String(maybe.length), inline: true },
      { name: 'Not sure yet', value: String(unsure.length), inline: true },
      { name: 'Roles (yes + probably)', value: ORDER.map(k => `${k}: **${role(k)}**`).join('\n'), inline: true },
      { name: 'Guild', value: `${chars.length} members\n${at60} at level 60\n${chars.length - rows.length} haven’t signed up`, inline: true }
    ],
    footer: { text: 'Sign up or change your answer at mysticdragons.org/signup' }
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
