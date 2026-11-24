// Scheduled: posts the signup summary to Discord.
// Until the Dec 9 raid release: every 4 days (counting down to the 9th), around 10am ET.
import { getStore } from '@netlify/blobs';
import { postSummary, todayET } from '../lib/summary.mjs';

export default async () => {
  const s = getStore({ name: 'guild', consistency: 'strong' });
  const [y, m, d] = todayET();
  const days = Math.round((Date.UTC(2026, 11, 9) - Date.UTC(y, m, d)) / 86400000);
  if (days < 0 || days % 4 !== 0) return new Response('not today');
  const stamp = `${y}-${m + 1}-${d}`;
  if ((await s.get('meta/last-summary')) === stamp) return new Response('already posted');
  const r = await postSummary(s);
  if (r.ok) await s.set('meta/last-summary', stamp);
  return new Response(r.ok ? 'posted' : r.error);
};

export const config = { schedule: '0 15 * * *' }; // 15:00 UTC = 10am ET
