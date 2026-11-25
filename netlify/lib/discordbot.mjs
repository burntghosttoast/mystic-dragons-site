// The Mystic Dragons Discord bot: raid signups from Discord, saved to the same list as the website.
// Discord sends every button click, dropdown pick and command here (Interactions Endpoint URL
// https://mysticdragons.org/api/discord). Nothing runs in between; all state is in Netlify Blobs.
//   dlink/<discord user id>   which character a Discord user signs up as
//   ddraft/<discord user id>  answers not finished yet (saved as a signup once complete)
//   meta/discord-board        the live signup message { channel, message }
import crypto from 'node:crypto';
import { buildSummary } from './summary.mjs';

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
export const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 65536 + 262144; // view, send, embed links, read history, external emojis

const COMMANDS = [
  { name: 'signup', description: 'Sign up or change your answer for the December 9 raid', type: 1, dm_permission: false },
  { name: 'signup-post', description: 'Post the raid signup message in this channel (officers)', type: 1, dm_permission: false, default_member_permissions: String(32) }
];

export function verifyDiscord(publicKey, signature, timestamp, body) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, 'hex'));
  } catch (_) { return false; }
}

const dapi = (path, method = 'GET', body) => fetch(API + path, {
  method, headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
});

export async function registerCommands() {
  const app = process.env.DISCORD_APP_ID;
  if (!app || !process.env.DISCORD_BOT_TOKEN) return { ok: false, error: 'Add DISCORD_APP_ID and DISCORD_BOT_TOKEN in Netlify first.' };
  const r = await dapi(`/applications/${app}/commands`, 'PUT', COMMANDS);
  if (!r.ok) return { ok: false, error: `Discord said ${r.status} when adding the commands. Check DISCORD_APP_ID and DISCORD_BOT_TOKEN.` };
  return { ok: true, invite: `https://discord.com/oauth2/authorize?client_id=${app}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}` };
}

const boardButtons = () => [{ type: 1, components: [
  { type: 2, style: 3, custom_id: 'su:start', label: 'Sign up / change my answer' },
  { type: 2, style: 5, url: 'https://mysticdragons.org/signup', label: 'Sign up on the website' }
] }];

// Keeps the live signup message current. Safe to call after any signup change.
export async function refreshBoard(s) {
  const b = await s.get('meta/discord-board', { type: 'json' });
  if (!b || !process.env.DISCORD_BOT_TOKEN) return;
  const embed = await buildSummary(s);
  const r = await dapi(`/channels/${b.channel}/messages/${b.message}`, 'PATCH', { embeds: [embed], components: boardButtons() });
  if (r.status === 404) await s.delete('meta/discord-board');
}

/* ---------- responses ---------- */
const json = d => Response.json(d);
const reply = (content, components = [], flags = EPHEMERAL) => json({ type: 4, data: { content, components, flags, allowed_mentions: { parse: [] } } });
// Update the ephemeral panel in place when the click came from it; otherwise send a new private message.
const respond = (i, content, components = []) => (i.message && (i.message.flags & EPHEMERAL))
  ? json({ type: 7, data: { content, components, allowed_mentions: { parse: [] } } })
  : reply(content, components);
const nameModal = () => json({ type: 9, data: { custom_id: 'su:who', title: 'Which character are you?', components: [
  { type: 1, components: [{ type: 4, custom_id: 'name', label: 'Character name (first and last)', style: 1, min_length: 2, max_length: 40, required: true, placeholder: 'Drey Stormcall' }] }
] } });
const select = (id, placeholder, options) => ({ type: 1, components: [{ type: 3, custom_id: id, placeholder, min_values: 1, max_values: 1, options: options.slice(0, 25) }] });
const btn = (id, label, style = 2) => ({ type: 2, style, custom_id: id, label });

export async function handleDiscord(req, s, ctx, d) {
  const raw = await req.text();
  const ok = process.env.DISCORD_PUBLIC_KEY && verifyDiscord(process.env.DISCORD_PUBLIC_KEY, req.headers.get('x-signature-ed25519') || '', req.headers.get('x-signature-timestamp') || '', raw);
  if (!ok) return new Response('Bad signature', { status: 401 });
  const i = JSON.parse(raw);
  if (i.type === 1) return json({ type: 1 }); // Discord checking the endpoint

  const user = i.member?.user || i.user || {};
  const uid = String(user.id || '');
  const handle = d.clean(user.username || user.global_name || '', 40);
  const id = i.data?.custom_id || '';
  const later = job => { if (ctx?.waitUntil) ctx.waitUntil(job.catch(() => {})); };

  const linked = async () => {
    const l = await s.get(`dlink/${uid}`, { type: 'json' });
    const c = l && await s.get(`char/${l.key}`, { type: 'json' });
    return c && c.in_guild !== false ? c : null;
  };

  // The private signup panel for one character.
  const panel = async (c, note = '') => {
    const [sign, draft] = await Promise.all([s.get(`signup/dec9/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' })]);
    const a = { ...(sign || {}), ...(draft && draft.key === c.key ? draft : {}) };
    const specs = d.SPECS[c.cls] || [];
    const rows = [
      select('su:spec', 'Your main spec', specs.map(([n, r]) => ({ label: `Main spec: ${n}`, description: r, value: n, default: c.main_spec === n }))),
      select('su:dec9', 'Looking to raid on December 9?', d.DEC9.map(v => ({ label: `Raiding Dec 9: ${v}`, value: v, default: a.dec9 === v })))
    ];
    if (a.dec9 === 'Yes' || a.dec9 === 'Probably') rows.push(select('su:attune', 'What about your attunement for the 40-man?', d.ATTUNE.map(v => ({ label: `40-man attunement: ${v}`, value: v, default: a.attune === v }))));
    if (a.dec9 === 'No') {
      rows.push(select('su:later', 'Raiding with us after that?', d.LATER.map(v => ({ label: `Raiding with us after that: ${v}`, value: v, default: a.later === v }))));
      if (a.later && a.later !== 'Not planning to raid' && c.level < 60) rows.push(select('su:eta', 'Roughly when do you expect to hit 60?', d.ETA.map(v => ({ label: `Hitting 60: ${v}`, value: v, default: a.eta === v }))));
    }
    rows.push({ type: 1, components: [btn('su:specs', 'Other specs I’ll play'), btn('su:notes', a.notes ? 'Edit notes' : 'Add notes'), btn('su:switch', 'Not this character?'), ...(sign ? [btn('su:withdraw', 'Remove my signup', 4)] : [])] });
    const pending = draft && draft.key === c.key;
    const status = !c.main_spec ? 'Pick your main spec and answer below. It saves as soon as everything’s answered.'
      : pending ? `Almost there: ${missing(c, a)}.`
      : sign ? `You’re signed up: **${sign.dec9}**. Change anything below and it saves right away.`
      : 'Answer below. It saves as soon as everything’s answered.';
    return [`**Signing up as ${c.name}** · Level ${c.level} ${c.cls}${c.main_spec ? ` · ${c.main_spec}` : ''}${(c.also_specs || []).length ? ` (also ${c.also_specs.join(', ')})` : ''}\n${note ? note + '\n' : ''}${status}`, rows];
  };
  const missing = (c, a) => !a.dec9 ? 'answer the December 9 question' : (a.dec9 === 'Yes' || a.dec9 === 'Probably') && !a.attune ? 'answer the attunement question to save'
    : a.dec9 === 'No' && !a.later ? 'answer whether you’re raiding with us after that to save' : !c.main_spec ? 'pick your main spec to save' : 'nearly done';
  const complete = (c, a) => !!c.main_spec && !!a.dec9 && ((a.dec9 === 'Yes' || a.dec9 === 'Probably') ? !!a.attune : a.dec9 === 'No' ? !!a.later : true);

  // Merge a change into the answers; save the signup once everything needed is there.
  const change = async (c, patch) => {
    const [sign, draft] = await Promise.all([s.get(`signup/dec9/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' })]);
    const a = { ...(sign || {}), ...(draft && draft.key === c.key ? draft : {}), ...patch };
    if (a.dec9 === 'Yes' || a.dec9 === 'Probably') { a.later = ''; a.eta = ''; } else if (a.dec9 === 'No') a.attune = ''; else { a.attune = ''; a.later = ''; a.eta = ''; }
    if (a.later === 'Not planning to raid' || c.level >= 60) a.eta = '';
    if (complete(c, a)) {
      const doc = { dec9: a.dec9, attune: a.attune || '', later: a.later || '', eta: a.eta || '', discord: handle || sign?.discord || '', notes: d.clean(a.notes, 1000), at: new Date().toISOString(), via: 'discord' };
      await s.setJSON(`signup/dec9/${c.key}`, doc);
      if (draft) await s.delete(`ddraft/${uid}`);
      if (!sign || sign.dec9 !== doc.dec9 || patch.dec9) await d.log(s, 'signup', c.name, 'discord:' + uid, { dec9: doc.dec9, discord: handle, via: 'Discord' });
      later(refreshBoard(s));
      return 'Saved.';
    }
    await s.setJSON(`ddraft/${uid}`, { key: c.key, dec9: a.dec9 || '', attune: a.attune || '', later: a.later || '', eta: a.eta || '', notes: a.notes || '' });
    return '';
  };

  const showFor = async c => { const [content, rows] = await panel(c); return respond(i, content, rows); };

  /* ---------- commands ---------- */
  if (i.type === 2) {
    const name = i.data?.name;
    if (name === 'signup-post') {
      const r = await dapi(`/channels/${i.channel_id}/messages`, 'POST', { embeds: [await buildSummary(s)], components: boardButtons() });
      if (!r.ok) return reply(`I couldn’t post here (Discord said ${r.status}). Make sure I can view and send messages in this channel.`);
      const m = await r.json();
      const old = await s.get('meta/discord-board', { type: 'json' });
      await s.setJSON('meta/discord-board', { channel: i.channel_id, message: m.id, at: new Date().toISOString() });
      return reply(`Posted. It updates on its own whenever someone signs up here or on the website.${old && old.channel === i.channel_id ? '' : ''}`);
    }
    if (name === 'signup') { const c = await linked(); return c ? showFor(c) : nameModal(); }
    return reply('I don’t know that command.');
  }

  /* ---------- buttons, dropdowns, forms ---------- */
  if (id === 'su:start') { const c = await linked(); return c ? showFor(c) : nameModal(); }
  if (id === 'su:switch') return nameModal();

  if (id === 'su:who') {
    const typed = d.clean(i.data.components?.[0]?.components?.[0]?.value, 40);
    const want = d.slug(typed);
    const chars = (await d.allChars(s)).filter(c => c.key && c.in_guild !== false);
    let hits = chars.filter(c => d.slug(c.name) === want);
    if (!hits.length) hits = chars.filter(c => d.slug(c.first || c.name.split(' ')[0]) === want.split(' ')[0]);
    if (!hits.length) hits = chars.filter(c => d.slug(c.name).startsWith(want) || d.slug(c.name).includes(want));
    if (!hits.length) return respond(i, `I couldn’t find **${typed}** in the guild roster. Check the spelling. New guild members show up within about 20 minutes.`, [{ type: 1, components: [btn('su:switch', 'Try again', 1)] }]);
    if (hits.length > 1) return respond(i, `More than one match for **${typed}**. Which one are you?`,
      [select('su:pick', 'Pick your character', hits.slice(0, 25).map(c => ({ label: c.name, description: `Level ${c.level} ${c.cls}`, value: c.key })))]);
    return pickChar(hits[0]);
  }
  async function pickChar(c) {
    await s.setJSON(`dlink/${uid}`, { key: c.key, at: new Date().toISOString(), discord: handle });
    await d.log(s, 'discord-link', c.name, 'discord:' + uid, { discord: handle });
    const [content, rows] = await panel(c, `Got it. Next time you click Sign up I’ll remember you’re ${c.first || c.name}.`);
    return respond(i, content, rows);
  }
  if (id === 'su:pick') {
    const c = await s.get(`char/${d.clean(i.data.values?.[0], 40)}`, { type: 'json' });
    return c ? pickChar(c) : respond(i, 'That character isn’t on the roster anymore.', [{ type: 1, components: [btn('su:switch', 'Try again', 1)] }]);
  }

  const c = await linked();
  if (!c) return respond(i, 'Tell me which character you are first.', [{ type: 1, components: [btn('su:switch', 'Pick my character', 1)] }]);

  // Other specs someone is willing to play, on their own screen (Discord allows only five rows).
  const specsView = (note = '') => {
    const specs = (d.SPECS[c.cls] || []).filter(([n]) => n !== c.main_spec);
    const rows = [];
    if (specs.length) rows.push({ type: 1, components: [{ type: 3, custom_id: 'su:also', placeholder: 'Other specs you’re willing to play', min_values: 0, max_values: specs.length,
      options: specs.map(([n, r]) => ({ label: n, description: r, value: n, default: (c.also_specs || []).includes(n) })) }] });
    rows.push({ type: 1, components: [btn('su:back', 'Done', 1)] });
    return respond(i, `**Other specs for ${c.name}**${c.main_spec ? ` · main spec ${c.main_spec}` : ''}\n${note ? note + '\n' : ''}Pick every other spec you’d play if we need it, or none. It saves right away.`, rows);
  };
  if (id === 'su:specs') return specsView();
  if (id === 'su:back') return showFor(c);
  if (id === 'su:also') {
    const f = d.roleFields({ main_spec: c.main_spec || '', also_specs: (i.data.values || []).map(v => d.clean(v, 30)) }, c.cls, c);
    if (c.main_spec) {
      Object.assign(c, { also_specs: f.also_specs, also_play: f.also_play, updated_at: new Date().toISOString() });
      await s.setJSON(`char/${c.key}`, c);
      await d.log(s, 'update', c.name, 'discord:' + uid, { changed: ['also_specs'], via: 'Discord' });
      return specsView('Saved.');
    }
    return specsView('Pick your main spec first, then come back here.');
  }
  if (id === 'su:spec') {
    const spec = d.clean(i.data.values?.[0], 30);
    const f = d.roleFields({ main_spec: spec, also_specs: c.also_specs || [] }, c.cls, c);
    if (f.main_spec) {
      Object.assign(c, f, { updated_at: new Date().toISOString() });
      await s.setJSON(`char/${c.key}`, c);
      await d.log(s, 'update', c.name, 'discord:' + uid, { changed: ['main_spec'], via: 'Discord' });
    }
    const note = await change(c, {});
    const [content, rows] = await panel(c, note);
    return respond(i, content, rows);
  }
  const FIELD = { 'su:dec9': ['dec9', d.DEC9], 'su:attune': ['attune', d.ATTUNE], 'su:later': ['later', d.LATER], 'su:eta': ['eta', d.ETA] };
  if (FIELD[id]) {
    const [k, list] = FIELD[id], v = i.data.values?.[0];
    if (!list.includes(v)) return showFor(c);
    const note = await change(c, { [k]: v });
    const [content, rows] = await panel(c, note);
    return respond(i, content, rows);
  }
  if (id === 'su:notes') {
    const [sign, draft] = await Promise.all([s.get(`signup/dec9/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' })]);
    const cur = (draft && draft.key === c.key && draft.notes) || sign?.notes || '';
    return json({ type: 9, data: { custom_id: 'su:notesm', title: 'Anything else we should know?', components: [
      { type: 1, components: [{ type: 4, custom_id: 'notes', label: 'Notes for the officers (optional)', style: 2, max_length: 1000, required: false, value: cur || undefined }] }
    ] } });
  }
  if (id === 'su:notesm') {
    const notes = d.clean(i.data.components?.[0]?.components?.[0]?.value, 1000);
    const note = await change(c, { notes });
    const [content, rows] = await panel(c, note || 'Notes saved. They’re kept with your answers.');
    return respond(i, content, rows);
  }
  if (id === 'su:withdraw') {
    await s.delete(`signup/dec9/${c.key}`);
    await s.delete(`ddraft/${uid}`);
    await d.log(s, 'withdraw', c.name, 'discord:' + uid, { via: 'Discord' });
    later(refreshBoard(s));
    const [content, rows] = await panel(c, 'Removed your signup.');
    return respond(i, content, rows);
  }
  return showFor(c);
}
