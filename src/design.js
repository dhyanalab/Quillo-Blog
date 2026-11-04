// The design catalogue: every choice on Admin > Design, from the design picker (design/picker/). Each group has its options,
// in plain words for the owner; `ready` marks the groups the site can already show. The defaults are the look the blog
// had before the Design page existed, so a blog only changes when its owner picks something.

// Colour themes. Copper & Slate is the stylesheet's own default (assets/css/tokens.css); the others replace its colours.
// Values come from the picker; the shades it didn't define (a third surface, a stronger line, the hover accent, the code box)
// are worked out from them in themeCss().
export const PALETTES = {
  blue: {
    light: { bg: "#F6F8FB", sf: "#FFFFFF", sf2: "#EEF2F7", ink: "#0F172A", ink2: "#475569", ink3: "#5B6B80", line: "#E2E8F0", ac: "#2563EB", acInk: "#FFFFFF", acText: "#1D4ED8", acSoft: "#E8EFFE", hi: "#F59E0B", hiText: "#92400E", hiSoft: "#FEF3C7" },
    dark: { bg: "#0B1120", sf: "#111A2E", sf2: "#17223A", ink: "#E5ECF6", ink2: "#A3B1C6", ink3: "#8291A8", line: "#22304D", ac: "#2563EB", acInk: "#FFFFFF", acText: "#8AB4FF", acSoft: "#15254A", hi: "#FBBF24", hiText: "#FCD34D", hiSoft: "#3A2E0F", codeBg: "#070C18", codeInk: "#E2E8F0" },
  },
  green: {
    light: { bg: "#F4F7F5", sf: "#FFFFFF", sf2: "#EAF1ED", ink: "#0D1B14", ink2: "#46594F", ink3: "#5C6F65", line: "#D9E3DD", ac: "#047857", acInk: "#FFFFFF", acText: "#05704F", acSoft: "#E1F2EA", hi: "#D4A017", hiText: "#7A5200", hiSoft: "#FAF0D2" },
    dark: { bg: "#07120D", sf: "#0E1C15", sf2: "#14261D", ink: "#E2EFE8", ink2: "#9BB3A6", ink3: "#809A8D", line: "#1F3529", ac: "#047857", acInk: "#FFFFFF", acText: "#5EE0A6", acSoft: "#123325", hi: "#E3B341", hiText: "#F2C94C", hiSoft: "#33290C", codeBg: "#040B08", codeInk: "#DCEFE4" },
  },
  teal: {
    light: { bg: "#F2F7F7", sf: "#FFFFFF", sf2: "#E6EFF0", ink: "#0A1E22", ink2: "#435C5E", ink3: "#587073", line: "#D4E2E3", ac: "#0F766E", acInk: "#FFFFFF", acText: "#0D6B64", acSoft: "#DDF1EE", hi: "#CA8A04", hiText: "#7C4A03", hiSoft: "#FDF5D6" },
    dark: { bg: "#061416", sf: "#0C1E21", sf2: "#12292D", ink: "#DDEFEF", ink2: "#97B3B4", ink3: "#7D9A9B", line: "#1A3539", ac: "#0F766E", acInk: "#FFFFFF", acText: "#4FDCC9", acSoft: "#0F2F2E", hi: "#FACC15", hiText: "#FDE047", hiSoft: "#332B07", codeBg: "#030C0D", codeInk: "#D7F0EE" },
  },
  red: {
    light: { bg: "#F6F6F7", sf: "#FFFFFF", sf2: "#EFEFF1", ink: "#121316", ink2: "#4E5158", ink3: "#65686F", line: "#E3E3E6", ac: "#DC2626", acInk: "#FFFFFF", acText: "#C01C1C", acSoft: "#FDECEC", hi: "#2563EB", hiText: "#1D4ED8", hiSoft: "#E8EFFE" },
    dark: { bg: "#0E0F11", sf: "#17181B", sf2: "#1F2024", ink: "#EDEDEF", ink2: "#A9ABB2", ink3: "#8B8D95", line: "#2A2B30", ac: "#DC2626", acInk: "#FFFFFF", acText: "#FF8080", acSoft: "#3A1517", hi: "#60A5FA", hiText: "#93C5FD", hiSoft: "#14254A", codeBg: "#09090B", codeInk: "#ECECEE" },
  },
  graphite: {
    light: { bg: "#F5F5F4", sf: "#FFFFFF", sf2: "#EEEEEC", ink: "#18181B", ink2: "#52525B", ink3: "#66666E", line: "#E2E2DF", ac: "#18181B", acInk: "#FFFFFF", acText: "#18181B", acSoft: "#FEF7C3", hi: "#FACC15", hiText: "#713F12", hiSoft: "#FEF7C3" },
    dark: { bg: "#0F0F10", sf: "#18181B", sf2: "#222226", ink: "#F4F4F5", ink2: "#A1A1AA", ink3: "#8B8B94", line: "#2C2C31", ac: "#FACC15", acInk: "#18181B", acText: "#FDE047", acSoft: "#2E2A0C", hi: "#FACC15", hiText: "#FDE047", hiSoft: "#2E2A0C", codeBg: "#09090B", codeInk: "#F4F4F5" },
  },
};

// Font pairs: headings, body text and code. Every family is self-hosted (src/render/fonts.js).
// `body` is everything else (menus, buttons, cards); `text`, when set, is the long reading text of articles and pages.
// Inter's alternate letter shapes (`features`) are only asked for where Inter is the body font.
export const FONT_PAIRS = {
  inter: { head: "Inter", body: "Inter", mono: "JetBrains Mono", features: true },
  plex: { head: "IBM Plex Sans", body: "IBM Plex Sans", mono: "IBM Plex Mono" },
  jakarta: { head: "Plus Jakarta Sans", body: "Inter", mono: "JetBrains Mono", features: true },
  manrope: { head: "Manrope", body: "Manrope", text: "Source Serif 4", mono: "JetBrains Mono" },
  outfit: { head: "Outfit", body: "Nunito", mono: "JetBrains Mono" },
};
const SANS = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const SERIF = 'Georgia,"Times New Roman",serif';
const MONO = 'ui-monospace,"SFMono-Regular",Consolas,monospace';
const stack = (family) => `"${family}",${family.includes("Serif") ? SERIF : family.includes("Mono") ? MONO : SANS}`;

// `section` groups the choices on the page. `markup` marks groups that change the page's HTML (the preview reloads for them;
// the others are switched on <html> at once). `page` is the preview page that shows the group best ("home", "post", or
// "admin" for the admin itself). Admin look and Editor are each staff member's tools, so templates leave them alone.
export const DESIGN_SECTIONS = [
  { key: "look", label: "Colours and type" },
  { key: "layout", label: "Page layouts" },
  { key: "parts", label: "Article parts" },
  { key: "admin", label: "Admin" },
];

export const DESIGN_GROUPS = [
  {
    key: "palette", label: "Colours", section: "look", ready: true,
    options: [
      { id: "copper", name: "Copper & Slate", desc: "Cool slate greys with a warm copper accent and teal as the second colour. Calm and modern." },
      { id: "blue", name: "Classic Blue", desc: "White pages, a confident blue for links and buttons, and amber highlights. Clear and trustworthy." },
      { id: "green", name: "Forest Green", desc: "Deep green with gold accents. Natural and distinctive." },
      { id: "teal", name: "Ocean Teal", desc: "Deep teal with a bright yellow highlight. Fresh and lively." },
      { id: "red", name: "Signal Red", desc: "Charcoal and white with a sharp red accent and blue links. Punchy, like a newsroom." },
      { id: "graphite", name: "Graphite & Yellow", desc: "Black, white and bold yellow. High contrast and confident." },
    ],
  },
  {
    key: "fonts", label: "Fonts", section: "look", ready: true,
    options: [
      { id: "inter", name: "Inter + JetBrains Mono", desc: "The neutral choice: clean and easy to read, so your pictures and colours lead." },
      { id: "plex", name: "IBM Plex Sans + Plex Mono", desc: "Calm and precise, made for documentation, with a matching code font." },
      { id: "jakarta", name: "Plus Jakarta Sans + Inter", desc: "Rounder, friendlier headings with a crisp body. Modern and product-like." },
      { id: "manrope", name: "Manrope + Source Serif", desc: "Clean headings with a serif body for long reads. Feels like a magazine." },
      { id: "outfit", name: "Outfit + Nunito", desc: "Soft and rounded. Warm and informal." },
    ],
  },
  {
    key: "mode", label: "Light and dark", section: "look", ready: true,
    options: [
      { id: "both", name: "Light and dark", desc: "Follows each reader's device, with a switch in the header to change it." },
      { id: "light", name: "Light only", desc: "Always light, with no switch." },
    ],
  },
  {
    key: "header", label: "Header", section: "layout", markup: true, ready: true,
    options: [
      { id: "clean", name: "Clean bar", desc: "Your name, the menu, search, Sign in and Subscribe in one bar. Quiet and modern." },
      { id: "tworow", name: "Two rows, news style", desc: "A thin strip with your tagline, social links and Sign in. Then your name with a large search box, and the menu in its own row." },
      { id: "dark", name: "Dark bar", desc: "The clean bar in a dark colour, so the header stands apart from the page." },
    ],
  },
  {
    key: "home", label: "Home page", section: "layout", markup: true, page: "home", ready: true,
    options: [
      { id: "bigstory", name: "Big story and sidebar", desc: "One large story with Editor’s Choice beside it. Then the latest posts, with News, Most read and Topics in a sidebar." },
      { id: "magazine", name: "Magazine", desc: "Editor’s Choice at the top. Then the latest posts as cards beside the sidebar, and a row for each category." },
      { id: "newsroom", name: "Newsroom", desc: "Three columns: a news timeline, the main story and Editor’s Choice ranked. Then more of the latest, and a row for each category." },
    ],
  },
  {
    key: "article", label: "Article page", section: "layout", markup: true, page: "post", ready: true,
    options: [
      { id: "picture", name: "Picture first", desc: "A full-width picture with the title on it. Then the contents list and share buttons beside the text." },
      { id: "classic", name: "Classic with sidebar", desc: "Title, author and share buttons at the top, then the picture. A sidebar holds the contents list, News and the newsletter." },
      { id: "centred", name: "Centred reading", desc: "One centred column with no sidebar. The contents list sits under the quick answer, and the share buttons in a rail beside the text." },
    ],
  },
  {
    key: "share", label: "Share buttons", section: "parts", markup: true, page: "post", ready: true,
    options: [
      { id: "brand", name: "Brand colours", desc: "Square icons in each network’s own colour." },
      { id: "outline", name: "Outline icons", desc: "Small round icons that take the network’s colour when pointed at." },
      { id: "one", name: "One Share button", desc: "A single button that opens a menu with every network and Copy link." },
      { id: "quiet", name: "Quiet icons", desc: "Grey icons with no borders. They stay out of the way." },
    ],
  },
  {
    key: "code", label: "Source code box", section: "parts", markup: true, page: "post", ready: true,
    options: [
      { id: "files", name: "File list", desc: "Each file is a row you can open and close, with its own Copy and Download buttons, plus Download all." },
      { id: "tabs", name: "Tabbed panel", desc: "One tab per file, with Copy and Download buttons. Long files show their first lines, with Show all." },
      { id: "dark", name: "Dark editor", desc: "Looks like a code editor: dark in every theme, with file tabs and a status line." },
    ],
  },
  {
    key: "syntax", label: "Code colours", section: "parts", page: "post", ready: true,
    options: [
      { id: "colour", name: "Coloured", desc: "Keywords, text and comments in different colours." },
      { id: "plain", name: "Plain", desc: "One colour, with comments dimmed." },
    ],
  },
  {
    key: "downloads", label: "Downloads", section: "parts", markup: true, page: "post", ready: true,
    options: [
      { id: "buttons", name: "Big buttons", desc: "Large buttons in a row: GitHub, then one for each file." },
      { id: "cards", name: "GitHub card and file cards", desc: "A dark GitHub card on top, then a card for each file with its type, size and a Download button." },
      { id: "table", name: "File table", desc: "A compact list with each file’s type, size and a download icon, and GitHub in the corner." },
    ],
  },
  {
    key: "tables", label: "Tables", section: "parts", page: "post", ready: true,
    options: [
      { id: "striped", name: "Striped rows", desc: "A shaded header, and every other row shaded." },
      { id: "lines", name: "Clean lines", desc: "A bold line under the header and light lines between rows." },
      { id: "boxed", name: "Boxed grid", desc: "Every cell outlined, with a coloured header." },
    ],
  },
  {
    key: "comments", label: "Comments", section: "parts", page: "post", ready: true,
    options: [
      { id: "thread", name: "Open thread", desc: "Comments as a simple thread, with replies indented." },
      { id: "cards", name: "Comment cards", desc: "Each comment in its own card." },
    ],
  },
  {
    key: "admin", label: "Admin look", section: "admin", page: "admin", ready: true,
    options: [
      { id: "brand", name: "Your brand colour", desc: "A white sidebar, with your theme colour for the selected item and the main buttons." },
      { id: "light", name: "Light grey", desc: "A light grey sidebar with black buttons. Calm and plain." },
      { id: "dark", name: "Dark sidebar", desc: "A dark sidebar beside a white working area." },
    ],
  },
  {
    key: "editor", label: "Post editor", section: "admin", page: "admin", ready: true,
    options: [
      { id: "switch", name: "Visual with a Markdown switch", desc: "Write on a page that looks like the post, with a switch to Markdown when you want it." },
      { id: "visual", name: "Visual only", desc: "Only the visual editor, with no Markdown switch." },
      { id: "markdown", name: "Markdown and preview", desc: "Markdown on the left and the finished post on the right." },
    ],
  },
];

// The groups a template sets: everything readers see (not the admin's own look and editor).
export const TEMPLATE_KEYS = DESIGN_GROUPS.filter((g) => g.section !== "admin").map((g) => g.key);

// The look every blog had before the Design page: the first option of each group.
export const DESIGN_DEFAULTS = Object.freeze(Object.fromEntries(DESIGN_GROUPS.map((g) => [g.key, g.options[0].id])));

// Keeps only known groups and options; anything else falls back to the default.
export function cleanDesign(value) {
  const d = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(DESIGN_GROUPS.map((g) => [g.key, g.options.some((o) => o.id === d[g.key]) ? d[g.key] : DESIGN_DEFAULTS[g.key]]));
}
export const isDesign = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const clean = cleanDesign(value);
  return Object.keys(value).every((k) => k in clean && clean[k] === value[k]);
};

// The part of a design a template holds.
export const templateOf = (design) => {
  const d = cleanDesign(design);
  return Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, d[k]]));
};

// Ready-made starting points on Admin > Design. Picking one fills in the choices; nothing changes until Save.
export const DESIGN_PRESETS = [
  { id: "original", name: "Original", desc: "Copper & Slate with a big story and picture-first articles.", design: templateOf(DESIGN_DEFAULTS) },
  {
    id: "newsroom", name: "Newsroom", desc: "Signal Red and IBM Plex, a two-row header and a three-column home page.",
    design: templateOf({ palette: "red", fonts: "plex", mode: "both", header: "tworow", home: "newsroom", article: "classic", share: "outline", code: "tabs", syntax: "colour", downloads: "table", tables: "lines", comments: "thread" }),
  },
  {
    id: "magazine", name: "Magazine", desc: "Classic Blue and Plus Jakarta Sans, Editor’s Choice first, cards everywhere.",
    design: templateOf({ palette: "blue", fonts: "jakarta", mode: "both", header: "clean", home: "magazine", article: "classic", share: "one", code: "tabs", syntax: "colour", downloads: "cards", tables: "striped", comments: "cards" }),
  },
  {
    id: "longreads", name: "Long reads", desc: "Forest Green with a serif reading text, a centred column and quiet extras.",
    design: templateOf({ palette: "green", fonts: "manrope", mode: "both", header: "clean", home: "bigstory", article: "centred", share: "quiet", code: "files", syntax: "plain", downloads: "table", tables: "lines", comments: "thread" }),
  },
  {
    id: "workshop", name: "Workshop", desc: "Graphite & Yellow with a dark header, a dark code editor and bold cards.",
    design: templateOf({ palette: "graphite", fonts: "outfit", mode: "both", header: "dark", home: "magazine", article: "picture", share: "brand", code: "dark", syntax: "colour", downloads: "cards", tables: "boxed", comments: "cards" }),
  },
];

// Templates the owner saves on Admin > Design: a name and the choices readers see.
export const MAX_TEMPLATES = 20;
export const MAX_TEMPLATE_NAME = 60;
export const isTemplateList = (value) =>
  Array.isArray(value) && value.length <= MAX_TEMPLATES
  && value.every((t) => t && typeof t.name === "string" && t.name.trim() && t.name.length <= MAX_TEMPLATE_NAME && isDesign(t.design));

// ---- colour helpers ----
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
// `a` with `amount` (0-1) of `b` mixed in.
const mix = (a, b, amount) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * amount));

function tokens(t, dark) {
  return {
    "--bg": t.bg, "--sf": t.sf, "--sf2": t.sf2, "--sf3": mix(t.sf2, t.ink, 0.06),
    "--ink": t.ink, "--ink-2": t.ink2, "--ink-3": t.ink3, "--line": t.line, "--line-2": mix(t.line, t.ink, 0.1),
    "--ac": t.ac, "--ac-hover": mix(t.ac, dark || t.ac === "#18181B" ? "#FFFFFF" : "#000000", 0.13), "--ac-ink": t.acInk, "--ac-text": t.acText, "--ac-soft": t.acSoft,
    "--hi": t.hi, "--hi-text": t.hiText, "--hi-soft": t.hiSoft,
    "--code-bg": dark ? t.codeBg : mix(t.sf2, t.bg, 0.5), "--code-ink": dark ? t.codeInk : t.ink, "--code-line": t.line,
  };
}
const block = (selector, vars) => `${selector}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;

// The stylesheet for every colour theme and font pair, keyed on attributes of <html> (data-d-palette, data-d-fonts).
// Dark values follow the reader's device unless they chose with the header switch, as in tokens.css.
export function themeCss() {
  const css = [];
  for (const [id, p] of Object.entries(PALETTES)) {
    const sel = `:root[data-d-palette="${id}"]`;
    css.push(block(sel, tokens(p.light, false)));
    css.push(`@media (prefers-color-scheme: dark){${block(`${sel}:not([data-theme="light"])`, tokens(p.dark, true))}}`);
    css.push(block(`${sel}[data-theme="dark"]`, tokens(p.dark, true)));
    // The dark header bar and the two-row header's strip use the dark theme's colours in light mode too.
    css.push(block(sel, { "--hd-bg": p.dark.sf, "--hd-line": p.dark.line, "--hd-ink": p.dark.ink, "--hd-ink-2": p.dark.ink2, "--hd-ac": p.dark.acText, "--hd-mark": p.dark.ac, "--hd-mark-ink": p.dark.acInk }));
  }
  for (const [id, f] of Object.entries(FONT_PAIRS)) {
    if (id === "inter") continue; // tokens.css already uses Inter and JetBrains Mono
    css.push(block(`:root[data-d-fonts="${id}"]`, {
      "--font": stack(f.body), "--font-head": stack(f.head), "--font-text": stack(f.text || f.body), "--mono": stack(f.mono),
      "--font-features": f.features ? '"cv11","ss01"' : "normal",
    }));
  }
  return css.join("\n");
}

// The design as pages use it: every group's choice (unknown or missing ones fall back to the default), plus the browser
// bar colours for the theme-color tags. The layouts put palette, fonts and mode on <html> as data-d-* attributes.
export function siteDesign(value) {
  const d = cleanDesign(value);
  const p = PALETTES[d.palette];
  return { ...d, publicKeys: TEMPLATE_KEYS, themeColor: { light: p ? p.light.sf : "#FFFFFF", dark: p ? p.dark.sf : "#191C1F" } };
}

// Small colour samples for the option cards on Admin > Design: background, surface, accent, highlight and text.
export function paletteSwatches(id, mode = "light") {
  const t = PALETTES[id]?.[mode] || COPPER[mode];
  return [t.bg, t.sf, t.ac, t.hi, t.ink];
}
const COPPER = {
  light: { bg: "#F4F5F7", sf: "#FFFFFF", ac: "#C2410C", hi: "#0E7490", ink: "#1A1D21" },
  dark: { bg: "#111315", sf: "#191C1F", ac: "#C2410C", hi: "#22D3EE", ink: "#ECEDEE" },
};
