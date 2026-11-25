// Optional per-character passwords. Stored salted and hashed, never as typed.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const makeLock = pw => { const salt = randomBytes(16).toString('hex'); return { salt, hash: scryptSync(String(pw), salt, 32).toString('hex'), at: new Date().toISOString() }; };
export const checkLock = (lock, pw) => {
  if (!lock || !pw) return false;
  const a = Buffer.from(lock.hash, 'hex'), b = scryptSync(String(pw), lock.salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
};
// 5 wrong tries per 10 minutes, per device or Discord user.
export async function tooMany(s, who) {
  const t = (await s.get(`locktries/${who}`, { type: 'json' })) || { n: 0, at: 0 };
  return t.n >= 5 && Date.now() - t.at < 10 * 60 * 1000;
}
export async function failed(s, who) {
  const t = (await s.get(`locktries/${who}`, { type: 'json' })) || { n: 0, at: 0 };
  await s.setJSON(`locktries/${who}`, { n: Date.now() - t.at > 10 * 60 * 1000 ? 1 : t.n + 1, at: Date.now() });
}
