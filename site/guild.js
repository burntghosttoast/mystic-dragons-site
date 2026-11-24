// Shared by the Claim, My Characters and Sign Up pages.
window.Guild = (() => {
  const CLASSES = [['Warrior', '#C69B6D', ['Tank', 'Melee DPS']], ['Paladin', '#F48CBA', ['Tank', 'Healer', 'Melee DPS']], ['Hunter', '#AAD372', ['Ranged DPS', 'Melee DPS']], ['Rogue', '#FFF468', ['Melee DPS']], ['Priest', '#E6E6E6', ['Healer', 'Ranged DPS']], ['Shaman', '#2F8FEA', ['Healer', 'Melee DPS', 'Ranged DPS']], ['Mage', '#3FC7EB', ['Ranged DPS']], ['Warlock', '#8788EE', ['Ranged DPS']], ['Druid', '#FF7C0A', ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS']]];
  const COLOR = Object.fromEntries(CLASSES.map(c => [c[0], c[1]]));
  const ORDER = ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS'];
  const ACC = '#A3BC6E';
  const KEY = 'md-guild-v2';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const low = s => String(s || '').trim().toLowerCase();
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  let me = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } })() || { device: rid(), keys: [], main: '' };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (_) {} };
  save();

  async function api(path, body) {
    const r = await fetch('/api/' + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: me.device, ...body }) }
      : { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again in a moment.');
    return d;
  }

  let roster = [], syncedAt = null;
  async function loadRoster() {
    const d = await api('roster');
    roster = d.characters || []; syncedAt = d.synced_at;
    // Characters that were merged into their guild copy keep working.
    const al = d.aliases || {};
    me.keys = [...new Set(me.keys.map(k => al[k] || k))];
    if (al[me.main]) me.main = al[me.main];
    // Forget claims for characters that no longer exist.
    me.keys = me.keys.filter(k => roster.some(c => c.key === k));
    if (!me.keys.includes(me.main)) me.main = me.keys[0] || '';
    save();
    return roster;
  }
  const byKey = k => roster.find(c => c.key === k);
  const mine = () => me.keys.map(byKey).filter(Boolean);
  const mainChar = () => byKey(me.main);
  function addClaim(key) { if (!me.keys.includes(key)) me.keys.push(key); if (!me.main) me.main = key; save(); }
  function dropClaim(key) { me.keys = me.keys.filter(k => k !== key); if (me.main === key) me.main = me.keys[0] || ''; save(); }
  function setMain(key) { me.main = key; save(); }
  function setVerified(discord) { me.verified = !!discord; if (discord) me.discord = discord; save(); }
  function setDiscord(discord) { me.discord = discord; save(); }

  const dot = cls => `<i class="rs-dot" style="background:${COLOR[cls] || '#999'}"></i>`;
  const chipStyle = on => 'min-height:44px;padding:0 18px;border-radius:4px;cursor:pointer;font-family:"Barlow Condensed",sans-serif;font-weight:600;font-size:15px;letter-spacing:.12em;border:1px solid ' + (on ? ACC : '#362D2A') + ';background:' + (on ? ACC : '#121011') + ';color:' + (on ? '#121011' : '#CFC7BE');

  function classTiles(el, sel) {
    el.innerHTML = CLASSES.map(([n, c, r]) => { const on = sel === n;
      return `<button type="button" data-c="${n}" aria-pressed="${on}" style="min-height:62px;text-align:left;padding:10px 14px;border-radius:6px;cursor:pointer;color:#F1ECE6;font-family:Cinzel,Georgia,serif;font-weight:700;font-size:16px;letter-spacing:.02em;border:1px solid ${on ? c : '#362D2A'};border-top:3px solid ${c};background:${on ? `color-mix(in srgb, ${c} 14%, #1B1716)` : '#241E1C'}${on ? `;box-shadow:inset 0 0 0 1px ${c}` : ''}">${n}<span style="display:block;font-family:Barlow,sans-serif;font-weight:500;font-size:13px;letter-spacing:0;color:#AEA49A;margin-top:2px">${r.map(x => x.replace(' DPS', '')).join(' · ')}</span></button>`; }).join('');
  }
  function roleRows(el, cls, picks) {
    const k = CLASSES.find(x => x[0] === cls);
    el.innerHTML = !k ? '<p style="font-size:15px;color:#8F857C">Pick a class first.</p>' : k[2].map(role => { const v = picks[role] || 'no';
      return `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:10px 14px;background:#241E1C;border-radius:6px"><span style="font-family:Cinzel,Georgia,serif;font-weight:700;font-size:17px">${role}</span><div role="group" aria-label="${role}" style="display:inline-flex;border:1px solid #362D2A;border-radius:4px;overflow:hidden;background:#121011">${[['main', 'MAIN', ACC], ['will', 'WILL PLAY', '#CDB07C'], ['no', 'NO', '#362D2A']].map(([val, lab, col], i) => `<button type="button" data-r="${role}" data-v="${val}" aria-pressed="${v === val}" style="min-height:44px;padding:0 14px;border:0;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:15px;letter-spacing:.12em;${i ? 'border-left:1px solid #362D2A;' : ''}${v === val ? `background:${col};color:${val === 'no' ? '#F1ECE6' : '#121011'}` : 'background:transparent;color:#CFC7BE'}">${lab}</button>`).join('')}</div></div>`; }).join('');
  }
  // Wires a class picker + role picker; state = { cls, picks }.
  function editor(tilesEl, rolesEl, state) {
    const draw = () => { if (tilesEl) classTiles(tilesEl, state.cls); roleRows(rolesEl, state.cls, state.picks); };
    if (tilesEl) tilesEl.addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (!b) return; state.cls = b.dataset.c; const k = CLASSES.find(x => x[0] === state.cls); state.picks = k[2].length === 1 ? { [k[2][0]]: 'main' } : {}; draw(); });
    rolesEl.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; if (b.dataset.v === 'main') for (const x in state.picks) if (state.picks[x] === 'main') state.picks[x] = 'will'; state.picks[b.dataset.r] = b.dataset.v; draw(); });
    return draw;
  }
  const picksFrom = c => { const p = c.main_role ? { [c.main_role]: 'main' } : {}; (c.also_play || []).forEach(r => { p[r] = 'will'; }); const k = CLASSES.find(x => x[0] === c.cls); if (!c.main_role && k && k[2].length === 1) p[k[2][0]] = 'main'; return p; };
  const picksOut = p => ({ main_role: Object.keys(p).find(x => p[x] === 'main') || '', also_play: ORDER.filter(x => p[x] === 'will') });
  const summary = c => `Level ${c.level}${c.race ? ' ' + c.race : ''} ${c.cls}${c.main_role ? ' · ' + c.main_role : ''}${(c.also_play || []).length ? ' · also ' + c.also_play.join(', ') : ''}`;
  const syncLine = () => syncedAt ? 'Levels and classes synced from the game ' + new Date(syncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : '';


  // Game-data view shared by My Characters and the public character page.
  const QUAL = { POOR: '#9d9d9d', COMMON: '#F1ECE6', UNCOMMON: '#1eff00', RARE: '#0070dd', EPIC: '#a335ee', LEGENDARY: '#ff8000', ARTIFACT: '#e6cc80', HEIRLOOM: '#00ccff' };
  const when = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  function renderInfo(d, c) {
    const card = (title, html, wide) => `<div class="md-card${wide ? ' ch-wide' : ''}"><span class="md-lab">${esc(title)}</span>${html}</div>`;
    const row = (a, b) => `<div class="ch-row"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
    const p = d.profile || {};
    const img = (d.media.find(m => m.key === 'avatar') || d.media.find(m => m.key === 'inset') || d.media[0]);
    const out = [];
    if (d.equipment.length) out.push(card('EQUIPMENT', `<div class="ch-list">${d.equipment.map(it => `<div class="ch-item"><span class="ch-slot">${esc(it.slot)}</span><span style="display:flex;gap:10px;align-items:flex-start">${it.icon ? `<img src="${esc(it.icon)}" alt="" width="36" height="36" loading="lazy" style="flex:none;border-radius:4px;border:1px solid ${QUAL[it.quality] || '#362D2A'}">` : ''}<span><strong style="color:${QUAL[it.quality] || '#F1ECE6'};font-weight:600">${esc(it.name)}</strong>${it.level ? ` <span style="color:#8F857C">· ilvl ${esc(it.level)}</span>` : ''}${it.stats.length || it.enchant.length ? `<br><span style="color:#AEA49A;font-size:13px">${esc([...it.stats, ...it.enchant].join(' · '))}</span>` : ''}</span></span></div>`).join('')}</div>`, true));
    if (d.specs.length) out.push(card('TALENTS', d.specs.map((g, i) => `<div style="margin-top:6px"><span style="font-size:13px;color:${g.active ? '#A3BC6E' : '#8F857C'}">${d.specs.length > 1 ? 'SPEC ' + (i + 1) + (g.active ? ' · ACTIVE' : '') : (g.active ? 'ACTIVE' : '')}</span>${g.trees.map(t => row(t.name, t.points != null ? t.points + ' points' : '')).join('')}</div>`).join('')));
    if (d.professions.length) out.push(card('PROFESSIONS', d.professions.map(pr => pr.tiers.map(t => row(pr.name + (t.name && t.name !== pr.name ? ' · ' + t.name : ''), t.skill != null ? `${t.skill}${t.max ? ' / ' + t.max : ''}` : '')).join('')).join('')));
    if (d.raids.length) out.push(card('RAID PROGRESS', d.raids.map(r => r.modes.map(m => row(r.name + (r.modes.length > 1 ? ' · ' + m.mode : ''), m.total ? `${m.done} / ${m.total}` : m.status)).join('')).join('')));
    const dg = d.dungeons.filter(x => x.kills);
    if (dg.length) out.push(card('DUNGEON BOSS KILLS', dg.map(x => row(x.name, x.kills)).join('')));
    out.push(card('AT A GLANCE', [
      d.achievements && ['Achievement points', d.achievements.points], d.achievements && ['Achievements', d.achievements.count],
      ['Quests completed', d.quests_completed], ['Mounts', d.collections.mounts], ['Pets', d.collections.pets], ['Toys', d.collections.toys],
      d.pvp && ['Honorable kills', d.pvp.honorable_kills], d.pvp && ['PvP rank', d.pvp.rank]].filter(x => x && x[1] != null).map(([a, b]) => row(a, b)).join('')));
    if (d.reputations.length) out.push(card('REPUTATION', d.reputations.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).map(r => row(r.name, r.standing)).join('')));
    if (d.titles.length) out.push(card('TITLES', `<p style="color:#CFC7BE">${esc(d.titles.join(' · '))}</p>`));
    if (d.statistics.length) out.push(card('STATISTICS', d.statistics.map(cat => `<details style="border-top:1px solid #362D2A;padding:8px 0"><summary style="cursor:pointer;font-weight:600">${esc(cat.name)} <span style="color:#8F857C;font-weight:400">${cat.stats.length}</span></summary>${cat.stats.map(st => row(st.name, typeof st.value === 'number' ? st.value.toLocaleString() : st.value)).join('')}</details>`).join(''), true));
    return {
      portrait: img ? `<img src="${esc(img.url)}" alt="${esc(c.name)} portrait" style="width:100%;height:100%;object-fit:cover;display:block">` : '',
      title: p.title ? p.title.replace('{name}', c.name) : '',
      facts: [['Race', p.race], ['Gender', p.gender], ['Faction', p.faction], ['Guild', p.guild], ['Ruleset', p.ruleset], ['Item level', p.item_level], ['Experience', p.experience != null && p.level < 60 ? p.experience.toLocaleString() + ' XP' : ''], ['Last login', when(p.last_login)]]
        .filter(x => x[1] !== '' && x[1] != null).map(([a, b]) => `<div><span class="md-lab">${esc(a.toUpperCase())}</span><div>${esc(b)}</div></div>`).join(''),
      cards: out.join(''),
      msg: 'Game data refreshes about every 30 minutes. Last pulled ' + when(d.at) + '.'
    };
  }

  return { renderInfo, CLASSES, COLOR, ORDER, ACC, $, esc, low, api, me: () => me, loadRoster, roster: () => roster, byKey, mine, mainChar, addClaim, dropClaim, setMain, setVerified, setDiscord, dot, chipStyle, editor, picksFrom, picksOut, summary, syncLine };
})();
