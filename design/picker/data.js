// Options data and sample content shared by every preview.
window.PK = {};

PK.THEMES = [
  { id: 'blue', name: 'Circuit Blue', desc: 'White pages, a confident blue for links and buttons, amber for highlights. Reads like good engineering docs.',
    light: { bg:'#F6F8FB', sf:'#FFFFFF', sf2:'#EEF2F7', ink:'#0F172A', ink2:'#475569', ink3:'#64748B', line:'#E2E8F0', ac:'#2563EB', acInk:'#FFFFFF', acText:'#1D4ED8', acSoft:'#E8EFFE', hi:'#F59E0B', hiText:'#92400E', hiSoft:'#FEF3C7', codeBg:'#0F172A', codeInk:'#E2E8F0' },
    dark:  { bg:'#0B1120', sf:'#111A2E', sf2:'#17223A', ink:'#E5ECF6', ink2:'#A3B1C6', ink3:'#8291A8', line:'#22304D', ac:'#2563EB', acInk:'#FFFFFF', acText:'#8AB4FF', acSoft:'#15254A', hi:'#FBBF24', hiText:'#FCD34D', hiSoft:'#3A2E0F', codeBg:'#070C18', codeInk:'#E2E8F0' } },
  { id: 'pcb', name: 'PCB Green', desc: 'Solder-mask green with gold accents, like a bare circuit board. Distinctive and clearly about electronics.',
    light: { bg:'#F4F7F5', sf:'#FFFFFF', sf2:'#EAF1ED', ink:'#0D1B14', ink2:'#46594F', ink3:'#5C6F65', line:'#D9E3DD', ac:'#047857', acInk:'#FFFFFF', acText:'#05704F', acSoft:'#E1F2EA', hi:'#D4A017', hiText:'#7A5200', hiSoft:'#FAF0D2', codeBg:'#0B1A13', codeInk:'#DCEFE4' },
    dark:  { bg:'#07120D', sf:'#0E1C15', sf2:'#14261D', ink:'#E2EFE8', ink2:'#9BB3A6', ink3:'#809A8D', line:'#1F3529', ac:'#047857', acInk:'#FFFFFF', acText:'#5EE0A6', acSoft:'#123325', hi:'#E3B341', hiText:'#F2C94C', hiSoft:'#33290C', codeBg:'#040B08', codeInk:'#DCEFE4' } },
  { id: 'copper', name: 'Copper & Slate', desc: 'Cool slate greys with a copper-orange accent and teal as the second colour. Warm and hands-on, like a workbench.',
    light: { bg:'#F4F5F7', sf:'#FFFFFF', sf2:'#ECEEF1', ink:'#1A1D21', ink2:'#535A63', ink3:'#68707A', line:'#DEE1E5', ac:'#C2410C', acInk:'#FFFFFF', acText:'#AE3A0A', acSoft:'#FCEBDF', hi:'#0E7490', hiText:'#0E6A83', hiSoft:'#DFF1F5', codeBg:'#16181B', codeInk:'#ECE7E1' },
    dark:  { bg:'#111315', sf:'#191C1F', sf2:'#212529', ink:'#ECEDEE', ink2:'#A7ADB4', ink3:'#8A9199', line:'#2B3036', ac:'#C2410C', acInk:'#FFFFFF', acText:'#FF9A62', acSoft:'#3A2216', hi:'#22D3EE', hiText:'#67E8F9', hiSoft:'#0F2E35', codeBg:'#0B0C0E', codeInk:'#ECE7E1' } },
  { id: 'teal', name: 'Oscilloscope Teal', desc: 'Deep teal with a probe-yellow highlight, taken from test equipment. Calm, technical and easy on the eyes.',
    light: { bg:'#F2F7F7', sf:'#FFFFFF', sf2:'#E6EFF0', ink:'#0A1E22', ink2:'#435C5E', ink3:'#587073', line:'#D4E2E3', ac:'#0F766E', acInk:'#FFFFFF', acText:'#0D6B64', acSoft:'#DDF1EE', hi:'#CA8A04', hiText:'#7C4A03', hiSoft:'#FDF5D6', codeBg:'#0A1C1F', codeInk:'#D7F0EE' },
    dark:  { bg:'#061416', sf:'#0C1E21', sf2:'#12292D', ink:'#DDEFEF', ink2:'#97B3B4', ink3:'#7D9A9B', line:'#1A3539', ac:'#0F766E', acInk:'#FFFFFF', acText:'#4FDCC9', acSoft:'#0F2F2E', hi:'#FACC15', hiText:'#FDE047', hiSoft:'#332B07', codeBg:'#030C0D', codeInk:'#D7F0EE' } },
  { id: 'red', name: 'Signal Red', desc: 'Charcoal and white with a sharp red accent and blue links. Punchy and news-like.',
    light: { bg:'#F6F6F7', sf:'#FFFFFF', sf2:'#EFEFF1', ink:'#121316', ink2:'#4E5158', ink3:'#65686F', line:'#E3E3E6', ac:'#DC2626', acInk:'#FFFFFF', acText:'#C01C1C', acSoft:'#FDECEC', hi:'#2563EB', hiText:'#1D4ED8', hiSoft:'#E8EFFE', codeBg:'#141518', codeInk:'#ECECEE' },
    dark:  { bg:'#0E0F11', sf:'#17181B', sf2:'#1F2024', ink:'#EDEDEF', ink2:'#A9ABB2', ink3:'#8B8D95', line:'#2A2B30', ac:'#DC2626', acInk:'#FFFFFF', acText:'#FF8080', acSoft:'#3A1517', hi:'#60A5FA', hiText:'#93C5FD', hiSoft:'#14254A', codeBg:'#09090B', codeInk:'#ECECEE' } },
  { id: 'yellow', name: 'Graphite & Yellow', desc: 'Black, white and caution yellow. Bold and high-contrast, like a workshop label maker.',
    light: { bg:'#F5F5F4', sf:'#FFFFFF', sf2:'#EEEEEC', ink:'#18181B', ink2:'#52525B', ink3:'#66666E', line:'#E2E2DF', ac:'#18181B', acInk:'#FFFFFF', acText:'#18181B', acSoft:'#FEF7C3', hi:'#FACC15', hiText:'#713F12', hiSoft:'#FEF7C3', codeBg:'#18181B', codeInk:'#F4F4F5', deco:'#EAB308', bar:'#EAB308', markBg:'#FACC15', markInk:'#18181B' },
    dark:  { bg:'#0F0F10', sf:'#18181B', sf2:'#222226', ink:'#F4F4F5', ink2:'#A1A1AA', ink3:'#8B8B94', line:'#2C2C31', ac:'#FACC15', acInk:'#18181B', acText:'#FDE047', acSoft:'#2E2A0C', hi:'#FACC15', hiText:'#FDE047', hiSoft:'#2E2A0C', codeBg:'#09090B', codeInk:'#F4F4F5' } },
];

PK.FONTS = [
  { id: 'plex', name: 'IBM Plex Sans + Plex Mono', desc: 'Made for engineering documentation. Calm and very readable, and the matching mono font keeps code tidy.',
    fh: "'IBM Plex Sans',system-ui,sans-serif", fb: "'IBM Plex Sans',system-ui,sans-serif", fm: "'IBM Plex Mono',ui-monospace,Consolas,monospace", hw: 700 },
  { id: 'jakarta', name: 'Plus Jakarta Sans + Inter', desc: 'Rounder, friendlier headings with a crisp body font. Feels modern and product-like.',
    fh: "'Plus Jakarta Sans',system-ui,sans-serif", fb: "'Inter',system-ui,sans-serif", fm: "'JetBrains Mono',ui-monospace,Consolas,monospace", hw: 800 },
  { id: 'inter', name: 'Inter + JetBrains Mono', desc: 'The neutral choice that Ghost and many developer tools use. Lets the colours and images lead.',
    fh: "'Inter',system-ui,sans-serif", fb: "'Inter',system-ui,sans-serif", fm: "'JetBrains Mono',ui-monospace,Consolas,monospace", hw: 700 },
  { id: 'manrope', name: 'Manrope + Source Serif', desc: 'Sans-serif headings with a serif body for long reads. Feels like a magazine.',
    fh: "'Manrope',system-ui,sans-serif", fb: "'Source Serif 4',Georgia,serif", fm: "'JetBrains Mono',ui-monospace,Consolas,monospace", hw: 800 },
  { id: 'outfit', name: 'Outfit + Nunito (current)', desc: 'What the blog uses today. Soft and rounded.',
    fh: "'Outfit',system-ui,sans-serif", fb: "'Nunito',system-ui,sans-serif", fm: "'Fira Code',ui-monospace,Consolas,monospace", hw: 700 },
];

PK.SX_LIGHT = { sxK:'#CF222E', sxS:'#0A3069', sxN:'#0550AE', sxC:'#6E7781', sxF:'#8250DF', sxP:'#CF222E' };
PK.SX_DARK  = { sxK:'#FF7B72', sxS:'#A5D6FF', sxN:'#79C0FF', sxC:'#8B949E', sxF:'#D2A8FF', sxP:'#FF7B72' };

// Stroke icons (24px grid).
PK.I = {
  chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  down:'<path d="m6 9 6 6 6-6"/>', left:'<path d="m15 6-6 6 6 6"/>',
  dl:'<path d="M12 3v12m0 0-5-5m5 5 5-5M5 21h14"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  link:'<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  ext:'<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  pdf:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  cube:'<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  zip:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v2h2v2h-2v2h2v2h-2v3"/>',
  home:'<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  pen:'<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  file:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  tag:'<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  users:'<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.6"/>',
  msg:'<path d="M4 5h16v11H9l-5 4z"/>',
  img:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  reply:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  code:'<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
  video:'<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  minus:'<path d="M5 12h14"/>',
  list:'<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  quote:'<path d="M7 7h4v4H8a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5zM15 7h4v4h-3a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5z"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};

// Brand marks (Simple Icons, CC0), filled.
PK.B = {
  whatsapp:'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z',
  x:'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  linkedin:'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  facebook:'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  github:'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  youtube:'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
};

// Picture placeholders: a gradient and a line drawing of the hardware.
PK.ILL = {
  board:'<rect x="10" y="14" width="100" height="42" rx="4"/><rect x="44" y="24" width="32" height="22" rx="2"/><path d="M20 14V7M30 14V7M40 14V7M50 14V7M60 14V7M70 14V7M80 14V7M90 14V7M100 14V7M20 63v-7M30 63v-7M40 63v-7M50 63v-7M60 63v-7M70 63v-7M80 63v-7M90 63v-7M100 63v-7"/><circle cx="24" cy="35" r="4"/>',
  sonar:'<rect x="12" y="18" width="96" height="34" rx="4"/><circle cx="38" cy="35" r="12"/><circle cx="82" cy="35" r="12"/><circle cx="38" cy="35" r="5"/><circle cx="82" cy="35" r="5"/>',
  cam:'<rect x="22" y="12" width="76" height="48" rx="6"/><circle cx="60" cy="36" r="14"/><circle cx="60" cy="36" r="6"/><rect x="30" y="19" width="10" height="6" rx="1"/>',
  wifi:'<path d="M28 34a46 46 0 0 1 64 0M38 44a32 32 0 0 1 44 0M48 54a18 18 0 0 1 24 0"/><circle cx="60" cy="62" r="2.5"/>',
  led:'<path d="M48 42a12 12 0 1 1 24 0v8H48z"/><path d="M54 50v14M66 50v14M60 16V8M42 24l-6-6M78 24l6-6"/>',
  chart:'<path d="M14 60h92M14 60V10"/><path d="m22 48 16-14 16 8 18-20 16 10 14-8"/>',
  drop:'<path d="M60 8c12 16 20 26 20 36a20 20 0 0 1-40 0c0-10 8-20 20-36z"/><path d="M50 44a10 10 0 0 0 10 10"/>',
  plant:'<path d="M60 62V34M60 40c-14 0-22-8-22-20 14 0 22 8 22 20zM60 34c0-12 8-20 22-20 0 12-8 20-22 20z"/><path d="M44 62h32"/>',
  bolt:'<path d="M66 8 40 40h18l-6 24 28-34H62z"/>',
};
PK.GR = ['', 'linear-gradient(135deg,#0E3A55,#1F7A8C)', 'linear-gradient(135deg,#1B2A41,#4B6584)', 'linear-gradient(135deg,#21401B,#5E8C36)',
  'linear-gradient(135deg,#43281F,#B0612A)', 'linear-gradient(135deg,#202326,#596470)', 'linear-gradient(135deg,#123C69,#3E7CB1)',
  'linear-gradient(135deg,#3A3022,#9C8257)', 'linear-gradient(135deg,#0B3D3A,#2A9D8F)', 'linear-gradient(135deg,#3B1F2B,#8C4A5F)'];

// Sample posts and news (sample text only).
PK.P = [
  { t:'ESP32 Water Tank Level Monitor With Alarm', c:'ESP32 Projects', d:'22 Oct 2026', a:'Arun Kumar', g:1, il:'sonar', x:'Measure the water level with an ultrasonic sensor and get a phone alert before the tank runs dry.' },
  { t:'ESP32-CAM Motion Alert That Sends a Photo to Your Phone', c:'ESP32-CAM', d:'20 Oct 2026', a:'Meena R', g:2, il:'cam', x:'Detect movement with a PIR sensor and send a snapshot to your phone in under two seconds.' },
  { t:'Control an LED From Your Phone With ESP32', c:'Tutorials', d:'18 Oct 2026', a:'Arun Kumar', g:6, il:'led', x:'Your first web-controlled project: a tiny web page on the ESP32 that switches an LED.' },
  { t:'DHT22 Climate Monitor With an OLED Display', c:'ESP32 Projects', d:'15 Oct 2026', a:'Meena R', g:8, il:'chart', x:'Show temperature and humidity on a 0.96" OLED and log them every minute.' },
  { t:'Smart Plant Watering With a Soil Moisture Sensor', c:'IoT', d:'12 Oct 2026', a:'Karthik S', g:3, il:'plant', x:'Water your plants only when the soil is dry, with a pump, a relay and a capacitive sensor.' },
  { t:'Build a Wi-Fi Weather Station That Logs to the Cloud', c:'IoT', d:'9 Oct 2026', a:'Karthik S', g:5, il:'wifi', x:'Temperature, pressure and rain on a dashboard you can open from anywhere.' },
  { t:'Read Any I2C Sensor on ESP32: A Beginner Guide', c:'Tutorials', d:'6 Oct 2026', a:'Arun Kumar', g:7, il:'board', x:'Find the address, wire SDA and SCL, and read your first values in ten minutes.' },
  { t:'A BLE Door Sensor That Runs a Year on One Battery', c:'ESP32 Projects', d:'3 Oct 2026', a:'Meena R', g:4, il:'bolt', x:'Deep sleep, a reed switch and BLE advertising keep the current under 10 µA.' },
  { t:'Arduino Uno or ESP32: Which Board for Your Project?', c:'Arduino', d:'1 Oct 2026', a:'Karthik S', g:9, il:'board', x:'Pins, power, Wi-Fi and price compared, with a simple rule for choosing.' },
  { t:'MQTT Dashboard for Home Sensors in 20 Minutes', c:'IoT', d:'28 Sep 2026', a:'Arun Kumar', g:1, il:'wifi', x:'Send readings from three boards to one dashboard with a free MQTT broker.' },
  { t:'Debounce a Push Button Without delay()', c:'Arduino', d:'25 Sep 2026', a:'Meena R', g:5, il:'board', x:'Read buttons reliably while the rest of your sketch keeps running.' },
  { t:'Power an ESP32 From Batteries: Deep Sleep Explained', c:'Tutorials', d:'22 Sep 2026', a:'Karthik S', g:6, il:'bolt', x:'How long a battery really lasts, and the three settings that matter most.' },
];
PK.NEWS = [
  { t:'New Wi-Fi 6 modules aimed at battery-powered sensors', k:'Product', d:'3 Nov 2026', time:'10:45', g:2, il:'wifi' },
  { t:'Arduino IDE update makes library installs faster', k:'Software', d:'3 Nov 2026', time:'08:20', g:9, il:'board' },
  { t:'Maker fair in Bengaluru opens project registrations', k:'Community', d:'2 Nov 2026', time:'17:05', g:3, il:'chip' },
  { t:'Smart-home standard adds support for energy meters', k:'Industry', d:'2 Nov 2026', time:'12:30', g:6, il:'bolt' },
  { t:'Cheaper camera boards arrive for hobby projects', k:'Product', d:'1 Nov 2026', time:'15:10', g:4, il:'cam' },
  { t:'Open-source PCB tool adds a new autorouter', k:'Software', d:'31 Oct 2026', time:'09:40', g:5, il:'board' },
  { t:'Students build flood sensors for their village', k:'Community', d:'30 Oct 2026', time:'18:00', g:8, il:'drop' },
];
PK.ILL.chip = PK.ILL.board;

PK.TROWS = [
  ['ESP32 DevKit V1', '1', 'Any ESP32-WROOM-32 board'],
  ['HC-SR04 ultrasonic sensor', '1', 'Mount 5 cm above the overflow'],
  ['Active buzzer, 5 V', '1', 'Switched by the transistor'],
  ['BC547 NPN transistor', '1', 'With a 1 kΩ base resistor'],
  ['Jumper wires', '10', 'Male to female'],
];
PK.FILES = [
  { n:'Circuit diagram', t:'PDF', s:'380 KB', i:'pdf' },
  { n:'Sensor mount', t:'STL', s:'1.2 MB', i:'cube' },
  { n:'Enclosure lid', t:'STL', s:'840 KB', i:'cube' },
];

PK.SNIP = [
  'long duration = pulseIn(ECHO_PIN, HIGH, 30000);',
  'float distanceCm = duration * 0.0343 / 2;',
  'int level = map(distanceCm, TANK_EMPTY_CM, TANK_FULL_CM, 0, 100);',
].join('\n');

PK.CODE_MAIN = [
  '#include <WiFi.h>',
  '#include <WebServer.h>',
  '#include "config.h"',
  '',
  'const int TRIG_PIN = 5;',
  'const int ECHO_PIN = 18;',
  'const int BUZZER_PIN = 19;',
  'const int ALARM_BELOW = 15;  // percent',
  '',
  'WebServer server(80);',
  'int levelPercent = 0;',
  '',
  'float readDistanceCm() {',
  '  digitalWrite(TRIG_PIN, LOW);',
  '  delayMicroseconds(2);',
  '  digitalWrite(TRIG_PIN, HIGH);',
  '  delayMicroseconds(10);',
  '  digitalWrite(TRIG_PIN, LOW);',
  '  long duration = pulseIn(ECHO_PIN, HIGH, 30000);',
  '  return duration * 0.0343 / 2;',
  '}',
  '',
  'void handleLevel() {',
  '  server.send(200, "text/plain", String(levelPercent));',
  '}',
  '',
  'void setup() {',
  '  Serial.begin(115200);',
  '  pinMode(TRIG_PIN, OUTPUT);',
  '  pinMode(ECHO_PIN, INPUT);',
  '  pinMode(BUZZER_PIN, OUTPUT);',
  '  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);',
  '  while (WiFi.status() != WL_CONNECTED) delay(250);',
  '  server.on("/level", handleLevel);',
  '  server.begin();',
  '}',
  '',
  'void loop() {',
  '  float cm = readDistanceCm();',
  '  levelPercent = constrain(map(cm, TANK_EMPTY_CM, TANK_FULL_CM, 0, 100), 0, 100);',
  '  digitalWrite(BUZZER_PIN, levelPercent < ALARM_BELOW ? HIGH : LOW);',
  '  server.handleClient();',
  '  delay(2000);',
  '}',
].join('\n');

PK.CODE_CFG = [
  '// Fill in your own network details before uploading.',
  '#define WIFI_SSID      "your-network-name"',
  '#define WIFI_PASSWORD  "your-password"',
  '',
  '// Distance from the sensor to the water, in cm.',
  '#define TANK_EMPTY_CM  120',
  '#define TANK_FULL_CM   20',
].join('\n');
