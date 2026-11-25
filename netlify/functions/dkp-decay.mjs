// Weekly DKP decay, Sunday night. Adds a draft −decay line for everyone holding DKP;
// it becomes official with the next approved sheet, before Monday's raid points.
import { getStore } from '@netlify/blobs';
import { addDecay } from '../lib/dkp.mjs';

export default async () => {
  const s = getStore({ name: 'guild', consistency: 'strong' });
  const n = await addDecay(s);
  return new Response(`decay added for ${n}`);
};

export const config = { schedule: '55 4 * * 1' }; // Mon 04:55 UTC = Sun 11:55pm ET
