// The Mystic Dragons Discord bot: raid signups from Discord, saved to the same list as the website.
// Discord sends every button click, dropdown pick and command here (Interactions Endpoint URL
// https://mysticdragons.org/api/discord). Nothing runs in between; all state is in Netlify Blobs.
//   dlink/<discord user id>   which character a Discord user signs up as
//   ddraft/<discord user id>  answers not finished yet (saved as a signup once complete)
//   dev/<discord user id>     which event that user is signing up for right now
//   meta/discord-guild        the server's id (looked up from a signup message's channel)
// Each event's signup message and Discord event live on the event itself (see events.mjs).
import crypto from 'node:crypto';
import { buildSummary, emojiCodes, specIcon } from './summary.mjs';
import * as DKP from './dkp.mjs';
import { checkLock, tooMany, failed } from './lock.mjs';
import * as EV from './events.mjs';

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
// view, send, embed links, read history, external emojis, connect (needed to put an event in a voice channel),
// manage events + create events (raid nights as Discord events)
export const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 65536 + 262144 + 1048576 + 8589934592 + 17592186044416;

const COMMANDS = [
  { name: 'signup', description: 'Sign up or change your answer for a guild event', type: 1, dm_permission: false },
  { name: 'event', description: 'Make a guild event: a raid night or anything else (officers)', type: 1, dm_permission: false, default_member_permissions: String(8589934592) },
  { name: 'crafter', description: 'Who in Mystic Dragons (Forever) can make an item', type: 1, dm_permission: false,
    options: [{ type: 3, name: 'item', description: 'Item or recipe name', required: true, autocomplete: true }] },
  { name: 'who', description: 'Look up a guild member', type: 1, dm_permission: false,
    options: [{ type: 3, name: 'character', description: 'Character name', required: true, autocomplete: true }] },
  { name: 'dkp', description: 'Your DKP balance (only you see it)', type: 1, dm_permission: false },
  { name: 'signup-post', description: 'Post an event’s signup message in this channel (officers)', type: 1, dm_permission: false, default_member_permissions: String(32) }
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
  if (r.status === 429) {
    const wait = Math.ceil(Number((await r.json().catch(() => ({}))).retry_after) || 60);
    return { ok: false, error: `Discord is limiting how often the commands can be updated. Try again in ${wait > 90 ? Math.ceil(wait / 60) + ' minutes' : wait + ' seconds'}.` };
  }
  if (!r.ok) return { ok: false, error: `Discord said ${r.status} when adding the commands. Check DISCORD_APP_ID and DISCORD_BOT_TOKEN.` };
  return { ok: true, invite: `https://discord.com/oauth2/authorize?client_id=${app}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}` };
}

const boardButtons = ev => [{ type: 1, components: [
  { type: 2, style: 3, custom_id: 'su:start:' + ev.id, label: 'Sign up / change my answer' },
  { type: 2, style: 5, url: 'https://mysticdragons.org/signup?event=' + encodeURIComponent(ev.id), label: 'Sign up on the website' },
  ...(ev.discord?.id ? [{ type: 2, style: 5, url: `https://discord.com/events/${ev.discord.guild}/${ev.discord.id}`, label: 'Discord event' }] : [])
] }];

// Post an event's signup message in a channel; it keeps itself up to date from then on.
export async function postBoard(s, ev, channel) {
  const r = await dapi(`/channels/${channel}/messages`, 'POST', { embeds: [await buildSummary(s, ev)], components: boardButtons(ev) });
  if (!r.ok) return { error: `I couldn’t post there (Discord said ${r.status}). Make sure I can view and send messages in that channel.` };
  const m = await r.json();
  ev.board = { channel, message: m.id, at: new Date().toISOString() };
  await EV.saveEvent(s, ev);
  if (!(await s.get('meta/discord-guild', { type: 'json' }))) await guildId(s, channel);
  return { ok: true };
}

/* ---------- raid nights as Discord events ---------- */
// Which server the bot is in: read from the channel the signup board lives in.
async function guildId(s, channel) {
  const g = await s.get('meta/discord-guild', { type: 'json' });
  if (g?.id) return g.id;
  const b = channel ? { channel } : ((await EV.allEvents(s)).find(e => e.board) || {}).board || await s.get('meta/discord-board', { type: 'json' });
  if (!b) return null;
  const r = await dapi(`/channels/${b.channel}`);
  if (!r.ok) return null;
  const id = (await r.json()).guild_id;
  if (id) await s.setJSON('meta/discord-guild', { id });
  return id;
}

// "2026-12-09" + "21:00" US Eastern → ISO time in UTC (handles daylight saving).
function easternIso(date, time) {
  for (const off of ['-05:00', '-04:00']) {
    const d = new Date(`${date}T${time}:00${off}`);
    const hh = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
    if (hh.replace(/^24/, '00') === time) return d.toISOString();
  }
  return new Date(`${date}T${time}:00-05:00`).toISOString();
}

async function signupLine(s, ev) {
  const d = (await buildSummary(s, ev)).description || '';
  const m = d.match(/\*\*(\d+)\*\* [^·]+ · \*\*(\d+)\*\* /);
  return m ? `${m[1]} signed up, ${m[2]} ${EV.label(ev, 'Probably').toLowerCase()}.` : '';
}
const eventText = (ev, line) => [ev.note, ev.type === 'raid' ? '' : 'Not a raid night (no DKP).',
  `Sign up or change your answer: https://mysticdragons.org/signup?event=${encodeURIComponent(ev.id)} (or /signup here).`, line].filter(Boolean).join('\n\n').slice(0, 1000);

export async function voiceChannels(s) {
  const id = await guildId(s);
  if (!id) return { error: 'I don’t know your Discord server yet. Use any bot command there once (like /dkp), then try again.' };
  const r = await dapi(`/guilds/${id}/channels`);
  if (!r.ok) return { error: `Discord said ${r.status} when listing channels.` };
  return { channels: (await r.json()).filter(c => c.type === 2 || c.type === 13).sort((a, b) => a.position - b.position).map(c => ({ id: c.id, name: c.name })) };
}

export async function textChannels(s) {
  const id = await guildId(s);
  if (!id) return { error: 'I don’t know your Discord server yet. Use any bot command there once (like /dkp), then try again.' };
  const r = await dapi(`/guilds/${id}/channels`);
  if (!r.ok) return { error: `Discord said ${r.status} when listing channels.` };
  return { channels: (await r.json()).filter(c => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map(c => ({ id: c.id, name: c.name })) };
}

// Make (or update) the Discord event for one of our events. channel: a voice channel id, or '' for the signup page.
export async function syncDiscordEvent(s, ev, channel) {
  const id = await guildId(s);
  if (!id) return { error: 'I don’t know your Discord server yet. Use any bot command there once (like /dkp), then try again.' };
  if (channel !== undefined) ev.channel = channel || '';
  const body = {
    name: ev.title.slice(0, 100), privacy_level: 2,
    scheduled_start_time: easternIso(ev.date, ev.start), scheduled_end_time: easternIso(ev.date, ev.end),
    description: eventText(ev, await signupLine(s, ev)),
    ...(ev.channel ? { entity_type: 2, channel_id: ev.channel, entity_metadata: null } : { entity_type: 3, channel_id: null, entity_metadata: { location: 'mysticdragons.org/signup' } })
  };
  let r = ev.discord?.id ? await dapi(`/guilds/${ev.discord.guild}/scheduled-events/${ev.discord.id}`, 'PATCH', body) : null;
  if (!r || r.status === 404) r = await dapi(`/guilds/${id}/scheduled-events`, 'POST', body);
  if (r.status === 403) return { error: 'The bot isn’t allowed to make events. In Discord: Server Settings → Roles → the bot’s role → turn on Create Events and Manage Events (and Connect, for a voice channel).' };
  if (!r.ok) { const e = await r.json().catch(() => ({})); return { error: `Discord said ${r.status}${e.message ? ': ' + e.message : ''}.` }; }
  const de = await r.json();
  ev.discord = { guild: de.guild_id || id, id: de.id };
  await EV.saveEvent(s, ev);
  if (ev.board) await dapi(`/channels/${ev.board.channel}/messages/${ev.board.message}`, 'PATCH', { components: boardButtons(ev) }).catch(() => {});
  return { ok: true, url: `https://discord.com/events/${ev.discord.guild}/${ev.discord.id}` };
}
export async function deleteDiscordEvent(s, ev) {
  if (ev.discord?.id) await dapi(`/guilds/${ev.discord.guild}/scheduled-events/${ev.discord.id}`, 'DELETE').catch(() => {});
  if (ev.board) await dapi(`/channels/${ev.board.channel}/messages/${ev.board.message}`, 'DELETE').catch(() => {});
}

// Keeps an event's signup message and Discord event current (or every upcoming event's, with no id).
// Safe to call after any signup change.
export async function refreshBoard(s, evId) {
  if (!process.env.DISCORD_BOT_TOKEN) return;
  const list = evId ? [await EV.getEvent(s, evId)].filter(Boolean) : await EV.upcoming(s);
  for (const ev of list) {
    if (ev.discord?.id) await dapi(`/guilds/${ev.discord.guild}/scheduled-events/${ev.discord.id}`, 'PATCH', { description: eventText(ev, await signupLine(s, ev)) }).catch(() => {});
    if (!ev.board) continue;
    const r = await dapi(`/channels/${ev.board.channel}/messages/${ev.board.message}`, 'PATCH', { embeds: [await buildSummary(s, ev)], components: boardButtons(ev) });
    if (r.status === 404) { ev.board = null; await EV.saveEvent(s, ev); if (ev.id === 'dec9') await s.delete('meta/discord-board'); }
  }
}

/* ---------- responses ---------- */
const json = d => Response.json(d);
const reply = (content, components = [], flags = EPHEMERAL) => json({ type: 4, data: { content, components, flags, allowed_mentions: { parse: [] } } });
// Update the ephemeral panel in place when the click came from it; otherwise send a new private message.
const respond = (i, content, components = []) => (i.message && (i.message.flags & EPHEMERAL))
  ? json({ type: 7, data: { content, components, allowed_mentions: { parse: [] } } })
  : reply(content, components);
const nameModal = () => json({ type: 9, data: { custom_id: 'su:who', title: 'Which character are you?', components: [
  { type: 1, components: [{ type: 4, custom_id: 'name', label: 'Character name (first and last)', style: 1, min_length: 2, max_length: 40, required: true, placeholder: 'Drey Stormcall' }] },
  { type: 1, components: [{ type: 4, custom_id: 'pw', label: 'Character password (only if you set one)', style: 1, max_length: 100, required: false }] }
] } });
const pwModal = (key, name) => json({ type: 9, data: { custom_id: 'su:pw:' + key, title: `${name} is locked`.slice(0, 45), components: [
  { type: 1, components: [{ type: 4, custom_id: 'pw', label: 'Character password', style: 1, max_length: 100, required: true }] }
] } });
// /event: a short form. Times are US Eastern.
const eventModal = () => json({ type: 9, data: { custom_id: 'ev:new', title: 'New guild event', components: [
  { type: 1, components: [{ type: 4, custom_id: 'title', label: 'Title', style: 1, max_length: 100, required: true, placeholder: 'MC raid night / Guild meeting / Awards night' }] },
  { type: 1, components: [{ type: 4, custom_id: 'date', label: 'Date', style: 1, max_length: 20, required: true, placeholder: '12/16' }] },
  { type: 1, components: [{ type: 4, custom_id: 'start', label: 'Start and end (Eastern)', style: 1, max_length: 30, required: false, placeholder: '9pm-11pm' }] },
  { type: 1, components: [{ type: 4, custom_id: 'type', label: 'Type: raid (counts for DKP) or other', style: 1, max_length: 10, required: true, value: 'raid' }] },
  { type: 1, components: [{ type: 4, custom_id: 'note', label: 'Note (optional)', style: 2, max_length: 600, required: false }] }
] } });
function parseDate(v) {
  v = String(v || '').trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (!m) return '';
  const today = EV.todayISO(), y0 = Number(today.slice(0, 4));
  let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : y0;
  let iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (!m[3] && iso < today) iso = `${y + 1}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // "1/5" in December means next year
  return iso;
}
function parseTime(v) {
  const m = String(v || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
  if (!m) return '';
  let h = Number(m[1]); const min = m[2] || '00';
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  if (!m[3] && h >= 1 && h <= 11) h += 12; // "9" means 9 PM for guild events
  return h > 23 ? '' : `${String(h).padStart(2, '0')}:${min}`;
}
const addHours = (t, n) => { const [h, m] = t.split(':').map(Number); return `${String(Math.min(23, h + n)).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };

const select = (id, placeholder, options) => ({ type: 1, components: [{ type: 3, custom_id: id, placeholder, min_values: 1, max_values: 1, options: options.slice(0, 25) }] });
const btn = (id, label, style = 2) => ({ type: 2, style, custom_id: id, label });

export async function handleDiscord(req, s, ctx, d) {
  const raw = await req.text();
  const ok = process.env.DISCORD_PUBLIC_KEY && verifyDiscord(process.env.DISCORD_PUBLIC_KEY, req.headers.get('x-signature-ed25519') || '', req.headers.get('x-signature-timestamp') || '', raw);
  if (!ok) return new Response('Bad signature', { status: 401 });
  const i = JSON.parse(raw);
  if (i.type === 1) return json({ type: 1 }); // Discord checking the endpoint

  // Remember which server we're in (needed to make Discord events from the site).
  if (i.guild_id && !(await s.get('meta/discord-guild', { type: 'json' }))) await s.setJSON('meta/discord-guild', { id: i.guild_id });
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

  // Which event this person is signing up for (picked on a signup message, or from /signup).
  const curEv = async () => EV.pickEvent(s, (await s.get(`dev/${uid}`, { type: 'json' }))?.ev);
  const setEv = id => s.setJSON(`dev/${uid}`, { ev: id });
  const evPicker = (list, customId = 'su:ev', text = 'Which event?') => respond(i, text,
    [select(customId, 'Pick an event', list.slice(0, 25).map(e => ({ label: e.title.slice(0, 100), description: `${EV.whenLabel(e)}${e.type === 'raid' ? '' : ' · not a raid'}`.slice(0, 100), value: e.id })))]);
  const readA = (sign, draft, c, ev) => {
    const a = { ...(sign || {}), ...(draft && draft.key === c.key && draft.ev === ev.id ? draft : {}) };
    a.answer = a.answer || a.dec9 || '';
    return a;
  };

  // The private signup panel for one character.
  const panel = async (c, note = '') => {
    const ev = await curEv();
    const [sign, draft, up] = await Promise.all([s.get(`signup/${ev.id}/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' }), EV.upcoming(s)]);
    const a = readA(sign, draft, c, ev);
    const specs = d.SPECS[c.cls] || [];
    const q = ev.type === 'raid' ? `Raiding ${EV.dayLabel(ev)}` : `${ev.title.slice(0, 40)}`;
    const rows = [
      select('su:spec', 'Your main spec', specs.map(([n, r]) => ({ label: `Main spec: ${n}`, description: r, value: n, default: c.main_spec === n }))),
      select('su:ans', `${q}?`, EV.ANSWERS.map(v => ({ label: `${q}: ${EV.label(ev, v)}`.slice(0, 100), value: v, default: a.answer === v })))
    ];
    if (ev.extras && (a.answer === 'Yes' || a.answer === 'Probably')) rows.push(select('su:attune', 'What about your attunement for the 40-man?', d.ATTUNE.map(v => ({ label: `40-man attunement: ${v}`, value: v, default: a.attune === v }))));
    if (ev.extras && a.answer === 'No') {
      rows.push(select('su:later', 'Raiding with us after that?', d.LATER.map(v => ({ label: `Raiding with us after that: ${v}`, value: v, default: a.later === v }))));
      if (a.later && a.later !== 'Not planning to raid' && c.level < 60) rows.push(select('su:eta', 'Roughly when do you expect to hit 60?', d.ETA.map(v => ({ label: `Hitting 60: ${v}`, value: v, default: a.eta === v }))));
    }
    rows.push({ type: 1, components: [btn('su:specs', 'Other specs I’ll play'), btn('su:notes', a.notes ? 'Edit notes' : 'Add notes'), btn('su:switch', 'Not this character?'),
      ...(up.length > 1 ? [btn('su:evs', 'Other events')] : []), ...(sign ? [btn('su:withdraw', 'Remove my signup', 4)] : [])].slice(0, 5) });
    const pending = draft && draft.key === c.key && draft.ev === ev.id;
    const status = !c.main_spec ? 'Pick your main spec and answer below. It saves as soon as everything’s answered.'
      : pending ? `Almost there: ${missing(c, a, ev)}.`
      : sign ? `You’re signed up: **${EV.label(ev, EV.answerOf(sign))}**. Change anything below and it saves right away.`
      : 'Answer below. It saves as soon as everything’s answered.';
    return [`**${ev.title}** · ${EV.whenLabel(ev)}${ev.type === 'raid' ? '' : ' · not a raid night'}\n**Signing up as ${c.name}** · Level ${c.level} ${c.cls}${c.main_spec ? ` · ${c.main_spec}` : ''}${(c.also_specs || []).length ? ` (also ${c.also_specs.join(', ')})` : ''}\n${note ? note + '\n' : ''}${status}`, rows];
  };
  const missing = (c, a, ev) => !a.answer ? 'answer whether you’re coming' : ev.extras && (a.answer === 'Yes' || a.answer === 'Probably') && !a.attune ? 'answer the attunement question to save'
    : ev.extras && a.answer === 'No' && !a.later ? 'answer whether you’re raiding with us after that to save' : !c.main_spec ? 'pick your main spec to save' : 'nearly done';
  const complete = (c, a, ev) => !!c.main_spec && !!a.answer && (!ev.extras || ((a.answer === 'Yes' || a.answer === 'Probably') ? !!a.attune : a.answer === 'No' ? !!a.later : true));

  // Merge a change into the answers; save the signup once everything needed is there.
  const change = async (c, patch) => {
    const ev = await curEv();
    const [sign, draft] = await Promise.all([s.get(`signup/${ev.id}/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' })]);
    const a = { ...readA(sign, draft, c, ev), ...patch };
    if (!ev.extras) { a.attune = ''; a.later = ''; a.eta = ''; }
    else if (a.answer === 'Yes' || a.answer === 'Probably') { a.later = ''; a.eta = ''; } else if (a.answer === 'No') a.attune = ''; else { a.attune = ''; a.later = ''; a.eta = ''; }
    if (a.later === 'Not planning to raid' || c.level >= 60) a.eta = '';
    if (complete(c, a, ev)) {
      const doc = { answer: a.answer, attune: a.attune || '', later: a.later || '', eta: a.eta || '', discord: handle || sign?.discord || '', notes: d.clean(a.notes, 1000), at: new Date().toISOString(), via: 'discord' };
      if (ev.id === 'dec9') doc.dec9 = a.answer; // older code paths read this name
      await s.setJSON(`signup/${ev.id}/${c.key}`, doc);
      if (draft) await s.delete(`ddraft/${uid}`);
      if (!sign || EV.answerOf(sign) !== doc.answer || patch.answer) await d.log(s, 'signup', c.name, 'discord:' + uid, { event: ev.id, answer: doc.answer, discord: handle, via: 'Discord' });
      later(refreshBoard(s, ev.id));
      return 'Saved.';
    }
    await s.setJSON(`ddraft/${uid}`, { key: c.key, ev: ev.id, answer: a.answer || '', attune: a.attune || '', later: a.later || '', eta: a.eta || '', notes: a.notes || '' });
    return '';
  };

  const showFor = async c => { const [content, rows] = await panel(c); return respond(i, content, rows); };

  /* ---------- autocomplete for /craft and /who ---------- */
  const opt = n => (i.data?.options || []).find(o => o.name === n);
  if (i.type === 4) {
    const o = (i.data?.options || []).find(x => x.focused) || {};
    const q = d.slug(o.value || '');
    let choices = [];
    if (i.data.name === 'crafter') {
      const [known, idx] = await Promise.all([s.get('meta/craft-known', { type: 'json' }), s.get('meta/recipe-index', { type: 'json' })]);
      const seen = new Set(), list = [];
      for (const r of Object.values(known?.r || {})) { seen.add(r.n); list.push({ n: r.n, v: r.id ? 'i:' + r.id : 'n:' + r.n, k: 1 }); }
      for (const [id, e] of Object.entries(idx?.e || {})) if (!seen.has(e.n) && !e.b) { seen.add(e.n); list.push({ n: e.n, v: 'i:' + id, k: 0 }); }
      choices = list.filter(x => !q || d.slug(x.n).includes(q))
        .sort((a, b) => (d.slug(b.n).startsWith(q) - d.slug(a.n).startsWith(q)) || (b.k - a.k) || a.n.localeCompare(b.n))
        .slice(0, 25).map(x => ({ name: (x.k ? x.n : `${x.n} (nobody yet)`).slice(0, 100), value: x.v.slice(0, 100) }));
    } else if (i.data.name === 'who') {
      const known = await s.get('meta/craft-known', { type: 'json' });
      const chars = Object.entries(known?.c || {}).map(([key, c]) => ({ key, ...c }));
      const list = chars.length ? chars : (await d.allChars(s)).filter(c => c.key && c.in_guild !== false);
      choices = list.filter(c => !q || d.slug(c.name).includes(q))
        .sort((a, b) => (d.slug(b.name).startsWith(q) - d.slug(a.name).startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 25).map(c => ({ name: `${c.name} · ${c.level} ${c.cls}`.slice(0, 100), value: c.key }));
    }
    return json({ type: 8, data: { choices } });
  }

  /* ---------- commands ---------- */
  if (i.type === 2) {
    const name = i.data?.name;
    if (name === 'crafter') return craftReply(String(opt('item')?.value || ''));
    if (name === 'who') return whoReply(String(opt('character')?.value || ''));
    if (name === 'dkp') {
      const c = await linked();
      if (!c) return reply('I don’t know which character you are yet. Click Sign up on the signup message or use /signup once, then try again.');
      const person = DKP.personOf(c), st = await DKP.state(s);
      const main = person === c.key ? c : await s.get(`char/${person}`, { type: 'json' });
      const when = st.approvedAt ? new Date(st.approvedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '';
      return reply(`**${main?.name || c.name}: ${st.approved[person] || 0} DKP**${when ? ` (as of the sheet approved ${when})` : ''}\nHistory: https://mysticdragons.org/dkp`);
    }
    if (name === 'signup-post') {
      const up = await EV.upcoming(s);
      if (!up.length) return reply('There are no upcoming events. Make one with /event or on the site’s officer page.');
      if (up.length > 1) return reply('Which event’s signup message should I post here?', [select('post:ev', 'Pick an event', up.slice(0, 25).map(e => ({ label: e.title.slice(0, 100), description: EV.whenLabel(e).slice(0, 100), value: e.id })))]);
      const r = await postBoard(s, up[0], i.channel_id);
      return reply(r.error || `Posted the signup message for **${up[0].title}**. It updates on its own whenever someone signs up here or on the website.`);
    }
    if (name === 'event') return eventModal();
    if (name === 'signup') {
      const up = await EV.upcoming(s);
      if (!up.length) return reply('There are no upcoming events to sign up for right now.');
      if (up.length > 1) return evPicker(up, 'su:ev', 'Which event are you signing up for?');
      await setEv(up[0].id);
      const c = await linked(); return c ? showFor(c) : nameModal();
    }
    return reply('I don’t know that command.');
  }

  /* ---------- /craft ---------- */
  async function craftReply(v) {
    const QCOL = { POOR: 0x9d9d9d, COMMON: 0xffffff, UNCOMMON: 0x1eff00, RARE: 0x0070dd, EPIC: 0xa335ee, LEGENDARY: 0xff8000 };
    const STAND = ['Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];
    const [known, idx, codes] = await Promise.all([s.get('meta/craft-known', { type: 'json' }), s.get('meta/recipe-index', { type: 'json' }), emojiCodes(s)]);
    const K = known?.r || {}, E = idx?.e || {};
    // A picked suggestion carries an id; typed text is matched by name.
    let id = /^i:\d+$/.test(v) ? Number(v.slice(2)) : null, rname = v.startsWith('n:') ? v.slice(2) : v;
    if (!id) {
      const q = d.slug(rname);
      const names = [...Object.values(K).map(r => [r.n, r.id]), ...Object.entries(E).map(([k, e]) => [e.n, Number(k)])];
      const hit = names.find(([n]) => d.slug(n) === q) || names.find(([n]) => d.slug(n).startsWith(q)) || names.find(([n]) => d.slug(n).includes(q));
      if (!hit) return reply(`I couldn’t find a recipe called **${d.clean(rname, 60)}**. Try picking one from the suggestions as you type.`);
      [rname, id] = hit;
    }
    const e = id ? E[id] : null;
    const k = (id && K['i' + id]) || Object.values(K).find(r => r.n === (e?.n || rname));
    const title = e?.n || k?.n || rname;
    const who = (k?.k || []).map(([key, skill]) => ({ c: known.c[key], skill })).filter(x => x.c).sort((a, b) => (b.skill || 0) - (a.skill || 0));
    // The full in-game tooltip from the stored recipe details.
    const det = id ? await s.get(`recipe/${id}`, { type: 'json' }) : null;
    const it = det?.item;
    const wowhead = it?.id ? `https://www.wowhead.com/classic/item=${it.id}`
      : e?.src ? `https://www.wowhead.com/classic/item=${e.src.id}` : `https://www.wowhead.com/classic/search?q=${encodeURIComponent(title)}`;
    const site = `https://mysticdragons.org/crafters?q=${encodeURIComponent(title)}`;
    const tip = [];
    if (it) {
      tip.push(it.binding, [it.slot, it.type && it.type !== it.slot ? it.type : ''].filter(Boolean).join(' · '), it.armor,
        [it.damage, it.speed].filter(Boolean).join(' · '), it.dps, ...it.stats, ...it.spells, it.durability, it.level, it.skill,
        it.description ? `*“${it.description}”*` : '');
    } else if (det?.description) tip.push(det.description);
    tip.splice(0, tip.length, ...tip.filter(Boolean));
    if (det?.reagents?.length) tip.push('', `**Reagents:** ${det.reagents.map(r => r.name + (r.qty > 1 ? ` (${r.qty})` : '')).join(', ')}`);
    if (det?.quantity > 1) tip.push(`Makes ${det.quantity}`);
    const embed = { title, url: wowhead, color: QCOL[e?.q] ?? 0xA3BC6E, fields: [] };
    const desc = tip.filter(x => x != null && x !== false).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (desc) embed.description = desc.slice(0, 1500);
    else if (e?.l) embed.description = e.l.slice(0, 400);
    if (e?.ic) embed.thumbnail = { url: e.ic };
    if (who.length) {
      const lines = who.map(x => `${specIcon(codes, x.c)} ${x.c.name}${x.skill ? ` · ${x.skill}` : ''}`.trim());
      let val = ''; for (const l of lines) { if ((val + l).length > 1000) { val += `\n…and ${lines.length - val.split('\n').length} more`; break; } val += (val ? '\n' : '') + l; }
      embed.fields.push({ name: `Can make it · ${who.length}`, value: val });
    } else {
      embed.fields.push({ name: 'Can make it', value: 'Nobody in the guild knows this one yet.' });
      if (e?.src) embed.fields.push({ name: 'How to get it', value: `Learned from [${e.src.name}](https://www.wowhead.com/classic/item=${e.src.id})${e.rep ? `, which needs **${e.rep.faction} – ${STAND[e.rep.level] || ''}**` : ''}.` });
      else if (e) embed.fields.push({ name: 'How to get it', value: 'Most likely taught by a trainer.' });
    }
    embed.fields.push({ name: 'Links', value: `[Wowhead](${wowhead}) · [Guild crafters page](${site})` });
    if (e?.p || k?.p) embed.footer = { text: e?.p || k?.p };
    return json({ type: 4, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  /* ---------- /who ---------- */
  async function whoReply(v) {
    let c = await s.get(`char/${d.clean(v, 40)}`, { type: 'json' });
    if (!c) {
      const q = d.slug(v), all = (await d.allChars(s)).filter(x => x.key && x.in_guild !== false);
      c = all.find(x => d.slug(x.name) === q) || all.find(x => d.slug(x.name).startsWith(q)) || all.find(x => d.slug(x.name).includes(q));
    }
    if (!c) return reply(`I couldn’t find **${d.clean(v, 40)}** in the guild roster.`);
    const nextEv = await EV.defaultEvent(s);
    const [info, prof, sign, codes] = await Promise.all([s.get(`info/${c.key}`, { type: 'json' }), s.get(`prof/${c.key}`, { type: 'json' }), nextEv ? s.get(`signup/${nextEv.id}/${c.key}`, { type: 'json' }) : null, emojiCodes(s)]);
    const RANK = r => r === 0 ? 'Guild Master' : r === 1 ? 'Officer' : 'Member';
    const spec = c.main_spec ? `${specIcon(codes, c)} ${c.main_spec} (${c.main_role})${(c.also_specs || []).length ? `\nAlso plays ${c.also_specs.join(', ')}` : ''}` : (c.main_role || 'Not picked yet');
    const profs = (prof || []).filter(p => p.name).map(p => `${p.name}${p.skill ? ` ${p.skill}${p.max ? '/' + p.max : ''}` : ''}`).join('\n');
    const embed = {
      title: c.name, url: `https://mysticdragons.org/character?c=${encodeURIComponent(c.key)}`, color: 0xA3BC6E,
      description: `Level ${c.level}${c.race ? ' ' + c.race : ''} ${c.cls} · ${RANK(c.rank)}${info?.profile?.item_level ? ` · item level ${info.profile.item_level}` : ''}`,
      fields: [
        { name: 'Spec', value: spec.slice(0, 1000), inline: true },
        { name: 'Professions', value: profs || 'None found', inline: true },
        ...(nextEv ? [{ name: nextEv.title.slice(0, 256), value: sign ? `${EV.label(nextEv, EV.answerOf(sign))}${sign.attune ? `\nAttunement: ${sign.attune}` : ''}` : 'Not signed up', inline: true }] : [])
      ],
      footer: { text: 'More on their character page at mysticdragons.org' }
    };
    const avatar = (info?.media || []).find(m => m.key === 'avatar')?.url;
    if (avatar) embed.thumbnail = { url: avatar };
    return json({ type: 4, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  /* ---------- buttons, dropdowns, forms ---------- */
  const canManage = () => { try { const p = BigInt(i.member?.permissions || '0'); return (p & 8n) || (p & 32n) || (p & 8589934592n); } catch (_) { return false; } };
  if (id === 'su:start' || id.startsWith('su:start:')) {
    await setEv(id.slice(9) || 'dec9'); // older Dec 9 messages have the plain su:start button
    const c = await linked(); return c ? showFor(c) : nameModal();
  }
  if (id === 'su:ev') { await setEv(d.clean(i.data.values?.[0], 80)); const c = await linked(); return c ? showFor(c) : nameModal(); }
  if (id === 'su:evs') return evPicker(await EV.upcoming(s), 'su:ev', 'Which event?');
  if (id === 'post:ev' || id.startsWith('post:')) {
    if (!canManage()) return reply('Only officers can post signup messages.');
    const ev = await EV.getEvent(s, id === 'post:ev' ? d.clean(i.data.values?.[0], 80) : id.slice(5));
    if (!ev) return reply('That event isn’t there anymore.');
    const r = await postBoard(s, ev, i.channel_id);
    return respond(i, r.error || `Posted the signup message for **${ev.title}** here.`);
  }
  if (id === 'ev:new') {
    if (!canManage()) return reply('Only officers can make events.');
    const val = k => d.clean((i.data.components || []).flatMap(r => r.components || []).find(x => x.custom_id === k)?.value, 200);
    const [t1, t2] = val('start').split(/\s*(?:-|–|to)\s*/i);
    const date = parseDate(val('date')), start = parseTime(t1) || '21:00', end = parseTime(t2) || addHours(start, 2);
    const type = /raid/i.test(val('type')) ? 'raid' : 'other';
    if (!val('title')) return reply('Give it a title.');
    if (!date) return reply(`I couldn’t read the date “${val('date')}”. Try 12/16 or 2026-12-16.`);
    const ev = { id: EV.newId(val('title'), date), title: val('title').slice(0, 100), type, date, start, end, note: val('note').slice(0, 600), created: new Date().toISOString(), by: handle + ' (Discord)' };
    await EV.saveEvent(s, ev);
    await d.log(s, 'event', ev.title, 'discord:' + uid, { date, type, via: 'Discord' });
    const de = await syncDiscordEvent(s, ev, '');
    return reply(`Made **${ev.title}** · ${EV.whenLabel(ev)}${type === 'raid' ? ' · raid night (counts for DKP)' : ' · not a raid night (no DKP)'}.\n${de.ok ? `Discord event: ${de.url}` : `Couldn’t make the Discord event: ${de.error}`}\nPost its signup message here?`,
      [{ type: 1, components: [btn('post:' + ev.id, 'Post the signup message here', 3)] }]);
  }
  if (id === 'su:switch') return nameModal();

  if (id === 'su:who') {
    const typed = d.clean(i.data.components?.[0]?.components?.[0]?.value, 40);
    const typedPw = String(i.data.components?.[1]?.components?.[0]?.value || '');
    const want = d.slug(typed);
    const chars = (await d.allChars(s)).filter(c => c.key && c.in_guild !== false);
    let hits = chars.filter(c => d.slug(c.name) === want);
    if (!hits.length) hits = chars.filter(c => d.slug(c.first || c.name.split(' ')[0]) === want.split(' ')[0]);
    if (!hits.length) hits = chars.filter(c => d.slug(c.name).startsWith(want) || d.slug(c.name).includes(want));
    if (!hits.length) return respond(i, `I couldn’t find **${typed}** in the guild roster. Check the spelling. New guild members show up within about 20 minutes.`, [{ type: 1, components: [btn('su:switch', 'Try again', 1)] }]);
    if (hits.length > 1) return respond(i, `More than one match for **${typed}**. Which one are you?`,
      [select('su:pick', 'Pick your character', hits.slice(0, 25).map(c => ({ label: c.name, description: `Level ${c.level} ${c.cls}`, value: c.key })))]);
    return pickChar(hits[0], typedPw);
  }
  // A locked character needs its password, unless this Discord user is already linked to it.
  async function pickChar(c, pw) {
    const cur = await s.get(`dlink/${uid}`, { type: 'json' });
    const owner = c.alt_of ? await s.get(`char/${c.alt_of}`, { type: 'json' }) : null;
    const lock = owner?.lock || c.lock;
    if (lock && cur?.key !== c.key) {
      if (!pw) return i.type === 3 ? pwModal(c.key, c.name) : respond(i, `**${c.name}** is locked. Use Try again and enter its password in the second box.`, [{ type: 1, components: [btn('su:switch', 'Try again', 1)] }]);
      if (await tooMany(s, 'discord:' + uid)) return respond(i, 'Too many wrong tries. Wait a few minutes.', []);
      if (!checkLock(lock, pw)) { await failed(s, 'discord:' + uid); return respond(i, `That’s not the password for **${c.name}**.`, [{ type: 1, components: [btn('su:switch', 'Try again', 1)] }]); }
    }
    await s.setJSON(`dlink/${uid}`, { key: c.key, at: new Date().toISOString(), discord: handle });
    await d.log(s, 'discord-link', c.name, 'discord:' + uid, { discord: handle });
    const [content, rows] = await panel(c, `Got it. Next time you click Sign up I’ll remember you’re ${c.first || c.name}.`);
    return respond(i, content, rows);
  }
  if (id.startsWith('su:pw:')) {
    const c = await s.get(`char/${d.clean(id.slice(6), 40)}`, { type: 'json' });
    return c ? pickChar(c, String(i.data.components?.[0]?.components?.[0]?.value || '')) : respond(i, 'That character isn’t on the roster anymore.', []);
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
  const FIELD = { 'su:ans': ['answer', EV.ANSWERS], 'su:dec9': ['answer', EV.ANSWERS], 'su:attune': ['attune', d.ATTUNE], 'su:later': ['later', d.LATER], 'su:eta': ['eta', d.ETA] };
  if (FIELD[id]) {
    const [k, list] = FIELD[id], v = i.data.values?.[0];
    if (!list.includes(v)) return showFor(c);
    const note = await change(c, { [k]: v });
    const [content, rows] = await panel(c, note);
    return respond(i, content, rows);
  }
  if (id === 'su:notes') {
    const ev = await curEv();
    const [sign, draft] = await Promise.all([s.get(`signup/${ev.id}/${c.key}`, { type: 'json' }), s.get(`ddraft/${uid}`, { type: 'json' })]);
    const cur = (draft && draft.key === c.key && draft.ev === ev.id && draft.notes) || sign?.notes || '';
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
    const ev = await curEv();
    await s.delete(`signup/${ev.id}/${c.key}`);
    await s.delete(`ddraft/${uid}`);
    await d.log(s, 'withdraw', c.name, 'discord:' + uid, { event: ev.id, via: 'Discord' });
    later(refreshBoard(s, ev.id));
    const [content, rows] = await panel(c, 'Removed your signup.');
    return respond(i, content, rows);
  }
  return showFor(c);
}
