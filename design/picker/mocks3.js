// Preview renderers, part 3: theme and font cards, header samples, admin and editor.
(function () {
  const { ic, brand, av, ph, logo, header, lines, SNIP, ART, P, table } = PK;

  function themeVars(t, mode) {
    const v = { ...t[mode] };
    v.acOnDark = t.dark.acText;
    v.deco = v.deco || v.acText;
    v.bar = v.bar || v.ac;
    v.markBg = v.markBg || v.ac;
    v.markInk = v.markInk || v.acInk;
    Object.assign(v, mode === 'dark' ? PK.SX_DARK : PK.SX_LIGHT);
    return Object.entries(v).map(([k, x]) => `--${k}:${x}`).join(';');
  }
  const fontVars = (f) => `--fh:${f.fh};--fb:${f.fb};--fm:${f.fm};--hw:${f.hw}`;

  function themeCard(t, mode, font) {
    const body = `<header class="m-h1 sm"><div class="m-in m-row" style="padding:0 24px">${logo()}<nav class="m-nav"><span class="on">Projects</span><span>Tutorials</span><span>News</span></nav><div class="m-tools"><span class="m-btn sm">Subscribe</span></div></div></header>
      <div class="thm-body"><div>${ph(1, 'sonar')}<div class="m-cat" style="margin-top:12px">ESP32 Projects</div><h3 class="thm-t">${ART.title}</h3><p class="thm-p">Get a phone alert before the tank runs dry. <a class="m-a">Read the guide</a></p></div>
        <div class="thm-side"><div class="m-qa sm"><b>Quick answer</b><p>An ultrasonic sensor measures the distance to the water.</p></div>
          <pre class="m-code">${lines(SNIP, 3, false)}</pre>
          <div class="thm-btns"><span class="m-btn sm">${ic('dl', 14)} Download STL</span><span class="m-btn gh sm">${brand('github', 14)} GitHub</span></div></div></div>`;
    return PK.mk(body, 640, `${themeVars(t, mode)};${fontVars(font)}`);
  }

  function fontCard(f) {
    const body = `<div class="fnt"><div class="m-cat">ESP32 Projects</div><h1>${ART.title}</h1>
      <p>The HC-SR04 sends a short pulse of sound and times the echo. Half that time, multiplied by the speed of sound, is the distance to the water.</p>
      <pre class="m-code">${lines(SNIP, 2, false)}</pre><div class="m-glyph">Aa Bb Gg 0123456789 · I l 1 | O 0</div></div>`;
    return PK.mk(body, 640, fontVars(f));
  }

  const headerSample = (v) => `${header(v, { menu: true })}<div class="m-under"></div>`;

  // Admin, laid out like Ghost.
  const ROWS = [
    ['ESP32 Water Tank Level Monitor With Alarm', 'Arun Kumar', 'ESP32 Projects', '2 hours ago', 'pub', 'Published', '1,284'],
    ['ESP32-CAM Motion Alert That Sends a Photo', 'Meena R', 'ESP32-CAM', 'Yesterday', 'pub', 'Published', '3,906'],
    ['Smart Plant Watering With a Soil Moisture Sensor', 'Karthik S', 'IoT', 'Saved 10 min ago', 'draft', 'Draft', '—'],
    ['Build a Wi-Fi Weather Station That Logs to the Cloud', 'Karthik S', 'IoT', 'Goes live 5 Nov, 9:00', 'sch', 'Scheduled', '—'],
    ['Control an LED From Your Phone With ESP32', 'Arun Kumar', 'Tutorials', '18 Oct 2026', 'pub', 'Published', '8,420'],
    ['DHT22 Climate Monitor With an OLED Display', 'Meena R', 'ESP32 Projects', '15 Oct 2026', 'pub', 'Published', '2,117'],
    ['Read Any I2C Sensor on ESP32: A Beginner Guide', 'Arun Kumar', 'Tutorials', '6 Oct 2026', 'pub', 'Published', '5,032'],
  ];
  function adminMock(v) {
    const nav = [['home', 'Dashboard'], ['ext', 'View site'], null, ['pen', 'Posts', 'on'], ['', 'Drafts', 'sub', '3'], ['', 'Scheduled', 'sub', '1'], ['', 'Published', 'sub'],
      ['file', 'Pages'], ['tag', 'Tags'], ['img', 'Media'], null, ['users', 'Members', '', '214'], ['msg', 'Comments', '', '5 new']];
    const navHtml = nav.map((n) => n ? `<span class="${n[2] || ''}">${n[0] ? ic(n[0], 18) : ''}${n[1]}${n[3] ? `<em>${n[3]}</em>` : ''}</span>` : '<div class="ad-gap"></div>').join('');
    return `<div class="m-adm ${v}"><aside class="ad-side"><div class="ad-brand"><span class="m-mark">${ic('chip', 16)}</span>IoT Studio Blog</div><nav class="ad-nav">${navHtml}</nav>
      <div class="ad-foot">${av('Arun Kumar')}<span>Arun Kumar</span>${ic('gear', 18)}</div></aside>
      <main class="ad-main"><div class="ad-top"><h1>Posts</h1><div class="ad-filters"><span>All posts ${ic('down', 13)}</span><span>All authors ${ic('down', 13)}</span><span>All tags ${ic('down', 13)}</span><span>Newest first ${ic('down', 13)}</span></div><span class="ad-new">New post</span></div>
        ${ROWS.map((r) => `<div class="ad-row"><div><b>${r[0]}</b><small>By ${r[1]} in ${r[2]} · ${r[3]}</small></div><span class="ad-st ${r[4]}">${r[5]}</span><span class="ad-views">${r[6] === '—' ? '—' : r[6] + ' views'}</span></div>`).join('')}</main></div>`;
  }

  // Post editor.
  function editorMock(v) {
    const top = `<div class="ed-top"><span class="ed-back">${ic('left', 18)} Posts</span><span class="ed-state">Draft · Saved</span>
      ${v === 'e3' ? '<div class="ed-switch"><span class="on">Visual</span><span>Markdown</span></div>' : ''}
      <div class="ed-r"><span>Preview</span><span class="ed-pub">Publish</span>${ic('panel', 20)}</div></div>`;
    const tb = `<div class="ed-tb"><span><b>B</b></span><span><i>I</i></span><i></i><span>H2</span><span>H3</span><i></i><span>${ic('link', 15)}</span><span>${ic('quote', 15)}</span><span>${ic('list', 15)}</span><i></i><span>${ic('code', 15)}</span><span>${ic('table', 15)}</span><span>${ic('img', 15)}</span><span>${ic('video', 15)}</span></div>`;
    if (v === 'e2') {
      const md = `Running out of water at night is the kind of problem you only notice when it is too late. This build puts an ultrasonic sensor on the tank lid...

## Components required

| Component                 | Qty | Notes                         |
| ------------------------- | --: | ----------------------------- |
| ESP32 DevKit V1           |   1 | Any ESP32-WROOM-32 board      |
| HC-SR04 ultrasonic sensor |   1 | Mount 5 cm above the overflow |
| Active buzzer, 5 V        |   1 | Switched by the transistor    |

## How it works

The HC-SR04 sends a short pulse of sound and times the echo...`;
      return `<div class="m-ed">${top}${tb}<div class="ed-split"><div class="ed-md"><div class="ed-title">${ART.title}</div><pre>${PK.esc(md)}</pre></div>
        <div class="ed-pv"><h1>${ART.title}</h1><div class="m-prose"><p>Running out of water at night is the kind of problem you only notice when it is too late. This build puts an ultrasonic sensor on the tank lid…</p><h2>Components required</h2>${table('t1')}</div></div></div></div>`;
    }
    const canvas = `<div class="ed-canvas"><div class="ed-col"><span class="ed-add">${ic('img', 17)} Add feature image</span><h1>${ART.title}</h1>
      <p>Running out of water at night is the kind of problem you only notice when it is too late. This build puts an ultrasonic sensor on the tank lid and lets an ESP32 do the watching.</p>
      <h2>Components required</h2>
      <div class="ed-tw"><div class="ed-ttools"><span>${ic('plus', 14)} Row</span><span>${ic('plus', 14)} Column</span><span>${ic('minus', 14)} Delete row</span><span>Align</span></div>
        <table class="ed-t"><thead><tr><th>Component</th><th>Qty</th><th>Notes</th></tr></thead><tbody>
          <tr><td>ESP32 DevKit V1</td><td>1</td><td>Any ESP32-WROOM-32 board</td></tr>
          <tr><td>HC-SR04 ultrasonic sensor</td><td class="sel">1</td><td>Mount 5 cm above the overflow</td></tr>
          <tr><td>Active buzzer, 5 V</td><td>1</td><td>Switched by the transistor</td></tr></tbody></table></div>
      <div class="ed-plus"><span class="ed-pbtn">${ic('plus', 18)}</span><div class="ed-cards">${[['img', 'Image'], ['table', 'Table'], ['code', 'Code block'], ['info', 'Callout box'], ['video', 'YouTube video'], ['dl', 'File download'], ['minus', 'Divider']].map(([i, n]) => `<div><i>${ic(i, 16)}</i>${n}</div>`).join('')}</div></div></div></div>`;
    const drawer = v === 'e1' ? `<aside class="ed-drawer"><h3>Post settings</h3>
      <div class="ed-f"><b>Post URL</b><div class="ed-in">/esp32-water-tank-level-monitor/</div></div>
      <div class="ed-f"><b>Publish date</b><div class="ed-in">22 Oct 2026 · 09:00</div></div>
      <div class="ed-f"><b>Category</b><div class="ed-in">ESP32 Projects</div></div>
      <div class="ed-f"><b>Tags</b><div class="ed-in">ESP32, Ultrasonic sensor, Alarm</div></div>
      <div class="ed-f"><b>Meta description</b><div class="ed-in tall">Measure your tank level with an HC-SR04 and an ESP32, and get an alarm before it runs dry.</div></div>
      <div class="ed-f"><b>Quick answer</b><div class="ed-in tall">An HC-SR04 on the tank lid measures the distance…</div></div></aside>` : '';
    return `<div class="m-ed">${top}${v === 'e3' ? tb : ''}<div class="ed-body">${canvas}${drawer}</div></div>`;
  }

  Object.assign(PK, { themeVars, fontVars, themeCard, fontCard, headerSample, adminMock, editorMock });
})();
