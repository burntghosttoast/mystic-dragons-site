// DKP backups to a private GitHub repo. Each backup is one commit that rewrites
// balances.csv, ledger.csv and paper-trail.csv, so the repo's history holds every version.
// Needs DKP_BACKUP_REPO ("owner/name", a PRIVATE repo) and DKP_BACKUP_TOKEN
// (fine-grained token with Contents: read and write on that repo only).
// Set both in the Production context only, so the preview's example data never gets backed up.
import * as DKP from './dkp.mjs';

const KIND = { start: 'Starting DKP', 'attend-start': 'Raid start', 'attend-end': 'Raid end', bench: 'Bench', award: 'Loot', adjust: 'Adjustment', decay: 'Decay', fine: 'Fine', 'attend-fix': 'Attendance fix' };
const SRC = { manual: 'Entered by hand', edit: 'Changed later', auto: 'Automatic', example: 'Example data', addon: 'From the addon', bot: 'From the Discord bot' };

const cell = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const csv = rows => '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

async function allChars(s) {
  const { blobs } = await s.list({ prefix: 'char/' });
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })))).filter(c => c && c.key);
}

export async function buildFiles(s) {
  const chars = await allChars(s), byKey = Object.fromEntries(chars.map(c => [c.key, c]));
  const name = k => byKey[k]?.name || k;
  const { cfg, st } = await DKP.draftSheet(s);
  const tx = await DKP.allTx(s);
  const { blobs: nb } = await s.list({ prefix: 'dkp/nights/' });
  const nights = Object.fromEntries((await Promise.all(nb.map(b => s.get(b.key, { type: 'json' })))).filter(Boolean).map(n => [n.id, n]));

  // Walk the ledger the same way the officer page does, so the columns add up.
  const P = {};
  for (const t of tx) {
    const p = P[t.person] = P[t.person] || { bal: 0, approved: 0, earned: 0, adj: 0, spent: 0, decay: 0, items: 0 };
    const was = p.bal; p.bal = t.delta >= 0 ? Math.min(cfg.cap, p.bal + t.delta) : Math.max(0, p.bal + t.delta); const got = p.bal - was;
    if (t.kind === 'award') { p.spent -= got; p.items++; } else if (t.kind === 'decay') p.decay -= got; else if (t.kind === 'adjust' || t.kind === 'fine') p.adj += got; else p.earned += got;
  }
  const balances = csv([['Person', 'Alts', 'Class', 'Approved balance', 'Balance with drafts', 'Earned', 'Adjusted (incl. fines)', 'Spent', 'Decay', 'Items'],
    ...Object.entries(P).sort((a, b) => b[1].bal - a[1].bal).map(([k, p]) => [name(k), chars.filter(c => c.alt_of === k).map(c => c.name).join('; '), byKey[k]?.cls || '', st.approved[k] || 0, p.bal, p.earned, p.adj, p.spent, p.decay, p.items])]);
  const ledger = csv([['When (UTC)', 'Raid night', 'Group', 'Person', 'Character', 'Type', 'Item', 'Note', 'Change', 'Status', 'Entered by', 'Source', 'Entered at (UTC)', 'Line id'],
    ...tx.map(t => { const n = nights[t.night]; return [t.at, n?.date || '', n?.group || '', name(t.person), t.char ? name(t.char) : '', KIND[t.kind] || t.kind, t.item || '', ['start', 'decay', 'bench'].includes(t.kind) ? '' : (t.note || ''), t.delta, t.status === 'draft' ? 'Draft' : 'Approved', t.by || '', SRC[t.source || 'manual'] || t.source, t.entered || '', t.id]; })]);
  const trail = csv([['When (UTC)', 'Who', 'Action', 'What happened', 'Details'],
    ...(await DKP.auditAll(s)).filter(a => a.action !== 'backup-git').map(({ at, by, action, summary, ...rest }) => [at, by || 'Site', action, summary || '', Object.keys(rest).length ? JSON.stringify(rest) : ''])]);
  const readme = `# Mystic Dragons DKP backups\n\nWritten automatically by mysticdragons.org. Don't edit by hand.\n\n- balances.csv: everyone's balance\n- ledger.csv: every DKP line ever entered\n- paper-trail.csv: every officer action on the site\n\nLast approved sheet: ${st.approvedAt || 'none yet'}${st.approvedBy ? ' by ' + st.approvedBy : ''}.\nOlder versions are in this repo's commit history.\n`;
  return { 'balances.csv': balances, 'ledger.csv': ledger, 'paper-trail.csv': trail, 'README.md': readme };
}

// One commit with all files. Skips the commit when nothing changed.
export async function backup(s, why) {
  const repo = process.env.DKP_BACKUP_REPO, token = process.env.DKP_BACKUP_TOKEN;
  if (!repo || !token) return { skipped: 'Backups aren’t set up (DKP_BACKUP_REPO and DKP_BACKUP_TOKEN).' };
  const gh = async (path, opts = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'mystic-dragons-site', ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  };
  const files = await buildFiles(s);
  const repoInfo = await gh('');
  if (!repoInfo.ok) return { error: `GitHub said ${repoInfo.status} for ${repo}. Check the repo name and token.` };
  if (!repoInfo.body.private) return { error: `${repo} is public. DKP backups only go to a private repo.` };
  const branch = repoInfo.body.default_branch || 'main';
  const ref = await gh(`/git/ref/heads/${branch}`);
  let parent = null, baseTree = null;
  if (ref.ok) { parent = ref.body.object.sha; baseTree = (await gh(`/git/commits/${parent}`)).body.tree.sha; }
  const tree = [];
  for (const [path, content] of Object.entries(files)) {
    const b = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }) });
    if (!b.ok) return { error: `GitHub refused the upload (${b.status}).` };
    tree.push({ path, mode: '100644', type: 'blob', sha: b.body.sha });
  }
  const t = await gh('/git/trees', { method: 'POST', body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }) });
  if (!t.ok) return { error: `GitHub refused the upload (${t.status}).` };
  if (t.body.sha === baseTree) return { unchanged: true };
  const c = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message: `DKP backup: ${why}`, tree: t.body.sha, parents: parent ? [parent] : [] }) });
  if (!c.ok) return { error: `GitHub refused the commit (${c.status}).` };
  const u = ref.ok
    ? await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.body.sha }) })
    : await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: c.body.sha }) });
  if (!u.ok) return { error: `GitHub refused the commit (${u.status}).` };
  await DKP.audit(s, 'backup-git', 'Site', `Backed up to GitHub: ${why}`, { commit: c.body.sha });
  return { ok: true, commit: c.body.sha };
}
