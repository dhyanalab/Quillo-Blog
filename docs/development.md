# Development

Working on Quillo itself: commands, the project layout, the design system and the packages it uses. See also [CONTRIBUTING.md](../CONTRIBUTING.md).

## Quick start

```bash
npm ci            # installs exactly what package-lock.json says (npm install can rewrite the lockfile)
npm run seed -- --dev   # optional, practice sites only: demo posts to see the layout (remove with: npm run seed -- --remove)
npm start -- --dev      # on your own computer; see "Production and development" in configuration.md
```

- Blog: http://localhost:4100/
- Admin: http://localhost:4100/admin/
- The first start prints a **setup link and a setup token** while there is no owner account. Open the link, paste the token and create the owner. The token is made fresh at every start until the owner exists, or you can choose it with `SETUP_TOKEN`. Nobody can create the owner without it.

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

**Run it under a supervisor.** After an unexpected error the server stops on purpose (it closes the port and exits with code 1 within 5 seconds) instead of limping on in a doubtful state. A supervisor such as systemd, pm2 or Docker's restart policy starts it again at once; see [deployment.md](deployment.md). `npm start` on its own does not restart anything.

`npm ci` runs the packages' install scripts (esbuild has one). To skip them on a server that only runs the blog, use `npm ci --omit=dev --ignore-scripts`; or put `ignore-scripts=true` in a `.npmrc` file and run `npm run build:editor` yourself when you need it.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Runs the blog and the admin on port 4100, in production mode. |
| `npm run dev` | Development mode, restarting when server code changes. Templates, CSS and JS reload on every request. |
| `npm run seed -- --dev` | Adds demo content to a practice site: posts with source code and downloads, news, a page and comments. It refuses production mode, and a site that already has posts, members or subscribers, unless you add `--force`. With `--force` on a production site the demo author is created suspended, the posts and the page are drafts and the banners are off, so nothing appears on the live site by itself. It keeps a record of what it added in `<DATA_DIR>/demo-seed.json` (a second run adds to the record); `npm run seed -- --remove` deletes those items, but only rows that still look like demo content (the demo author, banner and reader addresses, the "demo" tag, files named `demo-...`), and says what it left alone. Categories stay. |
| `npm run user -- list` | Lists staff accounts. Names and emails are shown with control characters removed. Every `user` command first says which database it uses and whether the encryption key matches it. |
| `npm run user -- where` | Shows which data folder and database file the tool is using, how many staff, posts, readers, subscribers and uploads it finds, and whether the owner exists. Use it when the site looks empty: the usual cause is `DATA_DIR` pointing at the wrong folder. |
| `npm run user -- reset you@example.com` | Prints a new password when a staff member is locked out, signs them out everywhere and cancels any sign-in in progress. The password is temporary: the person must choose their own at the next sign-in, and it stops working after 7 days. A suspended account stays suspended; add `--activate` to lift the suspension. If the blog is running and they typed a wrong password several times just before, the running blog can keep refusing for up to 15 minutes; restart the blog to clear that. |
| `npm run user -- reset-2fa you@example.com` | Turns off two-step sign-in for someone who lost their phone and recovery codes. |
| `npm run user -- create you@example.com "Name" admin` | Creates a staff account (the email is checked and lower-cased). They must choose a new password at first sign-in (within 7 days). Adding another owner needs `--force`. A name that starts with `--` goes after a lone `--`: `create you@example.com -- "--odd name"`. |
| `npm run user -- end-sessions you@example.com` | Signs one person out everywhere and cancels any sign-in of theirs that is in progress. `npm run user -- end-sessions --all` signs out every staff member and reader, cancels every sign-in in progress and removes every recovery code (people are asked to create new ones). Use it after a restore. |
| `npm test` | End-to-end tests: auth, the editor API, publishing checks, SEO output, redirects, scheduling, media and downloads, reader accounts, comments and moderation. |
| `npm run verify -- http://localhost:4100/` | Opens every page in Edge at phone and desktop widths, light and dark. Checks sideways scrolling, contrast, focus rings and third-party requests, and saves screenshots to `test/output/`. To include the admin screens, set `BLOG_ADMIN_EMAIL` and `BLOG_ADMIN_PASSWORD` in the environment (never on the command line), plus `BLOG_ADMIN_CODE` (the current 6-digit code) for an account with two-step sign-in. Only runs against this computer unless you add `--allow-remote`. |
| `npm run flow -- http://localhost:4100/` | Drives the editor in a real browser: write, add a picture, source code and a PDF, publish, unpublish, delete. It signs in as an admin and publishes a real post, so use a practice site. Sign-in details come from `BLOG_ADMIN_EMAIL`, `BLOG_ADMIN_PASSWORD` and (for two-step) `BLOG_ADMIN_CODE`. Only runs against this computer unless you add `--allow-remote`. |
| `npm run build:editor` | Rebuilds `assets/vendor/toastui-editor.*` after upgrading the editor package. |
| `npm run build:site` | Builds the Quillo website (quillo.dhyanalab.in) from `site-src/` into `site/`. Upload the `site` folder to Cloudflare Pages to publish it. |
| `npm run build:icons` | Copies the social network logos from Simple Icons into `src/web/brand-paths.js` (after adding a network in `src/web/networks.js`). |

The `user` tool never changes the database layout: if the blog's code is newer than the database it stops and asks you to start the blog once (it saves a copy first), or to add `--migrate` while the blog is stopped. Everything it changes is also written to `<DATA_DIR>/audit.log` (the same file the admin writes to).

## Project layout

```
server.js               starts the server, the scheduler, and any newsletter that was mid-send
src/config.js           environment settings
src/db.js               SQLite connection and migrations (src/migrations/*.sql)
src/store/              data access: posts, users, members and comments, newsletter, ads, media, taxonomy, settings
src/render/             Markdown, code highlighting and ZIPs, publishing checks, JSON-LD, social images, the newsletter email, media, fonts
src/web/                Hono app: public routes, reader accounts and comments, admin, security, caching, view models
src/services/           scheduler, IndexNow, the mailer (nodemailer) and the newsletter sender
views/public, views/admin   Nunjucks templates
assets/css              tokens.css (Copper & Slate, the original look), base, site, article, admin, editor
assets/js               site.js (inline on public pages), admin.js, editor.js, design.js (Admin > Design)
assets/vendor           the bundled Toast UI editor (npm run build:editor)
scripts/                seed, user tools, browser checks, editor bundle
test/                   end-to-end tests (app.test.js runs the blog under /blog, site.test.js at the root)
src/product.js          the software's name and version (from VERSION), shown in the admin
src/design.js           the Admin > Design catalogue: every option, the ready-made templates and the colour themes
deploy/                 systemd service, install script, Cloudflare Tunnel example, and the guide to putting a blog online
design/picker/          the design picker the current look was chosen with (open index.html in a browser)
site-src/               the Quillo website: pages and shared parts (npm run build:site)
site/                   the built website, the folder that goes online (static: no scripts, no cookies)
```

## Design

Owners choose the look on Admin > Design. The original look (and the first option of every group) is:

- **Colours:** Copper & Slate. Slate greys with a copper accent (#C2410C) and teal as the second colour, in light and dark. A switch in the header lets readers choose.
- **Fonts:** Inter for text and JetBrains Mono for code.
- **Layout:**
  - a clean header bar with menu panels;
  - a big story and sidebar home page;
  - picture-first articles with a contents and share rail.
- **Article parts:**
  - brand-coloured share buttons;
  - code in a file list with colours;
  - large download buttons;
  - striped tables sized to their content;
  - an open comment thread.
- **Admin:** laid out like Ghost, with your brand colour for the selected item and the main buttons.

How it works:

- **The catalogue:** `src/design.js` lists every group and option (`DESIGN_GROUPS`), the ready-made templates (`DESIGN_PRESETS`) and the colour values (`PALETTES`). The setting `design` holds one option id per group. Unknown or missing values fall back to the first option.
- **Pages:** every page carries the choices as attributes on `<html>`, such as `data-d-palette="teal"` and `data-d-share="outline"`.
  - **Colours and fonts** are CSS variables. `themeCss()` builds a block per theme and font pair, after `tokens.css`.
  - **Styles** (share, tables, comments, code colours, header colour, admin look) are rules under `:root[data-d-…]` in the stylesheets.
  - **Layouts** (two-row header, home pages, article pages, one Share button, code tabs, downloads) are branches in `header.njk`, `home.njk` and `post.njk`. Groups marked `markup: true` change the HTML.
- **Fonts:** self-hosted from `@fontsource`. `src/render/fonts.js` lists every family and weight. Pages preload only the chosen pair's body text and headings.
- **The preview:** `/admin/design/preview` draws the home page or an article with the choices in its address. It's the only admin page another admin page may frame (the `framing` option in `securityHeaders`).
- **Adding an option:** add it to its group in `src/design.js`. Then add its CSS rule or template branch, and a test in `test/design.test.js`. Keep the first option the original look, so existing blogs never change by themselves.
- **No raw HTML:** raw HTML in Markdown is turned off, so a post or comment can never run a script on the site or in the admin.

## Licenses

Quillo itself: GNU AGPL-3.0-or-later (see [LICENSE](../LICENSE) and [LICENSING.md](../LICENSING.md)). Copyright (C) 2026 Dhyana Engineering Solutions.

It uses these packages:

| Package | License |
| --- | --- |
| Hono, markdown-it, Toast UI Editor (and ProseMirror) | MIT |
| Nodemailer | MIT-0 |
| uqr (QR codes) | MIT |
| Nunjucks | BSD-2 |
| highlight.js | BSD-3 |
| sharp | Apache-2.0 |
| Satori (social images) | MPL-2.0 |
| Inter and JetBrains Mono | OFL |
| playwright-core (check scripts only) | Apache-2.0 |
| esbuild (editor bundle only) | MIT |
| Simple Icons (social logos, copied at build time) | CC0 |
