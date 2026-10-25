/* hub-shell.js - shared left sidebar for the Aloe Internal Hub (PREVIEW stage).
   Does nothing unless this browser has the preview cookie.
   Turn on:  open any page with ?preview=1      Turn off: ?preview=0
   Only lists pages that exist today. To add a page later, add one line to GROUPS. */
(function () {
  try {
    var COOKIE = 'aloe_preview';
    var q = new URLSearchParams(location.search).get('preview');
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    if (q === '1') document.cookie = COOKIE + '=1; Max-Age=2592000; Path=/; SameSite=Lax' + secure;
    if (q === '0') document.cookie = COOKIE + '=; Max-Age=0; Path=/; SameSite=Lax' + secure;
    var on = document.cookie.split(';').some(function (c) { return c.trim() === COOKIE + '=1'; });
    if (!on || q === '0') return;
    if (document.getElementById('aloe-shell')) return;

    var GROUPS = [
      { id: 'overview', label: 'Overview', items: [
        ['Home', '/dashboard'], ['Ask the Hub', '/chat'] ] },
      { id: 'leasing', label: 'Leasing', items: [
        ['Vacancy', '/vacancy'], ['Vacancy risk', '/vacancy-risk'],
        ['Rent analysis', '/rent-analysis'], ['Owner report generator', '/owner-report'] ] },
      { id: 'residents', label: 'Residents', items: [
        ['Tenant resources', 'https://resident.aloepm.com/resources/tenant', true],
        ['Lease renewals', '/renewals'], ['HOA generator', '/hoa'] ] },
      { id: 'maint', label: 'Maintenance', items: [
        ['Vendors', '/vendors'], ['Appliance scanner', '/appliance-scanner'] ] },
      { id: 'props', label: 'Properties', items: [
        ['Property map', '/map'], ['Property media analyzer', '/media-analyzer'] ] },
      { id: 'acct', label: 'Accounting', items: [
        ['Bills and recon', '/recon-bills'], ['Reconciliation', '/recon'],
        ['Expense log', '/expense-log'], ['Suppressed fees', '/suppressed-fees'] ] },
      { id: 'reports', label: 'Reports', items: [ ['Metrics', '/metrics'] ] },
      { id: 'agents', label: 'Agents', items: [
        ['Overview', '/agents'], ['Activity', '/agents/activity'], ['Playbooks', '/agents/playbooks'],
        ['Knowledge', '/agents/knowledge'], ['SOPs', '/agents/sops'], ['Jobs', '/agents/jobs'],
        ['Tools', '/agents/tools'], ['Training', '/agents/training'] ] },
      { id: 'tools', label: 'Analysis and tools', items: [
        ['Sale analysis', '/sale-analysis'], ['Sandbox', '/sandbox'] ] }
    ];

    var path = location.pathname.replace(/\/+$/, '') || '/';
    var STORE = 'aloe_shell_open';
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) {}

    function el(tag, attrs, kids) {
      var n = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
      });
      (kids || []).forEach(function (c) { n.appendChild(c); });
      return n;
    }

    var css = [
      "@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');",
      '#aloe-shell{position:fixed;top:0;left:0;bottom:0;width:248px;z-index:9999;box-sizing:border-box;background:#F4F8F8;border-right:1px solid #DCE6E7;padding:18px 12px 16px;display:flex;flex-direction:column;overflow-y:auto;font-family:Manrope,system-ui,sans-serif;color:#1B2B2E;transition:transform .2s}',
      '#aloe-shell *{box-sizing:border-box}',
      '#aloe-shell .as-brand{display:flex;align-items:center;gap:10px;padding:0 8px 14px;border-bottom:1px solid #DCE6E7;margin-bottom:8px}',
      '#aloe-shell .as-brand img{height:34px;width:auto;display:block}',
      '#aloe-shell .as-brand span{font-size:12px;font-weight:700;color:#4A6466}',
      '#aloe-shell .as-gh{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:36px;padding:8px;margin-top:4px;border:0;background:transparent;border-radius:8px;cursor:pointer;font:800 11px Manrope,system-ui,sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#4A6466}',
      '#aloe-shell .as-gh:hover,#aloe-shell .as-a:hover{background:#E6EFF0}',
      '#aloe-shell .as-gh svg{transition:transform .15s}',
      '#aloe-shell .as-gh[aria-expanded=true] svg{transform:rotate(90deg)}',
      '#aloe-shell .as-a{display:flex;align-items:center;min-height:38px;padding:0 10px;border-radius:8px;font:500 14px Manrope,system-ui,sans-serif;color:#2E4144;text-decoration:none}',
      '#aloe-shell .as-a[aria-current=page]{background:#DDF4FA;box-shadow:inset 3px 0 0 #3CC3E1;font-weight:700;color:#0A5468}',
      '#aloe-shell .as-a:focus-visible,#aloe-shell .as-gh:focus-visible{outline:2px solid #2A8FA6;outline-offset:1px}',
      '#aloe-shell .as-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid #DCE6E7;font-size:12px;font-weight:600;color:#4A6466;display:flex;justify-content:space-between}',
      '#aloe-shell .as-foot a{color:#0A5468;text-decoration:none}',
      '#aloe-shell [hidden]{display:none!important}',
      '#aloe-toggle{display:none;position:fixed;top:10px;left:10px;z-index:10000;min-width:44px;min-height:44px;border:1px solid #DCE6E7;border-radius:10px;background:#fff;color:#0A5468;font:800 18px Manrope,system-ui,sans-serif;cursor:pointer}',
      'body.aloe-shell-on{padding-left:248px!important}',
      'body.aloe-shell-on .topbar{background:#fff!important;color:#1B2B2E!important;border-bottom:1px solid #DCE6E7}',
      'body.aloe-shell-on .topbar .logo-mark,body.aloe-shell-on .topbar .logo-name,body.aloe-shell-on .topbar .logo-sep{display:none!important}',
      'body.aloe-shell-on .topbar .logo-page{color:#1B2B2E!important;font-weight:700;font-size:15px}',
      'body.aloe-shell-on .topbar .btn-ghost{background:#fff!important;color:#2E4144!important;border:1px solid #B4C3C3!important}',
      'body.aloe-shell-on .topbar-right .btn-ghost:not(#force-btn){display:none!important}',
      '@media (max-width:900px){body.aloe-shell-on{padding-left:0!important}#aloe-shell{transform:translateX(-100%)}#aloe-shell.as-open{transform:none;box-shadow:0 0 30px rgba(0,0,0,.2)}#aloe-toggle{display:block}body.aloe-shell-on .topbar{padding-left:64px!important}}'
    ].join('\n');
    var style = el('style', { id: 'aloe-shell-css' });
    style.textContent = css;
    document.head.appendChild(style);

    var chev = function () {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '14'); s.setAttribute('height', '14');
      s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2');
      s.setAttribute('stroke-linecap', 'round'); s.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M9 6l6 6-6 6'); s.appendChild(p); return s;
    };

    var nav = el('nav', { id: 'aloe-shell', 'aria-label': 'Hub navigation' });
    var logo = el('img', { src: '/logo.png', alt: 'Aloe Property Management' });
    nav.appendChild(el('div', { 'class': 'as-brand' }, [logo, el('span', { text: 'Internal Hub' })]));

    GROUPS.forEach(function (g) {
      var hasCurrent = g.items.some(function (it) { return it[1] === path || (it[1] !== '/' && !it[2] && path.indexOf(it[1] + '/') === 0); });
      var open = hasCurrent || (g.id in saved ? !!saved[g.id] : g.id === 'overview');
      var btn = el('button', { 'class': 'as-gh', type: 'button', 'aria-expanded': String(open) }, [el('span', { text: g.label }), chev()]);
      var list = el('div', {});
      list.hidden = !open;
      g.items.forEach(function (it) {
        var a = el('a', { 'class': 'as-a', href: it[1], text: it[0] });
        if (it[2]) { a.target = '_blank'; a.rel = 'noopener'; }
        if (it[1] === path || (!it[2] && path.indexOf(it[1] + '/') === 0)) a.setAttribute('aria-current', 'page');
        list.appendChild(a);
      });
      btn.addEventListener('click', function () {
        var now = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(now)); list.hidden = !now;
        saved[g.id] = now;
        try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) {}
      });
      nav.appendChild(btn); nav.appendChild(list);
    });

    nav.appendChild(el('div', { 'class': 'as-foot' }, [
      el('span', { text: location.hostname }),
      el('a', { href: '/logout', text: 'Sign out' })
    ]));

    var tog = el('button', { id: 'aloe-toggle', type: 'button', 'aria-label': 'Open menu', text: '☰' });
    tog.addEventListener('click', function () { nav.classList.toggle('as-open'); });

    function mount() {
      document.body.classList.add('aloe-shell-on');
      document.body.insertBefore(nav, document.body.firstChild);
      document.body.appendChild(tog);
    }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  } catch (err) {
    if (window.console) console.warn('[hub-shell] skipped:', err);
  }
})();
