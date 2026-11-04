// Preview renderers, part 1: helpers, headers and home pages.
(function () {
  const { I, B, ILL, GR, P, NEWS } = PK;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ic = (n, s = 18) => `<svg class="m-ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
  const brand = (n, s = 18) => `<svg class="m-ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${B[n]}"/></svg>`;
  const play = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
  const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const av = (name, cls = '') => `<span class="m-av ${cls}">${initials(name)}</span>`;

  const ph = (g, il, extra = '') => `<div class="m-ph" style="--g:${GR[g]}"><svg viewBox="0 0 120 70" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ILL[il]}</svg>${extra}</div>`;
  const mk = (html, w, style = '') => `<div class="mock" style="--w:${w}px;${style}">${html}</div>`;

  const logo = () => `<div class="m-logo"><span class="m-mark">${ic('chip', 20)}</span><span>IoT Studio <span class="m-bl">Blog</span></span></div>`;
  const NAV = ['Projects', 'Tutorials', 'News', 'ESP32', 'Arduino', 'IoT', 'Videos'];
  const navItems = (caretOn = [0, 1]) => NAV.map((n, i) => `<span class="${i === 0 ? 'on' : ''}">${n}${caretOn.includes(i) ? ic('down', 14) : ''}</span>`).join('');

  function header(v, opts = {}) {
    const menu = opts.menu ? megaMenu() : '';
    if (v === 'n2') {
      return `<header class="m-h2">
        <div class="m-top"><div class="m-in"><span>Tuesday, 3 November 2026</span><span>·</span><b>ESP32, Arduino and IoT projects you can build this weekend</b>
          <div class="m-soc">${brand('youtube', 15)}${brand('x', 13)}${brand('linkedin', 13)}<span>·</span><b>Sign in</b><span>Create account</span></div></div></div>
        <div class="m-mid"><div class="m-in">${logo()}<div class="m-search">${ic('search', 17)} Search projects, tutorials and news</div><span class="m-icb">${ic('moon', 17)}</span><span class="m-btn">Subscribe</span></div></div>
        <div class="m-bar"><div class="m-in">${NAV.map((n, i) => `<span class="${i === 0 ? 'on' : ''}">${n}${i < 2 ? ic('down', 13) : ''}</span>`).join('')}</div></div>
        ${menu}</header>`;
    }
    const cls = v === 'n3' ? 'm-h3' : 'm-h1';
    return `<header class="${cls}"><div class="m-in m-row">${logo()}<nav class="m-nav">${navItems()}</nav>
      <div class="m-tools"><span class="m-icb">${ic('search', 17)}</span><span class="m-icb">${ic('moon', 17)}</span><span class="m-link">Sign in</span><span class="m-btn">Subscribe</span></div></div>${menu}</header>`;
  }

  function megaMenu() {
    return `<div class="m-mega"><div class="m-mega-col"><b>Projects</b><span>ESP32 Projects</span><span>ESP32-CAM Projects</span><span>Arduino Projects</span><span>IoT Projects</span><span>Sensor Projects</span><span>All projects →</span></div>
      <div class="m-mega-feat"><b>Featured projects</b><div class="m-grid3">${[P[0], P[1], P[4]].map((p) => `<div class="m-card">${ph(p.g, p.il)}<h3 style="font-size:15.5px">${p.t}</h3></div>`).join('')}</div></div></div>`;
  }

  const card = (p, o = {}) => `<article class="m-card">${ph(p.g, p.il, o.video ? `<span class="m-play">${play}</span><span class="m-dur">${o.video}</span>` : '')}
    <div class="m-cat">${p.c}</div><h3>${p.t}</h3>${o.ex ? `<p>${p.x}</p>` : ''}<div class="m-meta"><span>${p.d}</span></div></article>`;
  const hcard = (p, o = {}) => `<article class="m-hcard">${ph(p.g, p.il)}<div><div class="m-cat">${p.c}</div><h3>${p.t}</h3><div class="m-meta"><span>${p.a}</span><span class="m-dot"></span><span>${p.d}</span></div></div></article>`;
  const sec = (t, link = 'View all →') => `<div class="m-sec"><h2>${t}</h2>${link ? `<a>${link}</a>` : ''}</div>`;
  const newsList = (n = 6, thumbs = true) => `<ul class="m-news${thumbs ? '' : ' nt'}">${NEWS.slice(0, n).map((x) => `<li>${thumbs ? ph(x.g, x.il) : ''}<div><div class="m-meta"><span class="m-kind">${x.k}</span><span class="m-dot"></span><span>${x.d}</span></div><h4>${x.t}</h4></div></li>`).join('')}</ul>`;
  const nlBand = () => `<div class="m-nl m-block"><div><h3>New projects in your inbox</h3><p>One email a week with the newest builds and tutorials. No spam.</p></div><div class="m-form"><span class="m-input">you@example.com</span><span class="m-btn">Subscribe</span></div></div>`;
  const nlBox = () => `<div class="m-box m-nlbox"><h3>Get new projects by email</h3><p>One email a week. Unsubscribe any time.</p><span class="m-input">you@example.com</span><span class="m-btn">Subscribe</span></div>`;
  const footer = () => `<footer class="m-foot"><div class="m-in"><div>${logo()}<span>Step-by-step ESP32, Arduino and IoT projects, tested on real hardware.</span></div>
    <div><b>Projects</b><span>ESP32</span><span>ESP32-CAM</span><span>Arduino</span><span>IoT</span></div>
    <div><b>Learn</b><span>Tutorials</span><span>News</span><span>Videos</span></div>
    <div><b>About</b><span>About us</span><span>Contact</span><span>Privacy</span><span>RSS feed</span></div>
    <div class="m-copy">© 2026 IoT Studio Blog</div></div></footer>`;

  // Home A: magazine, closest to CircuitDigest.
  function homeA(pk) {
    const lead = P[0];
    return `${header(pk.header)}<div class="m-in hA">
      <section class="m-block">${sec("Editor's Choice")}<div class="m-ec">
        <article class="m-lead">${ph(lead.g, lead.il)}<div class="m-cat">${lead.c}</div><h3>${lead.t}</h3><p>${lead.x}</p><div class="m-meta">${av(lead.a)}<span>${lead.a}</span><span class="m-dot"></span><span>${lead.d}</span></div></article>
        <div class="m-ec-side">${hcard(P[1])}${hcard(P[3])}${hcard(P[7])}</div></div></section>
      <section class="m-block m-split"><div>${sec('Latest Projects')}<div class="m-grid2">${[P[4], P[5], P[2], P[6]].map((p) => card(p, { ex: true })).join('')}</div></div>
        <aside class="m-box">${sec('Latest News', 'All news →')}${newsList(6)}</aside></section>
      <section class="m-block">${sec('Tutorials')}<div class="m-grid4">${[P[6], P[2], P[11], P[10]].map((p) => card(p)).join('')}</div></section>
      <section class="m-block">${sec('Videos')}<div class="m-grid4">${[P[1], P[0], P[3], P[4]].map((p, i) => card(p, { video: ['6:42', '12:08', '8:15', '9:51'][i] })).join('')}</div></section>
      ${nlBand()}</div>${footer()}`;
  }

  // Home B: three-column newsroom.
  function homeB(pk) {
    const lead = P[0];
    return `${header(pk.header)}<div class="m-in hB">
      <section class="m-block m-top3">
        <aside>${sec('Latest News', 'All →')}<ul class="m-tl">${NEWS.map((x) => `<li><time>${x.time}</time> <span class="m-kind">${x.k}</span><h4>${x.t}</h4></li>`).join('')}</ul></aside>
        <div><article class="m-lead">${ph(lead.g, lead.il)}<div class="m-cat">${lead.c}</div><h3>${lead.t}</h3><p>${lead.x}</p><div class="m-meta">${av(lead.a)}<span>${lead.a}</span><span class="m-dot"></span><span>${lead.d}</span></div></article>
          <div class="m-grid2" style="margin-top:28px">${card(P[1])}${card(P[3])}</div></div>
        <aside>${sec("Editor's Choice", '')}<div style="margin-bottom:16px">${ph(P[7].g, P[7].il)}</div><ol class="m-rank">${[P[7], P[4], P[5], P[8], P[9]].map((p) => `<li><div><h4>${p.t}</h4><div class="m-meta"><span>${p.c}</span><span class="m-dot"></span><span>${p.d}</span></div></div></li>`).join('')}</ol></aside>
      </section>
      <section class="m-block"><div class="m-tabs"><span class="on">Projects</span><span>Tutorials</span><span>ESP32</span><span>Arduino</span><span>IoT</span><span>Videos</span></div>
        <div class="m-grid4">${[P[4], P[5], P[2], P[6]].map((p) => card(p, { ex: true })).join('')}</div></section>
      <section class="m-block">${sec('Tutorials')}<div class="m-grid4">${[P[6], P[2], P[11], P[10]].map((p) => card(p)).join('')}</div></section>
      ${nlBand()}</div>${footer()}`;
  }

  // Home C: big story with a sidebar.
  function homeC(pk) {
    const lead = P[0];
    return `${header(pk.header)}<div class="m-in hC">
      <section class="m-block m-hero"><article class="m-big">${ph(lead.g, lead.il)}<div class="m-ov"><span class="m-pill">${lead.c}</span><h3>${lead.t}</h3><p>${lead.x}</p><div class="m-meta"><span>${lead.a}</span><span class="m-dot"></span><span>${lead.d}</span></div></div></article>
        <aside class="m-box">${sec("Editor's Choice", '')}<div class="m-ecl">${[P[1], P[3], P[7], P[5]].map((p) => hcard(p)).join('')}</div></aside></section>
      <section class="m-block m-body"><div>${sec('Latest')}<div class="m-rows">${[P[4], P[2], P[6], P[8], P[9]].map((p) => `<article class="m-rowc">${ph(p.g, p.il)}<div><div class="m-cat">${p.c}</div><h3>${p.t}</h3><p>${p.x}</p><div class="m-meta">${av(p.a)}<span>${p.a}</span><span class="m-dot"></span><span>${p.d}</span></div></div></article>`).join('')}</div></div>
        <aside class="m-side"><div class="m-box">${sec('News', 'All →')}${newsList(5, false)}</div>
          <div class="m-box">${sec('Most read', '')}<ol class="m-rank">${[P[0], P[2], P[1], P[3]].map((p) => `<li><div><h4>${p.t}</h4></div></li>`).join('')}</ol></div>
          ${nlBox()}
          <div class="m-box"><h3>Topics</h3><ul class="m-topics"><li>ESP32 <span>48</span></li><li>Arduino <span>31</span></li><li>ESP32-CAM <span>12</span></li><li>Sensors <span>27</span></li><li>IoT <span>22</span></li><li>Tutorials <span>40</span></li></ul></div></aside></section>
      ${nlBand()}</div>${footer()}`;
  }

  Object.assign(PK, { esc, ic, brand, play, av, ph, mk, logo, header, card, hcard, sec, newsList, nlBand, nlBox, footer, homeA, homeB, homeC, initials });
})();
