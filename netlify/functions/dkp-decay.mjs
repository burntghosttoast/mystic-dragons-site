// Weekly DKP decay, early Tuesday. Adds a draft −decay line for everyone holding DKP;
// it becomes official with Tuesday's approved sheet, after Monday's raid points.
import { getStore } from '@netlify/blobs';
import { addDecay } from '../lib/dkp.mjs';

export default async () => {
  const s = getStore({ name: 'guild', consistency: 'strong' });
  const n = await addDecay(s);
  return new Response(`decay added for ${n}`);
};

export const config = { schedule: '5 5 * * 2' }; // Tue 05:05 UTC = Tue 12:05am ET
