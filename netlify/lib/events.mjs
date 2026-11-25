// Events: raid nights and everything else (guild meetings, PvP nights, awards night...).
// Every event has its own signup list, with roles, and its own Discord signup message and Discord event.
// Only raid events tie into DKP (their date is a raid night).
//
//   event/<id>              { id, title, type: 'raid' | 'other', date, start, end, note, extras,
//                             discord: { guild, id } (the Discord event), board: { channel, message } (signup post),
//                             created, by }
//   signup/<id>/<char key>  { answer, attune, later, eta, discord, notes, at, via }
//
// The first raid (Dec 9) is the built-in event "dec9". Its signups were saved before events existed, with the
// answer in a field called dec9; answerOf() reads either. It also asks the extra first-raid questions (extras).
export const ANSWERS = ['Yes', 'Probably', 'Not sure yet', 'No'];
const LABELS = {
  raid: { Yes: 'Yes', Probably: 'Probably', 'Not sure yet': 'Not sure yet', No: 'No' },
  other: { Yes: 'Going', Probably: 'Maybe', 'Not sure yet': 'Not sure yet', No: 'Can’t make it' }
};
export const label = (ev, v) => (LABELS[ev?.type] || LABELS.raid)[v] || v;
export const answerOf = sg => (sg ? sg.answer || sg.dec9 || '' : '');

const DEC9 = { id: 'dec9', title: 'December 9 raid', type: 'raid', date: '2026-12-09', start: '21:00', end: '23:00', note: '', extras: true, builtIn: true };

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

export async function allEvents(s) {
  const { blobs } = await s.list({ prefix: 'event/' });
  const list = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(e => e && e.id);
  if (!list.some(e => e.id === 'dec9') && !(await s.get('meta/dec9-deleted'))) {
    // Older Discord board for Dec 9 (before events existed) carries over.
    const board = await s.get('meta/discord-board', { type: 'json' });
    list.push({ ...DEC9, ...(board ? { board } : {}) });
  }
  return list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

export async function getEvent(s, id) {
  if (!id) return null;
  const e = await s.get(`event/${id}`, { type: 'json' });
  if (e) return e;
  if (id === 'dec9' && !(await s.get('meta/dec9-deleted'))) {
    const board = await s.get('meta/discord-board', { type: 'json' });
    return { ...DEC9, ...(board ? { board } : {}) };
  }
  return null;
}

export async function saveEvent(s, ev) {
  await s.setJSON(`event/${ev.id}`, ev);
  return ev;
}

export async function upcoming(s) {
  const today = todayISO();
  return (await allEvents(s)).filter(e => e.date >= today);
}

// The event to show when none was picked: the next one coming up (or Dec 9 before anything else exists).
export async function defaultEvent(s) {
  const up = await upcoming(s);
  return up[0] || (await getEvent(s, 'dec9'));
}

export async function pickEvent(s, id) {
  return (id && (await getEvent(s, id))) || (await defaultEvent(s));
}

export function newId(title, date) {
  const slug = String(title || 'event').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'event';
  return `${date}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

export const dayLabel = ev => new Date(ev.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const timeLabel = t => {
  const [h, m] = String(t || '21:00').split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
export const whenLabel = ev => `${dayLabel(ev)}, ${timeLabel(ev.start)}–${timeLabel(ev.end)} ET`;

export async function signupsFor(s, ev, chars) {
  return Promise.all(chars.map(c => s.get(`signup/${ev.id}/${c.key}`, { type: 'json' })));
}
