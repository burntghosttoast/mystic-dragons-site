// Builds and posts the raid signup summary to Discord (DISCORD_WEBHOOK_URL).
const ORDER = ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS'];
// Our server's emoji names. Older saves have only a role: a spec icon where class + role tells us the spec, else the class icon.
const SPEC = {
  'Warrior|Tank': 'warrior_prot', 'Paladin|Tank': 'paladin_protection', 'Paladin|Healer': 'paladin_holy', 'Paladin|Melee DPS': 'paladin_ret',
  'Priest|Healer': 'priest_holy', 'Priest|Ranged DPS': 'priest_shadow',
  'Shaman|Healer': 'shaman_resto', 'Shaman|Melee DPS': 'shaman_enhancement', 'Shaman|Ranged DPS': 'shaman_elem',
  'Druid|Tank': 'druid_guardian', 'Druid|Healer': 'druid_resto', 'Druid|Melee DPS': 'druid_feral', 'Druid|Ranged DPS': 'druid_balance'
};
// Picked specs to emoji names.
const SPEC_PICKED = {
  'Warrior|Arms': 'warrior_arms', 'Warrior|Fury': 'warrior_fury', 'Warrior|Protection': 'warrior_prot',
  'Paladin|Holy': 'paladin_holy', 'Paladin|Protection': 'paladin_protection', 'Paladin|Retribution': 'paladin_ret',
  'Hunter|Beast Mastery': 'hunter_bm', 'Hunter|Marksmanship': 'hunter_mm', 'Hunter|Survival': 'hunter_survival',
  'Rogue|Assassination': 'rogue_assa', 'Rogue|Combat': 'rogue_outlaw', 'Rogue|Subtlety': 'rogue_sub',
  'Priest|Discipline': 'priest_disc', 'Priest|Holy': 'priest_holy', 'Priest|Shadow': 'priest_shadow',
  'Shaman|Elemental': 'shaman_elem', 'Shaman|Enhancement': 'shaman_enhancement', 'Shaman|Restoration': 'shaman_resto',
  'Mage|Arcane': 'mage_arcane', 'Mage|Fire': 'mage_fire', 'Mage|Frost': 'mage_frost',
  'Warlock|Affliction': 'warlock_affli', 'Warlock|Demonology': 'warlock_demono', 'Warlock|Destruction': 'warlock_destru',
  'Druid|Balance': 'druid_balance', 'Druid|Feral (Cat)': 'druid_feral', 'Druid|Feral (Bear)': 'druid_guardian', 'Druid|Restoration': 'druid_resto'
};
const CLASS_EMOJI = { Warrior: '777528warrior', Paladin: '338425paladin', Hunter: 'kindpng_5733924', Rogue: '992310rogue', Priest: '424450priest',
  Shaman: '962470shaman', Mage: '934773mage', Warlock: '412823warlock', Druid: '831785druid' };
// Our server's emoji IDs. Officers can add or replace codes on the officer page.
export const DEFAULT_CODES = {
  'warrior_prot': '<:warrior_prot:1553157330764562584>',
  'paladin_protection': '<:paladin_protection:1553157900812165161>',
  'paladin_holy': '<:paladin_holy:1553157911218233505>',
  'paladin_ret': '<:paladin_ret:1553157891907919994>',
  'priest_holy': '<:priest_holy:1553157869443088475>',
  'priest_shadow': '<:priest_shadow:1553157855878578206>',
  'shaman_resto': '<:shaman_resto:1553157792863354970>',
  'shaman_enhancement': '<:shaman_enhancement:1553157802032373861>',
  'shaman_elem': '<:shaman_elem:1553157810768842823>',
  'druid_guardian': '<:druid_guardian:1553158042328240210>',
  'druid_resto': '<:druid_resto:1553158032257716225>',
  'druid_feral': '<:druid_feral:1553158053631762442>',
  'druid_balance': '<:druid_balance:1553158064402726973>',
  '777528warrior': '<:777528warrior:1553158403549827102>',
  '338425paladin': '<:338425paladin:1553158410956972042>',
  'kindpng_5733924': '<:kindpng_5733924:1553157993535901706>',
  '992310rogue': '<:992310rogue:1553172434889220238>',
  '424450priest': '<:424450priest:1553158488526422046>',
  '962470shaman': '<:962470shaman:1553158594776662027>',
  '934773mage': '<:934773mage:1553158582252474429>',
  '412823warlock': '<:412823warlock:1553158511838625892>',
  '831785druid': '<:831785druid:1553158563248214206>',
  '628824tank': '<:628824tank:1553158141645037748>',
  '673275healer': '<:673275healer:1553158131578839111>',
  '454128dps': '<:454128dps:1553158152273399848>'
};
const ROLE_EMOJI = { Tank: '628824tank', Healer: '673275healer', 'Melee DPS': '454128dps', 'Ranged DPS': '454128dps' };

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
  // Icons are our server's emojis; officers paste their codes in on the officer page.
  const codes = { ...DEFAULT_CODES, ...((await s.get('meta/emoji-codes', { type: 'json' })) || {}) };
  const iconFor = c => codes[SPEC_PICKED[`${c.cls}|${c.main_spec}`]] || codes[SPEC[`${c.cls}|${c.main_role}`]] || codes[CLASS_EMOJI[c.cls]] || '';
  const md = t => String(t).replace(/([\\*_~`|>])/g, '\\$1');
  const line = r => {
    const ic = iconFor(r.c);
    const lvl = r.c.level && r.c.level < 60 ? ` · ${r.c.level}` : '';
    const tag = ic ? '' : ` · ${r.c.cls}`;
    return r.sg.dec9 === 'Yes' ? `${ic} **${md(r.c.name)}**${tag}${lvl}`.trim() : `${ic} *${md(r.c.name)}*${tag}${lvl}`.trim();
  };
  const fit = (lines) => { let out = ''; for (let i = 0; i < lines.length; i++) { const next = (out ? out + '\n' : '') + lines[i]; if (next.length > 990) return out + `\n…and ${lines.length - i} more`; out = next; } return out || '—'; };
  const sortR = (a, b) => (a.sg.dec9 === 'Yes' ? 0 : 1) - (b.sg.dec9 === 'Yes' ? 0 : 1) || String(a.c.cls).localeCompare(String(b.c.cls)) || String(a.c.name).localeCompare(String(b.c.name));
  const groups = ORDER.map(k => [k, going.filter(r => r.c.main_role === k)]);
  const noRole = going.filter(r => !ORDER.includes(r.c.main_role));
  const roleName = { Tank: 'Tanks', Healer: 'Healers', 'Melee DPS': 'Melee DPS', 'Ranged DPS': 'Ranged DPS' };
  const blank = { name: '​', value: '​', inline: true };
  const fields = [];
  groups.forEach(([k, list], i) => {
    fields.push({ name: `${codes[ROLE_EMOJI[k]] ? codes[ROLE_EMOJI[k]] + ' ' : ''}${roleName[k]} · ${list.length}`, value: fit(list.sort(sortR).map(line)), inline: true });
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
