// Safety-net DKP backup to GitHub, Tuesday and Thursday afternoons (after the sheet
// for Monday's and Wednesday's raids should be approved). Approving a sheet also backs up
// right away. Does nothing until DKP_BACKUP_REPO and DKP_BACKUP_TOKEN are set.
import { getStore } from '@netlify/blobs';
import { backup } from '../lib/dkpbackup.mjs';

export default async () => {
  const s = getStore({ name: 'guild', consistency: 'strong' });
  const r = await backup(s, 'scheduled');
  return new Response(JSON.stringify(r));
};

export const config = { schedule: '7 20 * * 2,4' }; // Tue + Thu 20:07 UTC = 3:07pm ET
