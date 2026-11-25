// Guildie vs visitor. A browser with a claimed character is a guildie; anyone else is a visitor.
// Visitors don't see the guild pages in the menus, and opening one shows a "claim your character" prompt.
// This is a tidy-up, not security: the data behind these pages is still reachable by anyone determined.
// Loaded in <head> on every page (before the body draws) so nothing flashes.
(function () {
  var GUILD = ['/crafters', '/signup', '/roster', '/character', '/dkp'];
  var claimed = false;
  try { var me = JSON.parse(localStorage.getItem('md-guild-v2') || 'null'); claimed = !!(me && me.keys && me.keys.length); } catch (_) {}
  var path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  var root = document.documentElement;
  root.classList.add(claimed ? 'md-guildie' : 'md-visitor');
  if (claimed) return;

  var locked = GUILD.indexOf(path) !== -1 && path !== '/dkp'; // /dkp has its own claim prompt
  if (locked) root.classList.add('md-lock');
  var css = GUILD.map(function (p) { return '.md-visitor a[href="' + p + '"],.md-visitor a[href^="' + p + '?"]'; }).join(',') + '{display:none!important}'
    + '.md-lock header + div ~ *:not(footer):not(.md-gate){display:none!important}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var nudgeOff = false; try { nudgeOff = localStorage.getItem('md-nudge-off') === '1'; } catch (_) {}
  document.addEventListener('DOMContentLoaded', function () {
    var sub = document.querySelector('nav[aria-label="Forever pages"]');
    var bar = sub && sub.closest('header + div');
    var next = encodeURIComponent(path.slice(1) + location.search);
    if (locked) {
      var box = document.createElement('section'); box.className = 'md-gate';
      box.innerHTML = '<div style="max-width:640px;margin:0 auto;padding:clamp(56px,8vw,96px) 24px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px">'
        + '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:600;font-size:15px;letter-spacing:.24em;color:#A3BC6E">GUILD MEMBERS</div>'
        + '<h1 style="font-size:clamp(30px,4.6vw,42px);line-height:1.1;color:#F7F2EC">Claim your character to see this</h1>'
        + '<p style="color:#CFC7BE;font-size:17px">Crafters, raid signups, the roster and DKP are for Mystic Dragons members. Find your character in the guild list and claim it. It takes a few seconds and stays on this device.</p>'
        + '<a href="/claim?next=' + next + '" style="display:inline-flex;align-items:center;gap:10px;background:#A3BC6E;color:#121011;text-decoration:none;font-family:\'Barlow Condensed\',sans-serif;font-weight:600;font-size:17px;letter-spacing:.1em;padding:14px 22px;border-radius:4px">CLAIM YOUR CHARACTER →</a>'
        + '<p style="color:#8F857C;font-size:15px">Not in the guild yet? <a href="https://discord.gg/mfScPwH9rY" target="_blank" rel="noopener" style="color:#CDB07C">Come say hi on Discord</a>.</p></div>';
      if (bar) bar.after(box); else (document.querySelector('header') || document.body.firstChild).after(box);
      return;
    }
    if (bar && !nudgeOff) {
      var n = document.createElement('div');
      n.style.cssText = 'background:#1B1716;border-bottom:1px solid #362D2A';
      n.innerHTML = '<div style="max-width:1160px;margin:0 auto;padding:12px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;font-size:15px;color:#CFC7BE">'
        + '<span>In the guild? Claim your character to see crafters, raid signups, the roster and your DKP.</span>'
        + '<a href="/claim?next=' + next + '" style="color:#A3BC6E;font-weight:600;text-decoration:none">Claim your character →</a>'
        + '<button type="button" aria-label="Hide this" style="margin-left:auto;background:none;border:0;color:#8F857C;font-size:20px;line-height:1;cursor:pointer;padding:4px 8px">×</button></div>';
      n.querySelector('button').addEventListener('click', function () { n.remove(); try { localStorage.setItem('md-nudge-off', '1'); } catch (_) {} });
      bar.after(n);
    }
  });
})();
