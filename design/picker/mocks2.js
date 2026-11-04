// Preview renderers, part 2: article pages and their parts.
(function () {
  const { esc, ic, brand, av, ph, header, card, sec, newsList, nlBox, footer, P, TROWS, FILES, SNIP, CODE_MAIN, CODE_CFG } = PK;

  function hl(src) {
    const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|(#\s*(?:include|define))|\b(const|int|long|float|void|return|if|else|while|for|bool|true|false|HIGH|LOW|OUTPUT|INPUT)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\s*\()/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      const c = m[1] ? 'tc' : m[2] ? 'ts' : m[3] ? 'tp' : m[4] ? 'tk' : m[5] ? 'tn' : 'tf';
      out += `<span class="${c}">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  const lines = (src, max, nums = true) => hl(src).split('\n').slice(0, max || undefined)
    .map((l, i) => `<span class="ln">${nums ? `<i>${i + 1}</i>` : ''}${l || ' '}</span>`).join('');

  const ART = {
    title: 'ESP32 Water Tank Level Monitor With Alarm',
    quick: 'An HC-SR04 ultrasonic sensor on the tank lid measures the distance to the water. The ESP32 turns it into a percentage, shows it on your phone, and sounds a buzzer when the level drops below 15%.',
  };
  const TOC = ['Components required', 'How it works', 'FAQ', 'Source code', 'Downloads'];
  const crumbs = () => `<div class="m-crumb"><a>Home</a><span>›</span><a>ESP32 Projects</a></div>`;
  const byline = () => `<div class="m-byline">${av('Arun Kumar')}<div><b>Arun Kumar</b><br><span>Updated 22 Oct 2026 · 9 min read</span></div></div>`;
  const tocBox = () => `<nav class="m-toc"><b>On this page</b><ol>${TOC.map((t) => `<li>${t}</li>`).join('')}</ol></nav>`;
  const hero = () => `<figure class="m-hero-img" style="margin:0">${ph(1, 'sonar')}</figure>`;

  // Share buttons.
  const SHARE = [['whatsapp', 'WhatsApp', '#25D366'], ['x', 'X', '#0F1419'], ['linkedin', 'LinkedIn', '#0A66C2'], ['facebook', 'Facebook', '#1877F2']];
  function share(s, o = {}) {
    if (s === 's3') {
      const menu = o.open ? `<div class="m-menu">${SHARE.map(([k, l, c]) => `<span style="--brand:${c}">${brand(k, 17)} ${l}</span>`).join('')}<span>${ic('link', 17)} Copy link</span></div>` : '';
      return `<div class="m-sh3"><span class="m-btn alt sm">${ic('share', 16)} Share</span>${menu}</div>`;
    }
    const size = s === 's4' ? 19 : 17;
    const items = SHARE.map(([k, l, c], i) => `<span class="m-shb${o.hover && i === 0 ? ' hov' : ''}" style="--brand:${c}" title="${l}">${brand(k, size)}</span>`).join('')
      + `<span class="m-shb lk" title="Copy link">${ic('link', size)}</span>`;
    return `<div class="m-sh ${s}${o.vertical ? ' m-v' : ''}">${s === 's4' ? '<span class="m-shl">Share</span>' : ''}${items}</div>`;
  }

  // Tables.
  const table = (t) => `<div class="m-tw"><table class="m-t ${t}"><thead><tr><th>Component</th><th class="num">Qty</th><th>Notes</th></tr></thead><tbody>${TROWS.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table></div>`;

  // Short code snippet inside the article text.
  function snippet(pk) {
    const dk = pk.code === 'c2' ? ' m-dk' : '';
    const plain = pk.syntax === 'plain' ? ' m-plain' : '';
    return `<div class="m-snip${dk}${plain}"><span class="m-snip-l">C++ ${ic('copy', 15)}</span><pre class="m-code">${lines(SNIP, 0, false)}</pre></div>`;
  }

  // Full source code box (after the FAQ, above Downloads).
  function codeBox(v, syntax) {
    const plain = syntax === 'plain' ? ' m-plain' : '';
    if (v === 'c2') {
      return `<section class="c2"><h2 class="m-blk-t">Source code</h2><div class="m-ide m-dk${plain}">
        <div class="m-ide-top"><div class="m-ide-tabs"><span class="on">main.ino</span><span>config.h</span></div><div class="m-ide-act"><span>${ic('copy', 15)} Copy</span><span>${ic('dl', 15)} Download</span><span>${brand('github', 15)} GitHub</span></div></div>
        <pre class="m-code">${lines(CODE_MAIN, 20)}</pre>
        <div class="m-ide-status"><span>C++ · Arduino</span><span>44 lines · 1.3 KB · Show all</span></div></div></section>`;
    }
    if (v === 'c3') {
      return `<section class="c3"><div class="m-blk-h"><h2>Source code</h2><span class="m-btn gh sm">${brand('github', 15)} View on GitHub</span></div>
        <div class="m-files${plain}">
          <div class="m-file open"><div class="m-file-h">${ic('down', 18)}<b>main.ino</b><small>C++ · 44 lines</small><span class="m-fa"><span>${ic('copy', 16)}</span><span>${ic('dl', 16)}</span></span></div><pre class="m-code">${lines(CODE_MAIN, 14)}</pre></div>
          <div class="m-file"><div class="m-file-h">${ic('down', 18)}<b>config.h</b><small>C++ · 7 lines</small><span class="m-fa"><span>${ic('copy', 16)}</span><span>${ic('dl', 16)}</span></span></div></div>
          <div class="m-file"><div class="m-file-h">${ic('down', 18)}<b>dashboard.html</b><small>HTML · 38 lines</small><span class="m-fa"><span>${ic('copy', 16)}</span><span>${ic('dl', 16)}</span></span></div></div>
        </div><div class="m-foot-acts"><span class="m-btn sm">${ic('dl', 15)} Download all files (.zip)</span></div></section>`;
    }
    return `<section class="c1${plain}"><div class="m-blk-h"><h2>Source code</h2><div class="m-acts"><span class="m-btn alt sm">${ic('copy', 15)} Copy</span><span class="m-btn alt sm">${ic('dl', 15)} Download .zip</span><span class="m-btn gh sm">${brand('github', 15)} View on GitHub</span></div></div>
      <div class="m-tabs2"><span class="on">main.ino</span><span>config.h</span><span>dashboard.html</span></div>
      <pre class="m-code">${lines(CODE_MAIN, 16)}</pre><div class="m-more">Show all 44 lines</div></section>`;
  }

  // Downloads and GitHub.
  function downloads(v) {
    if (v === 'd2') {
      return `<section class="d2"><h2 class="m-blk-t">Downloads</h2><div class="m-brow">
        <span class="m-bigbtn gh">${brand('github', 24)}<span><b>View on GitHub</b><small>Code and wiring</small></span></span>
        <span class="m-bigbtn ac">${ic('cube', 24)}<span><b>Download STL files</b><small>2 files · 2.0 MB</small></span></span>
        <span class="m-bigbtn ol">${ic('pdf', 24)}<span><b>Circuit diagram</b><small>PDF · 380 KB</small></span></span></div></section>`;
    }
    if (v === 'd3') {
      return `<section class="d3"><div class="m-tbx"><div class="m-blk-h"><h2>Downloads</h2><span class="m-btn gh sm">${brand('github', 15)} GitHub repository</span></div>
        ${FILES.map((f) => `<div class="m-trow"><span class="m-badge">${f.t}</span><b>${f.n}</b><span class="m-sz">${f.s}</span><span class="m-icb">${ic('dl', 17)}</span></div>`).join('')}
        <div class="m-trow"><span class="m-badge">ZIP</span><b>All files</b><span class="m-sz">2.4 MB</span><span class="m-icb">${ic('dl', 17)}</span></div></div></section>`;
    }
    return `<section class="d1"><h2 class="m-blk-t">Downloads</h2>
      <div class="m-ghcard">${brand('github', 30)}<div><b>esp32-tank-level-monitor</b><small>Full code, wiring diagram and 3D files</small></div><span class="m-btn light sm">View on GitHub ${ic('ext', 15)}</span></div>
      <div class="m-flist">${FILES.map((f) => `<div class="m-fcard"><span class="m-fic ${f.i}">${ic(f.i, 22)}</span><div><b>${f.n}</b><small>${f.t} · ${f.s}</small></div><span class="m-btn alt sm">${ic('dl', 15)} Download</span></div>`).join('')}</div></section>`;
  }

  // Comments (readers sign in to comment).
  const cmt = (n, t, txt, likes, author) => `<div class="m-c">${av(n)}<div><div class="m-c-h"><b>${n}</b>${author ? '<span class="m-auth">Author</span>' : ''}<span>${t}</span></div><p>${txt}</p><div class="m-c-a"><span>${PK.ic('reply', 15)} Reply</span><span>${PK.ic('heart', 15)} ${likes}</span></div></div></div>`;
  const THREAD = () => cmt('Priya S', '2 days ago', 'Worked first time. I had to raise the sensor by 3 cm because my overflow pipe sits close to the top.', 4)
    + `<div class="m-reply">${cmt('Arun Kumar', '1 day ago', 'Thanks Priya, good tip. I’ll add it to the troubleshooting part.', 2, true)}</div>`
    + cmt('Rahul M', '5 hours ago', 'Could this run from an 18650 cell? How long would it last?', 1);
  function comments(v) {
    if (v === 'cm2') {
      return `<section class="cm2"><div class="m-cm-h"><h2>Comments (3)</h2><span>Newest first ${ic('down', 14)}</span></div>
        <div class="m-compose">${av('You Reader')}<div class="m-ta">Write a comment…</div><div class="m-compose-f"><span>Be kind and stay on topic.</span><span class="m-btn sm">Post comment</span></div></div>
        <p class="m-who">Commenting as <b>You Reader</b> · Sign out</p>${THREAD()}</section>`;
    }
    return `<section class="cm1"><div class="m-cm-h"><h2>3 comments</h2><span>Newest first ${ic('down', 14)}</span></div>
      <div class="m-gate"><div><b>Join the discussion</b><p>Create a free account or sign in to comment and reply.</p></div><div><span class="m-btn">Create account</span><span class="m-btn alt">Sign in</span></div></div>
      ${THREAD()}</section>`;
  }

  const authorBox = () => `<div class="m-authorbox">${av('Arun Kumar')}<div><b>Arun Kumar</b><span class="m-role">Embedded engineer</span><p>Builds ESP32 and sensor projects and tests each one on real hardware before it goes up.</p></div></div>`;
  const tags = () => `<div class="m-tags"><b>Tags</b><a>ESP32</a><a>Ultrasonic sensor</a><a>Water level</a><a>Alarm</a></div>`;
  const related = () => `<section class="m-rel">${sec('Related projects', '')}<div class="m-grid3">${[P[3], P[4], P[7]].map((p) => card(p)).join('')}</div></section>`;

  function prose(pk, withToc) {
    return `<div class="m-prose"><div class="m-qa"><b>Quick answer</b><p>${ART.quick}</p></div>${withToc ? tocBox() : ''}
      <p>Running out of water at night is the kind of problem you only notice when it is too late. This build puts an ultrasonic sensor on the tank lid and lets an ESP32 do the watching. You get the level on your phone, and a loud buzzer when it drops below 15%. See the <a>wiring guide</a> if you are new to the HC-SR04.</p>
      <h2>Components required</h2>${table(pk.table)}
      <h2>How it works</h2><p>The HC-SR04 sends a short pulse of sound and times the echo. Half that time, multiplied by the speed of sound, is the distance to the water. The sketch turns the distance into a percentage of your tank's height:</p>
      ${snippet(pk)}<p>Every two seconds the ESP32 takes a new reading and serves it to a small dashboard page on your home network.</p>
      <h2>FAQ</h2><h3>Can I use a waterproof sensor instead?</h3><p>Yes. The JSN-SR04T uses the same trigger and echo pins, so the code works unchanged.</p>
      <h3>Why does the reading jump around?</h3><p>Ripples and the inlet pipe can reflect the pulse. Mount the sensor away from the inlet and average five readings.</p></div>`;
  }
  const after = (pk) => `<div class="m-after">${codeBox(pk.code, pk.syntax)}${downloads(pk.downloads)}${tags()}${authorBox()}${comments(pk.comments)}</div>`;

  // Article A: classic with a right sidebar.
  function articleA(pk) {
    return `${header(pk.header)}<div class="m-art pA"><div class="m-in" style="padding-top:30px">
      ${crumbs()}<h1 style="margin:14px 0 22px;max-width:920px">${ART.title}</h1>
      <div class="m-bl-row">${byline()}${share(pk.share)}</div>
      <div class="m-grid"><div>${hero()}<div style="margin-top:32px">${prose(pk, false)}${after(pk)}</div></div>
        <aside class="m-side">${tocBox()}<div class="m-box">${sec('Latest News', '')}${newsList(4)}</div>${nlBox()}</aside></div>
      ${related()}</div></div>${footer()}`;
  }

  // Article B: centred reading column with a share rail.
  function articleB(pk) {
    return `${header(pk.header)}<div class="m-art pB"><div class="m-in" style="padding-top:36px">
      <div class="m-col">${crumbs()}<h1>${ART.title}</h1>${byline()}</div>
      ${hero()}
      <div class="m-body"><div class="m-rail">${share(pk.share, { vertical: true })}</div><div>${prose(pk, true)}${after(pk)}</div><div></div></div>
      ${related()}</div></div>${footer()}`;
  }

  // Article C: picture first, contents on the left.
  function articleC(pk) {
    return `${header(pk.header)}<div class="m-art pC"><div class="m-big">${ph(1, 'sonar')}<div class="m-ov"><div class="m-in">${crumbs()}<h1>${ART.title}</h1>${byline()}</div></div></div>
      <div class="m-in"><div class="m-grid"><aside class="m-lrail">${tocBox()}<div><span class="m-lbl">Share</span>${share(pk.share === 's3' ? 's1' : pk.share)}</div></aside>
        <div>${prose(pk, false)}${after(pk)}</div></div>${related()}</div></div>${footer()}`;
  }

  // Small context mocks for the component sections.
  const shareDemo = (s) => `<div class="sh-demo m-art">${crumbs()}<h1>${ART.title}</h1><div class="m-bl-row">${byline()}${share(s, { open: true, hover: true })}</div><div style="height:${s === 's3' ? 190 : 20}px"></div></div>`;
  const cmpDemo = (html) => `<div class="cmp-demo">${html}</div>`;

  Object.assign(PK, { hl, lines, ART, share, table, codeBox, downloads, comments, articleA, articleB, articleC, shareDemo, cmpDemo, tocBox });
})();
