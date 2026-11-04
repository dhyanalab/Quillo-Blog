// Picker: sections, choices, saving and preview scaling.
(function () {
  const { THEMES, FONTS } = PK;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const S = [
    { id: 'theme', anchor: 's-theme', name: 'Colour theme', grid: 'cols3', rec: 'blue', w: 640,
      why: 'Colours for the whole blog. Use the Light / Dark switch at the top to see every preview both ways. Your pick also recolours every preview further down.',
      opts: THEMES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, theme: t })),
      sub: { id: 'darkmode', name: 'Dark mode', rec: 'both', opts: [
        { id: 'both', name: 'Light and dark', desc: 'follows the reader’s device, with a switch in the header' },
        { id: 'light', name: 'Light only', desc: 'one look for everyone' }] } },
    { id: 'font', anchor: 's-fonts', name: 'Fonts', grid: 'cols2', rec: 'plex', w: 640,
      why: 'Heading, body and code fonts. All are free and will be served from your own server, so pages stay fast.',
      opts: FONTS.map((f) => ({ id: f.id, name: f.name, desc: f.desc })) },
    { id: 'header', anchor: 's-header', name: 'Header', grid: 'one', rec: 'n1', w: 1280,
      why: 'The bar at the top of every page. Each sample shows the Projects menu open, listing categories and featured projects like CircuitDigest.',
      opts: [
        { id: 'n1', name: 'Clean bar', desc: 'Logo, menu, search, Sign in and Subscribe in one white bar. Quiet and modern.' },
        { id: 'n2', name: 'Two rows, news style', desc: 'A thin top strip with the date, social links and Sign in, a large search box, then the menu in its own row.' },
        { id: 'n3', name: 'Dark bar', desc: 'The same single bar in a dark colour, so the header stands apart from the page.' }] },
    { id: 'home', anchor: 's-home', name: 'Home page', grid: 'one', rec: 'a', w: 1280, crop: 1250,
      why: 'Every layout has an Editor’s Choice block, a Latest News column and category sections. Use “Show whole page” to see all of it.',
      opts: [
        { id: 'a', name: 'Magazine', desc: 'Editor’s Choice at the top, then Latest Projects with a Latest News column beside them, then Tutorials, Videos and the newsletter. Closest to CircuitDigest.' },
        { id: 'b', name: 'Newsroom', desc: 'Three columns: a Latest News timeline on the left, the main story in the middle and Editor’s Choice ranked on the right. Category tabs below.' },
        { id: 'c', name: 'Big story and sidebar', desc: 'One large featured story with Editor’s Choice beside it, then a list of the latest posts with News, Most read and Topics in a sidebar.' }] },
    { id: 'article', anchor: 's-article', name: 'Article page', grid: 'one', rec: 'a', w: 1280, crop: 1450,
      why: 'Every layout keeps the top short: title, author and date, then the picture. Full code sits in its own box after the FAQ and above Downloads, then comments. The previews use your other picks.',
      opts: [
        { id: 'a', name: 'Classic with sidebar', desc: 'Share icons beside the author line. A sidebar holds the contents list, Latest News and the newsletter.' },
        { id: 'b', name: 'Centred reading', desc: 'One centred column with no sidebar, the contents list under the quick answer, and share icons in a rail beside the text.' },
        { id: 'c', name: 'Picture first', desc: 'A full-width picture with the title on it, then the contents list and share icons on the left of the text.' }] },
    { id: 'share', anchor: 's-share', name: 'Share buttons', grid: 'cols2', rec: 's1', w: 820,
      why: 'Icons instead of text bubbles. The first icon in each sample shows its hover state.',
      opts: [
        { id: 's1', name: 'Outline icons', desc: 'Small round icons that take the brand colour on hover.' },
        { id: 's2', name: 'Brand colours', desc: 'Square icons in each network’s own colour.' },
        { id: 's3', name: 'One Share button', desc: 'A single button that opens a menu with every network and Copy link.' },
        { id: 's4', name: 'Quiet icons', desc: 'Grey icons with no borders and a small Share label.' }] },
    { id: 'code', anchor: 's-code', name: 'Source code box', grid: 'one', rec: 'c1', w: 900,
      why: 'The full code moves out of the article into this box, after the FAQ and above Downloads. Short snippets that explain a step can still sit in the text.',
      opts: [
        { id: 'c1', name: 'Tabbed panel', desc: 'One tab per file, with Copy, Download and GitHub buttons. Shows the first lines with “Show all”.' },
        { id: 'c2', name: 'Dark editor', desc: 'Looks like a code editor: dark in every theme, file tabs and a status line.' },
        { id: 'c3', name: 'File list', desc: 'Each file is a row you can open and close, with its own Copy and Download buttons, plus “Download all”.' }],
      sub: { id: 'syntax', name: 'Code colours', rec: 'colour', opts: [
        { id: 'colour', name: 'Coloured', desc: 'keywords, text and comments in different colours' },
        { id: 'plain', name: 'Plain', desc: 'one colour, comments dimmed' }] } },
    { id: 'downloads', anchor: 's-files', name: 'Downloads and GitHub', grid: 'one', rec: 'd1', w: 900,
      why: 'Real download buttons for STL and PDF files, and a GitHub button that looks different from everything else.',
      opts: [
        { id: 'd1', name: 'GitHub card and file cards', desc: 'A dark GitHub card on top, then one card per file with its type, size and a Download button.' },
        { id: 'd2', name: 'Big buttons', desc: 'Three large buttons in a row: GitHub, STL files and the circuit diagram PDF.' },
        { id: 'd3', name: 'File table', desc: 'A compact list with a type badge, size and download icon for each file, and GitHub in the corner.' }] },
    { id: 'table', anchor: 's-tables', name: 'Tables', grid: 'cols3', rec: 't1', w: 640,
      why: 'Tables fit their content instead of stretching across the page. In the editor you edit them in a grid.',
      opts: [
        { id: 't1', name: 'Clean lines', desc: 'A bold header line and light row lines.' },
        { id: 't2', name: 'Striped rows', desc: 'A shaded header and alternate row shading.' },
        { id: 't3', name: 'Boxed grid', desc: 'Every cell outlined, with a coloured header.' }] },
    { id: 'comments', anchor: 's-talk', name: 'Comments', grid: 'cols2', rec: 'cm1', w: 820,
      why: 'Readers create a free account, then comment and reply. You approve, hide or delete comments in the admin.',
      opts: [
        { id: 'cm1', name: 'Open thread', desc: 'Comments as a simple thread. Shown here as a signed-out reader sees it, with Create account and Sign in.' },
        { id: 'cm2', name: 'Comment cards', desc: 'Each comment in its own card. Shown here as a signed-in reader sees it, with the comment box open.' }] },
    { id: 'admin', anchor: 's-admin', name: 'Admin look', grid: 'one', rec: 'a1', w: 1280,
      why: 'Laid out like Ghost: a sidebar with Posts, Pages, Tags, Media, Members and Comments, and a clean list of posts.',
      opts: [
        { id: 'a1', name: 'Ghost light', desc: 'Light grey sidebar, black buttons. The closest to Ghost.' },
        { id: 'a2', name: 'Dark sidebar', desc: 'A dark sidebar beside a white working area.' },
        { id: 'a3', name: 'Your brand colour', desc: 'White sidebar with your theme colour for the selected item and the New post button.' }] },
    { id: 'editor', anchor: 's-editor', name: 'Post editor', grid: 'one', rec: 'e3', w: 1280,
      why: 'Where you write. Every option saves as Markdown, has a + menu for images, tables, code, videos and file downloads, and lets you edit tables in a grid.',
      opts: [
        { id: 'e1', name: 'Visual, like Ghost', desc: 'You write on a clean page that looks like the post. Settings slide in from the right.' },
        { id: 'e2', name: 'Markdown and preview', desc: 'Markdown on the left and the finished post on the right.' },
        { id: 'e3', name: 'Visual with a Markdown switch', desc: 'Writes like Ghost, with a formatting bar and a switch to Markdown when you want it.' }] },
  ];
  const byId = Object.fromEntries(S.map((s) => [s.id, s]));
  const SUBS = Object.fromEntries(S.filter((s) => s.sub).map((s) => [s.sub.id, s.sub]));

  const state = { picks: {}, notes: {}, done: false };
  let mode = 'light';
  try { const m = localStorage.getItem('pk-mode'); if (m === 'dark' || m === 'light') mode = m; } catch (e) {}
  try { const l = JSON.parse(localStorage.getItem('pk-state') || 'null'); if (l && l.picks) Object.assign(state, l); } catch (e) {}

  const eff = (id) => state.picks[id] || (byId[id] || SUBS[id]).rec;
  const theme = () => THEMES.find((t) => t.id === eff('theme'));
  const font = () => FONTS.find((f) => f.id === eff('font'));
  const pk = () => ({ header: eff('header'), share: eff('share'), code: eff('code'), syntax: eff('syntax'), downloads: eff('downloads'), table: eff('table'), comments: eff('comments') });
  const lightVars = () => `${PK.themeVars(theme(), 'light')};${PK.fontVars(font())}`;
  const optName = (id, v) => ((byId[id] || SUBS[id]).opts.find((o) => o.id === v) || {}).name || v;

  function mockFor(key) {
    const [sid, oid] = key.split(':');
    const p = pk();
    switch (sid) {
      case 'theme': return PK.themeCard(THEMES.find((t) => t.id === oid), mode, font());
      case 'font': return PK.fontCard(FONTS.find((f) => f.id === oid));
      case 'header': return PK.mk(PK.headerSample(oid), 1280);
      case 'home': return PK.mk(PK['home' + oid.toUpperCase()](p), 1280);
      case 'article': return PK.mk(PK['article' + oid.toUpperCase()](p), 1280);
      case 'share': return PK.mk(PK.shareDemo(oid), 820);
      case 'code': return PK.mk(PK.cmpDemo(PK.codeBox(oid, p.syntax)), 900);
      case 'downloads': return PK.mk(PK.cmpDemo(PK.downloads(oid)), 900);
      case 'table': return PK.mk(PK.cmpDemo(`<h2 class="m-blk-t" style="font-size:22px">Components required</h2>${PK.table(oid)}`), 640);
      case 'comments': return PK.mk(PK.cmpDemo(PK.comments(oid)), 820);
      case 'admin': return PK.mk(PK.adminMock(oid), 1280, lightVars());
      case 'editor': return PK.mk(PK.editorMock(oid), 1280, lightVars());
      case 'final': return PK.mk(oid === 'home' ? PK['home' + eff('home').toUpperCase()](p) : PK['article' + eff('article').toUpperCase()](p), 1280);
    }
    return '';
  }

  // Scale each preview to its card.
  function fit(f) {
    const m = f.firstElementChild;
    if (!m) return;
    const w = +f.dataset.w, fw = f.clientWidth;
    const s = Math.min(1, fw / w);
    m.style.transform = `scale(${s})`;
    m.style.left = s < 1 ? '0px' : Math.round((fw - w) / 2) + 'px';
    const full = m.offsetHeight, crop = +f.dataset.crop || 0, open = f.classList.contains('open');
    const h = crop && !open ? Math.min(full, crop) : full;
    f.style.height = Math.ceil(h * s) + 'px';
    f.classList.toggle('cropped', !!crop && !open && full > crop);
  }
  const ro = new ResizeObserver((es) => es.forEach((e) => fit(e.target)));

  function renderMocks() {
    $('#scope').setAttribute('style', `${PK.themeVars(theme(), mode)};${PK.fontVars(font())}`);
    $$('.frame[data-mock]').forEach((f) => { f.innerHTML = mockFor(f.dataset.mock); fit(f); });
    const ff = $('#full-frame');
    if (ff.dataset.mock && $('#full').open) { ff.innerHTML = mockFor(ff.dataset.mock); fit(ff); }
  }

  const sw = (t) => `<div class="swatches" aria-hidden="true">${['light', 'dark'].map((m) => `<div><span class="l">${m === 'light' ? 'Light' : 'Dark'}</span>${['bg', 'sf', 'ink', 'ac', 'acText', 'hi'].map((k) => `<i style="background:${t[m][k]}"></i>`).join('')}</div>`).join('')}</div>`;
  function optHtml(s, o) {
    return `<article class="opt" data-sec="${s.id}" data-opt="${o.id}">
      <div class="frame" data-w="${s.w}"${s.crop ? ` data-crop="${s.crop}"` : ''} data-mock="${s.id}:${o.id}"></div>
      <div class="opt-meta"><h3>${o.name}${o.id === s.rec ? '<span class="rec">Recommended</span>' : ''}</h3><p>${o.desc}</p>${s.id === 'theme' ? sw(o.theme) : ''}
        <div class="opt-actions"><label class="choose"><input type="radio" name="pick-${s.id}" value="${o.id}" id="pick-${s.id}-${o.id}"><span class="ring"></span><span class="lbl">Choose this</span></label>
          <button type="button" class="btn-q" data-full="${s.id}:${o.id}">View full size</button>${s.crop ? '<button type="button" class="btn-q" data-expand>Show whole page</button>' : ''}</div></div></article>`;
  }
  const subHtml = (u) => `<div class="sub" role="radiogroup" aria-label="${u.name}"><b>${u.name}</b>${u.opts.map((o) => `<label class="choose"><input type="radio" name="pick-${u.id}" value="${o.id}" id="pick-${u.id}-${o.id}"><span class="ring"></span><span>${o.name} <small>· ${o.desc}${o.id === u.rec ? ' · recommended' : ''}</small></span></label>`).join('')}</div>`;
  const secHtml = (s, i) => `<section class="sec" id="${s.anchor}" aria-labelledby="h-${s.id}">
      <div class="sec-head"><span class="sec-num">${i + 1} of ${S.length}</span><h2 id="h-${s.id}">${s.name}</h2><span class="picked" data-picked="${s.id}"></span></div>
      <p class="why">${s.why}</p><div class="opts ${s.grid}" role="radiogroup" aria-labelledby="h-${s.id}">${s.opts.map((o) => optHtml(s, o)).join('')}</div>
      ${s.sub ? subHtml(s.sub) : ''}
      <div class="note"><label for="note-${s.id}">Anything to change here? (optional)</label><textarea id="note-${s.id}" data-note="${s.id}" rows="2" placeholder="For example: option B, but with a bigger title"></textarea></div></section>`;

  function applyPicks() {
    $$('input[type=radio][name^="pick-"]').forEach((r) => {
      const id = r.name.slice(5);
      r.checked = (state.picks[id] || (SUBS[id] ? SUBS[id].rec : null)) === r.value;
      const opt = r.closest('.opt');
      if (opt) { opt.classList.toggle('chosen', r.checked); r.parentElement.querySelector('.lbl').textContent = r.checked ? 'Chosen' : 'Choose this'; }
    });
    S.forEach((s) => {
      const v = state.picks[s.id];
      $(`[data-picked="${s.id}"]`).textContent = v ? `✓ ${optName(s.id, v)}` : '';
      const li = $(`.index li[data-for="${s.id}"]`);
      if (li) { li.classList.toggle('done', !!v); li.querySelector('.dot').textContent = v ? '✓' : ''; }
    });
    $$('textarea[data-note]').forEach((t) => { if (document.activeElement !== t) t.value = state.notes[t.dataset.note] || ''; });
    const n = S.filter((s) => state.picks[s.id]).length;
    $('#prog-n').textContent = `${n} of ${S.length} chosen`;
    $('#prog-bar').style.width = `${(n / S.length) * 100}%`;
    renderSummary();
  }

  function renderSummary() {
    const rows = [];
    S.forEach((s) => {
      rows.push([s.name, state.picks[s.id] ? optName(s.id, state.picks[s.id]) : null, state.notes[s.id] || '']);
      if (s.sub) rows.push([s.sub.name, optName(s.sub.id, eff(s.sub.id)) + (state.picks[s.sub.id] ? '' : ' (default)'), '']);
    });
    $('#sum-body').innerHTML = rows.map(([a, b, c]) => `<tr><td>${a}</td>${b ? `<td>${PK.esc(b)}</td>` : '<td class="none">Not chosen yet</td>'}<td>${PK.esc(c)}</td></tr>`).join('');
    $('#done-msg').hidden = !state.done;
  }

  function picksText() {
    const out = ['IoT Studio Blog design picks'];
    S.forEach((s) => {
      out.push(`${s.name}: ${state.picks[s.id] ? optName(s.id, state.picks[s.id]) : 'not chosen'}`);
      if (s.sub) out.push(`${s.sub.name}: ${optName(s.sub.id, eff(s.sub.id))}`);
      if (state.notes[s.id]) out.push(`  Note: ${state.notes[s.id]}`);
    });
    return out.join('\n');
  }

  // Saving: shared store when available, this browser otherwise.
  let db = null, saving = false, again = false, timer = null;
  const DOC = 'choices/main';
  const MSG = {
    local: 'Your picks are kept in this browser only. Use “Copy picks” at the end and paste them to Claude.',
    loading: 'Loading your saved picks…', slow: 'Can’t reach your saved picks yet. Choosing still works here.',
    saved: 'Saved. Claude can read your picks.', saving: 'Saving…',
    error: 'Couldn’t save. Use “Copy picks” at the end instead.', readonly: 'Only the page owner can save picks here. Use “Copy picks” instead.',
  };
  function setStatus(k) { const el = $('#status'); el.textContent = MSG[k]; el.classList.toggle('ok', k === 'saved'); }
  function queueSave(ms = 250) { clearTimeout(timer); timer = setTimeout(save, ms); }
  async function save() {
    try { localStorage.setItem('pk-state', JSON.stringify(state)); } catch (e) {}
    if (!db) return;
    if (saving) { again = true; return; }
    saving = true; setStatus('saving');
    try {
      await db.doc(DOC).set({ picks: state.picks, notes: state.notes, done: state.done, updatedAt: new Date().toISOString() });
      setStatus('saved');
    } catch (e) { setStatus(e && e.code === 'invalid_argument' ? 'readonly' : 'error'); }
    saving = false;
    if (again) { again = false; save(); }
  }
  async function connect() {
    try { db = window.claude && window.claude.use ? await window.claude.use('db') : null; } catch (e) { db = null; }
    if (!db) { setStatus('local'); return; }
    setStatus('loading');
    const t = setTimeout(() => setStatus('slow'), 10000);
    try {
      const snap = await db.doc(DOC).get();
      clearTimeout(t);
      if (snap.exists) {
        const d = snap.data() || {};
        state.picks = { ...(d.picks || {}) }; state.notes = { ...(d.notes || {}) }; state.done = !!d.done;
        applyPicks(); renderMocks();
      }
      setStatus('saved');
    } catch (e) { clearTimeout(t); setStatus('error'); }
  }

  // Full-size view.
  function openFull(key) {
    const [sid, oid] = key.split(':');
    const f = $('#full-frame');
    f.dataset.mock = key;
    f.dataset.w = sid === 'final' ? 1280 : byId[sid].w;
    f.style.width = '';
    $$('#zoom button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === 'fit')));
    $('#full-title').textContent = sid === 'final' ? (oid === 'home' ? 'Your home page' : 'Your article page') : `${byId[sid].name}: ${optName(sid, oid)}`;
    f.innerHTML = mockFor(key);
    $('#full').showModal();
    fit(f);
  }

  function build() {
    $('#sections').innerHTML = S.map(secHtml).join('');
    $('#index-list').innerHTML = S.map((s) => `<li data-for="${s.id}"><a href="#${s.anchor}"><span class="dot"></span>${s.name}</a></li>`).join('')
      + '<li><a href="#s-summary"><span class="dot">★</span>Your picks</a></li>';
    $$('#mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    renderMocks();
    applyPicks();
    $$('.frame').forEach((f) => ro.observe(f));

    document.addEventListener('change', (e) => {
      const r = e.target;
      if (r.type !== 'radio' || !r.name.startsWith('pick-')) return;
      state.picks[r.name.slice(5)] = r.value;
      state.done = false;
      applyPicks(); renderMocks(); queueSave();
    });
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.dataset || !t.dataset.note) return;
      state.notes[t.dataset.note] = t.value;
      renderSummary(); queueSave(900);
    });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.full) openFull(b.dataset.full);
      else if (b.hasAttribute('data-expand')) {
        const f = b.closest('.opt, .final-item').querySelector('.frame');
        f.classList.toggle('open');
        b.textContent = f.classList.contains('open') ? 'Show less' : 'Show whole page';
        fit(f);
      } else if (b.dataset.mode) {
        mode = b.dataset.mode;
        try { localStorage.setItem('pk-mode', mode); } catch (err) {}
        $$('#mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        renderMocks();
      } else if (b.dataset.z) {
        const f = $('#full-frame');
        f.style.width = b.dataset.z === 'fit' ? '' : f.dataset.w + 'px';
        $$('#zoom button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        fit(f);
      } else if (b.id === 'full-close') $('#full').close();
      else if (b.id === 'copy') {
        const text = picksText(), box = $('#copybox');
        box.value = text; box.hidden = false;
        const done = () => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy picks'), 2000); };
        try { navigator.clipboard.writeText(text).then(done, () => box.select()); } catch (err) { box.select(); }
      } else if (b.id === 'finish') {
        state.done = true; renderSummary(); queueSave(0);
      }
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => $$('.frame').forEach(fit));
    connect();
  }
  build();
})();
