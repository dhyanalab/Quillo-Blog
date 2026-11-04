# Quillo

A self-hosted blog platform. Each install runs one blog, with its own name, design and data.

- **Admin:** a Ghost-style admin for writing, publishing and moderating, made for people who aren't technical.
- **Public site:** a big story and Editor's Choice on the home page, Latest with News and Most read beside it, category rows, and picture-first articles.
- **Readers:** can create an account to comment, and subscribe to a newsletter.
- **Search and answer engines:** everything they need is built in.

The blog runs as one Node process with a SQLite file. There's no database server and no build step.

- **Version:** see [CHANGELOG.md](CHANGELOG.md). The admin sidebar shows the running version.
- **Licence:** GNU AGPL-3.0-or-later, with a commercial licence available. See [LICENSING.md](LICENSING.md).
- **Putting a blog online:** [deploy/README.md](deploy/README.md) covers a Raspberry Pi or VPS with Cloudflare Tunnel.
- **Security reports:** [SECURITY.md](SECURITY.md).
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

```bash
npm ci            # installs exactly what package-lock.json says (npm install can rewrite the lockfile)
npm run seed -- --dev   # optional, practice sites only: demo posts to see the layout (remove with: npm run seed -- --remove)
npm start -- --dev      # on your own computer; see "Production and development" below
```

- Blog: http://localhost:4100/
- Admin: http://localhost:4100/admin/
- The first start prints a **setup link and a setup token** while there is no owner account. Open the link, paste the token and create the owner. The token is made fresh at every start until the owner exists, or you can choose it with `SETUP_TOKEN`. Nobody can create the owner without it.

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

**Run it under a supervisor.** After an unexpected error the server stops on purpose (it closes the port and exits with code 1 within 5 seconds) instead of limping on in a doubtful state. A supervisor such as systemd, pm2 or Docker's restart policy starts it again at once; see "Deploying". `npm start` on its own does not restart anything.

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
| `npm run build:icons` | Copies the social network logos from Simple Icons into `src/web/brand-paths.js` (after adding a network in `src/web/networks.js`). |

The `user` tool never changes the database layout: if the blog's code is newer than the database it stops and asks you to start the blog once (it saves a copy first), or to add `--migrate` while the blog is stopped. Everything it changes is also written to `<DATA_DIR>/audit.log` (the same file the admin writes to).

## Writing and publishing

- **Editor**: a visual editor (Toast UI) with a **Visual / Markdown** switch. Posts are always saved as Markdown.
  - Tables are edited in a grid: right-click a cell to add or remove rows and columns.
  - Paste or drop pictures to upload them.
  - The insert bar adds a picture from the library, a table, a code snippet, a callout or an FAQ section.
  - An italic line right under a picture becomes its caption.
  - Ctrl+S saves. Drafts autosave every 15 seconds.
  - **Preview** opens the full page, unsaved changes included, in a new tab.
- **Post settings**: the drawer on the right, like Ghost's. It holds:
  - the URL, publish date, category, tags, author, Editor's Choice and the meta description, with a search preview
  - the answer box (quick answer, at-a-glance rows, tested with, difficulty)
  - video, search and social settings, comments on or off, the "Updated" date, history, and Unpublish or Delete
- **Source code**: full sketches go in the Source code section below the text, not in the article. Readers get a box after the FAQ and above Downloads. It has one row per file, with copy and download buttons, coloured code, and a ZIP of every file. Short snippets that explain a step can stay in the text.
- **Downloads**: a GitHub link plus PDF, STL, 3MF, STEP or ZIP files from the media library, shown as large download buttons. Files are checked by their contents and always served as downloads.
- **Uploads**: pictures are re-encoded (location data removed, orientation fixed) with AVIF and WebP sizes. Files are stored as `name-<16 characters of the file's SHA-256>.ext` and never overwrite another file. Images over 40 megapixels are refused. Animated GIFs (up to 200 frames, 2400 px) are re-encoded too, which drops comments and anything appended to the file. SVGs must be plain drawings under 1 MB: no DOCTYPE or entity declarations, scripts, `foreignObject`, event handlers, `@import`, backslash escapes, animations that set a link or an outside address, or links that point outside the file (only `#` references are allowed). They are also refused when they are absurdly complex (over 20,000 elements, over 50 `<use>` copies, over 20 filters). The checks cost time in proportion to the file size, so a huge or crafted file is refused quickly and can't slow the site.
- **Upload queue**: at most two pictures are processed at a time and eight wait; beyond that the upload is refused with "The image processor is busy. Try again in a minute." If a file name is already taken by different bytes (a leftover from an older run), the new file is stored under a second name (`name-r2-<hash>`); an existing file is never overwritten.
- **Publishing checks**: problems that block publishing appear above the editor, with a button to jump to each one. They cover:
  - `[[TODO]]`, `[CHECK: …]`, placeholders, board tokens and "Week N"
  - a missing or long meta description, or an SEO title over 60 characters
  - missing alt text, broken internal links or anchors, and incomplete video data
  - bad source file names, and real Wi-Fi names, passwords or keys in code
  
  Use placeholders such as `"YOUR_WIFI_PASSWORD"` in code. A live post can't be updated into a broken state.
- **Revisions**: the last 30 versions of each post, restorable from History.
- **Roles**:

  | Role | Can do |
  | --- | --- |
  | Owner / Administrator | Everything, including settings, staff and members |
  | Editor | Every post and page, plus categories, tags and comments |
  | Author | Their own posts, including publishing |
  | Contributor | Drafts only |

- **URLs**: changing a live post's or category's URL adds a 301 automatically. Deleting a live post leaves a 410. Add more under Redirects.

## Two-step sign-in (staff)

Each staff member can add an authenticator app (Google Authenticator, Microsoft Authenticator, Zoho OneAuth, Authy, 1Password…) under **Your profile > Two-step sign-in**:

- **Turning it on:** scan the QR code (or type the setup key), then enter the app's 6-digit code and your password. The secret stays with the session that started the setup until a correct code confirms it. Your other sessions are signed out.
- **Recovery codes:** 10 single-use codes are shown once, to copy, download or print. Only keyed hashes of them are stored. Getting new ones needs your password and an app code. Codes stored in an older, weaker format were removed by an update; the person sees a notice on the dashboard and the two-step page to create new ones.
- **Requiring it:** the owner can set "Require two-step sign-in" on the Users page to off (the default), administrators (owner and admins) or all staff. Anyone it applies to who has not turned it on can only reach the two-step setup, their profile, the password page and sign-out until they do.
- **Trusted browsers:** after a full sign-in the browser keeps a 180-day cookie. Wrong passwords typed by strangers are counted separately from the owner's trusted browser, so they can't lock the owner out of their own computer. Changing the password cancels every trusted browser. Recovery codes still work while the two-step lock is on.
- **Signing in:** after the password, a 5-minute challenge allows 5 tries at the app code or a recovery code; only then is a session created. Codes are standard TOTP (RFC 6238: SHA-1, 30-second steps, 6 digits, one step of clock drift either way), and each code is accepted once.
- **Turning it off** needs your password and a code. An owner, or an administrator for lower roles, can turn it off for someone else with their own password; `npm run user -- reset-2fa` does the same from the server. A password reset or a two-step change (from the screen or from `npm run user`) also ends any sign-in challenge that was already open, so a challenge started before a suspected break-in can't be completed afterwards.

Nothing is sent to any outside service. The QR code is drawn on the server ([uqr](https://github.com/unjs/uqr), MIT).

## Readers and comments

- **Accounts**: readers create a free account under **Create account** (`/signup/`) and sign in at `/signin/`. Only signed-in readers can comment, reply and like.
- **Email verification**: when the site's email is set up (see Newsletter > Email settings), a new account is created unverified (the form asks only for name and email) and a link is emailed. The page the link opens asks the reader to choose their password; that is what verifies the account and signs them in. A second sign-up for an unverified address changes nothing and sends a new link only if the last one is over 15 minutes old. The sign-up page answers the same way whether or not the address already had an account (an existing account gets an email saying so). Until email is set up, sign-ups are closed ("New sign-ups open once the site's email is set up"). Unverified accounts can't sign in. Readers who forgot their password use `/forgot/`; the emailed link works once and lasts one hour.
- **Account page**: `/account/` lets readers change their name or password, sign out, or delete their account along with their comments.
- **Approval** (set in Settings, under Comments): a reader's first comment waits for approval by default. You can switch to approving every comment, or to letting comments go live at once.
- **Moderation**: the admin's **Comments** screen has approve, hide, delete and reply-as-the-team.
- **Members**: the admin's **Members** screen has block, delete, **Export CSV** (a button, not a link, so a page or an image can never start the download) and **Reset link**, which emails the member a link to choose a new password.
- **Turning comments off**: per post in the editor, or for the whole site in Settings.
- **Caching**: pages for signed-in readers are never cached or shared. Everyone else gets cached pages.

## The home page

- **Big story and Editor's Choice:** the posts marked **Editor's Choice**, newest first. Recent posts fill any gap.
- **Latest:** every post except news, with a sidebar.
- **Sidebar:**
  - **News** comes from the News category (choose it in Settings, under Home page).
  - **Most read** comes from page views.
  - Also the newsletter box and Topics.
- **Category rows:** one row per top-level category with "Show on the home page" ticked.
- **Menu:** a category with sub-categories opens a panel listing them plus its three newest posts.

## Social links

Author profiles (Staff) and the site's social profiles (Settings) use the same list. Each row has a network with its logo and a box for the link, and **Add link** adds another row.

- **Networks:** Website, YouTube, Instagram, Facebook, X, LinkedIn, GitHub, WhatsApp channel, Telegram, Discord, Threads, Reddit, Medium, Hackster.io, Instructables, Thingiverse, Printables, Pinterest, TikTok and Bluesky.
- **Usernames work:** pick a network and type the username ("yourbrand" or "@yourbrand"), and the full link is made for you. Pasting a full link picks the network by itself.
- **On the site:** authors' links appear as logo buttons under their posts and on their author page. The site's links appear as logos in the footer and are given to search engines (Organization `sameAs`).

## Menus

The admin's **Menus** screen sets the menu bar and the footer.

- **Automatic** (the default): the menu bar shows every main category with posts, with its sub-categories in a drop-down, plus Latest. The footer lists the categories and pages.
- **Choose the items myself**: each item has a label and a **Goes to** list (Home, Latest posts, Search, every category, page and tag, Sign in, RSS, or another web address).
  - Items can be moved up and down, removed, or given drop-down items.
  - A drop-down under a category link also shows that category's newest posts.
  - Footer columns work the same way.
- **Safety:** only links starting with `/`, `http://` or `https://` are saved.

## Sponsor banners (Ads)

The admin's **Ads** screen (owner and administrators) places banners sold directly to sponsors, like the DigiKey and Mouser banners on CircuitDigest.

- **Places:** nine places, numbered on small maps of the home, article and category pages, each with the picture size to ask the sponsor for (970 × 90, 728 × 90, 300 × 250, 320 × 100 for phones...).
  1. Top of every page
  2. Home page middle
  3. Sidebar
  4. Category pages
  5. Article top
  6. Article middle
  7. Beside the article
  8. Article end
  9. Bottom of every page
- **A banner** has a picture for computers, an optional one for phones, the link, the places, and optional start and end dates. Banners start and stop by themselves, and several banners in one place take turns.
- **On/off switches:**
  - **Ads on your blog** (top of the Ads screen) turns every banner and empty box off at once.
  - Each **place** has its own switch, and a place that's off stays empty even when banners are set to show there.
  - Each **banner** has its own switch.
  - Switching something off deletes nothing.
- **Counting:** views (half the banner on screen) and clicks are counted per day, with no cookies. Bots don't count.
- **Empty places** show a "Your brand here" box with the size, linking to your "Advertise with us" page. Choose "Hide them" on the Ads screen to show nothing instead.
- **Ad blockers:** banners are served from the blog itself: pictures uploaded on the Ads screen get plain file names, class names avoid the words blocker lists hide, and no outside scripts load. The usual blocker lists leave them alone, though nothing is guaranteed against every blocker.
- **Labelling:** every banner shows a "Sponsored" label, and its link is `rel="nofollow"`, as Google asks for paid links.
- **Code:** `src/store/ads.js` (places and data) and `src/web/slots.js` (the HTML). The counter endpoint is `POST /k`.

## Newsletter

**Admin > Newsletter** has three tabs:

- **Newsletters:** write one (subject, preview line, a short Markdown message, and up to 12 posts shown as cards), preview it, send yourself a test, then send it to every subscriber.
  - Sending runs in the background, a few emails at a time (`MAIL_DELAY_MS` apart), over a pooled connection. The email is rendered once, and each recipient is marked "sending" before the email goes out, so a crash or restart can never send anyone a second copy. Someone who was mid-send at that moment is shown as failed ("may or may not have arrived") and can be sent again with **Try again**.
  - Each recipient is checked again just before their email, so someone who unsubscribes during a send is not mailed.
  - A problem with one recipient never stops the send. An address the server refuses for good (or a stored address that no longer passes the check) fails at once; a "try later" answer gets up to three attempts. Only trouble that is not about one recipient (the server is down, the login is wrong, a security or relay refusal that applies to everyone) counts: five of those in a row stop the send and show the reason. **Try again** gives the failed ones another three tries.
  - Only one newsletter is sent at a time, and **Try again** does nothing while a send is running. The database also records which copy of the blog is sending, so a second copy on the same data folder waits instead of mailing the same people twice. Run only one copy of the blog per data folder.
  - A newsletter left in "sending" when the blog starts is picked up again. If email isn't set up, the Site URL is a local address, or `RESUME_NEWSLETTERS=0` is set, it is shown as stopped with the reason, and you can use **Try again** or delete it.
  - Error messages show only the reply code from the mail server, not its text or any address, in the admin and in the server log.
  - Nothing is sent while the Site URL is still a local address, because the unsubscribe links would not work.
- **Subscribers:** search, filter, add one address or paste a whole list, unsubscribe, remove, export CSV.
  - **Double opt-in:** the signup box (and creating a reader account with the newsletter box ticked) adds the address as *pending* and emails a link; the person clicks the button on the page it opens to confirm (a plain link visit never confirms, because mail scanners open links). The page always says "Check your inbox to confirm.", whatever the address. Pending addresses are never mailed. Unconfirmed ones expire after 7 days.
  - Addresses you add or paste in the admin are active at once (you vouch for them). An unsubscribed address is never reactivated by a signup or a paste; only **Resubscribe** in the admin, or the person's own unsubscribe page, brings it back.
- **Email settings:** the signup box text, the sender name and address, and the email service (SMTP). Pick Zoho, Brevo, Gmail, Hostinger or Amazon SES and the server details fill in. **Save and send me a test email** checks the connection. Only the owner can change the server settings.

Every email has the subscriber's own unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers, so Gmail and Outlook show their own one-click unsubscribe button. The link opens `/unsubscribe/<code>/`, where a POST unsubscribes without a form token (the private code is the proof). New codes are keyed (made from a secret only the server has) and are accepted for the year they were made and the next; older random codes in emails already sent keep working and are stored only as hashes. Every unsubscribe is also added, as a SHA-256 of the lower-cased address, to `<DATA_DIR>/suppression-list.txt`; at start-up anyone on that list is marked unsubscribed again, so restoring an older database can't bring an opt-out back. The SMTP password is never shown in the admin or passed to templates, and is stored encrypted (see `APP_SECRET` below).

**Pinning the mail server in the environment (recommended):** set `SMTP_HOST` (and `SMTP_PORT`, `SMTP_USER`, `SMTP_SECURE`=`ssl` or `starttls`) and the blog uses exactly those, whatever is saved in the admin; the matching fields show as locked. `SMTP_PASSWORD` is used **only** together with `SMTP_HOST`, so the password can never be sent to a server somebody typed into the admin. Without `SMTP_HOST`, `SMTP_PASSWORD` is ignored and the password saved under Email settings is used. Mail servers on a private, loopback or link-local address (`localhost`, `10.x`, `192.168.x`, `169.254.x`, `*.local`...) are refused unless you set `ALLOW_PRIVATE_SMTP=1`.

## Analytics and search engines

**Admin > Analytics & SEO** is one page for everything that connects the blog to outside services, each with step-by-step instructions:

- **Visitor numbers without cookies:** Umami or Plausible. Paste the tracking code they give you; the blog reads the script address and site ID, adds the tag to public pages (never to the admin or previews), and allows exactly that service in the Content-Security-Policy. Plausible's newer `pa-….js` scripts and their setup line are supported.
- **Google Search Console** and **Bing Webmaster Tools** verification codes (paste the whole meta tag or just the code), plus Yandex, Pinterest and Facebook.
- **IndexNow** switch and a button that sends every public page. Pings skip pages marked noindex or with a canonical address elsewhere (decided when the change is made; a page that was announced and is then switched to noindex gets one more ping so search engines look again), are not sent for a site on a local or private address, never follow a redirect, give up after 10 seconds, go out in batches of 10,000, send the same address at most once every 10 minutes (at most 50,000 a day) and run in the background. Posts that go live while the server is off are announced when it starts again.
- **AI training crawlers:** allow or block in robots.txt.

## SEO and AEO built in

- **Server-rendered HTML** that crawlers and AI engines read without JavaScript.
- **Head tags:**
  - title (with the site name when it fits in 60 characters), meta description and canonical
  - robots tags (`max-image-preview:large` and friends)
  - Open Graph and Twitter cards
- **Social images:** a 1200×630 image generated for every post, category, tag and author.
- **JSON-LD** in one `@graph` per page:
  - **Posts:** BlogPosting with commentCount, VideoObject with chapter clips, SoftwareSourceCode for the source files, BreadcrumbList, Person and Organization.
  - **Lists:** CollectionPage with an ItemList.
  - **Author pages:** ProfilePage.
  - **Every page:** WebSite.
- **No FAQPage or HowTo markup**, on purpose: Google no longer shows those for sites like this.
- **Answer-first articles:** a quick answer box with at-a-glance rows, a contents list, stable heading anchors, and FAQ sections as plain headings.
- **Discovery files:**
  - `sitemap.xml` with lastmod and image entries
  - RSS for the whole site and per category
  - `robots.txt` that keeps out the admin, account and search pages, with a setting for AI training crawlers
- **IndexNow and verification:** a key file and automatic pings, plus Google, Bing and other verification tags from Analytics & SEO.
- **Speed:**
  - CSS and JS inline, fonts self-hosted and preloaded
  - responsive AVIF/WebP pictures, a YouTube facade
  - rendered pages cached in memory
- **Accessibility:** WCAG AA contrast in light and dark, visible focus rings, a skip link, and keyboard-friendly menus.

## Configuration

**Settings** in the admin holds the site's content settings:

- title, domain, logo, and links to the Menus page
- business details (the town, phone and emails show in the footer contact column; the business name in the copyright line; the full address goes to search engines as the Organization's legal name and address, and into newsletter footers)
- social links and calls to action
- comments and accounts, and the News category

Newsletter and email sending live under **Newsletter > Email settings**; analytics, verification codes and crawler rules under **Analytics & SEO**. Pages whose address mentions privacy, terms, cookies or policy go in the footer's bottom line next to RSS and Sitemap (privacy, terms, cookies first), whatever the menu setting. The automatic columns list the categories, and the other pages under **Company**, A to Z by short title. The footer Contact column shows only the town (city, state, country), phone and emails. Pages with the address `contact` and `about` (or `contact-us`, `about-us`) get their own layouts (`views/public/page-contact.njk`, `page-about.njk`):

- **Contact:** a header band, then Email, Call and Visit cards (the full address and a Google Maps link), filled from Business details. Help tiles link to the Latest posts, Advertise and Privacy Policy pages, followed by the social profiles. The page text, if any, shows under the tiles.
- **About:** a header band with buttons, then topic cards from the top-level categories. The page text is the story, with a Quick facts box from Business details beside it, and an app box with the download button.

- **Advertise** (`advertise`, `advertising` or `advertise-with-us`, in `page-advertise.njk`):
  - a header band with an "Ask for the rate card" email button, then three reasons to advertise;
  - **page maps** with numbered banner places, and a card per place with its sizes for computers and phones, taken from the ad system (places switched off in Admin > Ads are left out);
  - the booking steps, who advertises and the banner rules, then a booking box with email and phone.

- **Legal pages** (any address with privacy, terms, cookie or policy, in `page-legal.njk`):
  - the same header band with the last-updated date, and the page text on a white sheet with numbered sections;
  - a sticky "On this page" list from the page's headings, links to the other legal pages, the contact emails and a "Print or save as PDF" button;
  - printing leaves out the menus, sidebar and footer.

About and Contact get AboutPage and ContactPage structured data. The page summary is the line under the title.

Runtime options are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4100` / `127.0.0.1` | Where the server listens. |
| `BASE_PATH` | (empty) | Serves the blog from a folder instead of the whole domain, e.g. `/blog`. |
| `SITE_URL` | (Settings value) | The site's public address, e.g. `https://example.com`. Wins over the Site URL setting. Set it in production so links in feeds and emails never depend on an editable setting. Newsletters are not sent while the address is a local one. |
| `DATA_DIR` | `./data` | The database, uploaded media, `secret.key` and cached social images. |
| `NODE_ENV` | (production) | The blog runs in **production mode** unless `NODE_ENV=development` or the server is started with `--dev` (`npm run dev` does that). Production caches templates and assets and never shows error details or stack traces. |
| `TRUST_PROXY` | | `1`, `true`, `yes` or `on` behind nginx or Caddy, so client IPs, HTTPS and the host name are read from the proxy's headers. Leave it off when the app is reachable directly: otherwise anyone could fake their address. |
| `PROXY_HOPS` | `1` | How many proxies sit in front of the app (only with `TRUST_PROXY=1`). The visitor's address is the `X-Forwarded-For` entry this many places from the right. |
| `SETUP_TOKEN` | (random) | Needed to create the first owner account. When unset, a random token is made at each start while no owner exists, and printed with the setup link. |
| `APP_SECRET` | (`secret.key`) | 64 hex characters (`openssl rand -hex 32`). The key that encrypts the two-step secrets and the saved email password. When unset, a random key is made once and kept in `DATA_DIR/secret.key`. See "Backups". |
| `MAX_UPLOAD_MB` | `15` | Largest image upload (1 to 500). A value that isn't a number is ignored, with a warning on the owner's dashboard, and the default is used. Download files can be up to 50 MB. Images over 40 megapixels are refused. |
| `ADMIN_HOST` | (empty) | A host name such as `admin.example.com` (no `https://`, no path). When set, the admin answers only on that host, and public pages asked for on it go to the Site URL. Cookies stay tied to the host that set them. Point both names at the same server; the proxy must pass the original `Host` header. Without it, the admin answers on the same host as the site. |
| `HSTS_SUBDOMAINS` | (off) | `1` adds `includeSubDomains` to the HTTPS-only header the blog sends in production. Only turn it on when every sub-domain of your domain is served over HTTPS; browsers remember it for a year. |
| `RESUME_NEWSLETTERS` | (on) | `0` stops newsletters that were sending when the server stopped from carrying on at start-up (you decide with **Try again**). Use it after restoring a backup, so nothing is sent before you have checked the subscriber list. |
| `ALLOW_MIGRATION_DRIFT` | (off) | In production the blog refuses to start if a database update that was already applied has been changed in the code. `1` lets it start anyway (a warning stays on the dashboard). |
| `ALLOW_BACKUP_FAILURE` | (off) | Before a database update the blog saves a copy of the database. In production it refuses to update if that copy can't be saved. `1` lets it update without a copy; use it only once, knowingly. |
| `MAX_CONNECTIONS_PER_IP` | `100` | How many connections one address may hold at once (5 to 1024). Only applied when no proxy is in front; then the proxy should limit. |
| `BLOG_OUTBOUND` | | `0` disables outbound IndexNow pings. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_SECURE` | | Pin the mail server (`SMTP_SECURE` is `ssl` or `starttls`). They win over the saved settings, and the admin shows those fields as locked. |
| `SMTP_PASSWORD` | | The mail password. Used only together with `SMTP_HOST`, so it is never sent to a server chosen in the admin. |
| `ALLOW_PRIVATE_SMTP` | | `1` allows a mail server on a private or loopback address (refused by default). |
| `MAIL_DELAY_MS` | `400` | Pause between newsletter emails, to stay under the email service's rate limit (0 to 60000; anything else uses the default). |

### Production and development

The blog starts in production mode. For work on your own computer use `npm run dev`, or `npm start -- --dev`, or `NODE_ENV=development`. Never run a public site in development mode: it shows stack traces and reloads templates on every request. `npm run seed` and the browser scripts are meant for practice sites.

## Deploying

The step-by-step guide for a Raspberry Pi or VPS with Cloudflare Tunnel, with an install script, is in [deploy/README.md](deploy/README.md). The rest of this section covers other setups.

Any machine that can run Node works: a small VPS, Railway, Render or Fly.io with a persistent disk.

1. Copy the project, then run `npm ci --omit=dev` (not `npm install`, which can rewrite the lockfile).
2. Start it with `TRUST_PROXY=1 SITE_URL=https://blog.example.com SETUP_TOKEN=<random> node server.js` (production is the default), **under a supervisor that restarts it** (systemd with `Restart=always`, pm2, or Docker's restart policy). After an unexpected error the server logs one line, closes the port and exits with code 1 within 5 seconds on purpose; without a supervisor the site stays down until someone starts it. Keep the secrets in the service's environment file, not in a shell history. Run one copy per data folder.
3. Put nginx or Caddy in front for HTTPS and proxy the domain to `127.0.0.1:4100`, as below.
4. Open the setup link the server prints (`/admin/setup`), paste the setup token and create the owner. In Settings, check the Site URL. Then follow the steps on the **Analytics & SEO** page for Google Search Console, Bing and visitor numbers.
5. Back up `APP_SECRET` or `secret.key` (see Backups).

### Reverse proxy

With `TRUST_PROXY=1` the blog believes the proxy's `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` headers. So the proxy must **overwrite** them with what it saw itself, and never pass on what the visitor sent; otherwise anyone could pick their own IP address and get around the sign-in limits. The proxy should also limit the size of request bodies (the app has its own limits too: 64 KB for public forms, 8 MB in the admin, about 51 MB for uploads) and keep the original `Host`.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name blog.example.com;
    # ssl_certificate and ssl_certificate_key go here

    client_max_body_size 52m;          # the largest upload plus a little; the app enforces smaller limits per route

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite: NOT $proxy_add_x_forwarded_for
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

Caddy:

```caddyfile
blog.example.com {
    request_body {
        max_size 52MB
    }
    reverse_proxy 127.0.0.1:4100 {
        header_up X-Forwarded-For {remote_host}   # replaces whatever the visitor sent
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

If there is another proxy or CDN in front of nginx or Caddy (for example Cloudflare), let the inner proxy **append** to `X-Forwarded-For` (nginx: `$proxy_add_x_forwarded_for`), make sure only that CDN can reach it, and set `PROXY_HOPS=2` (one more for each extra proxy you control). Never set `TRUST_PROXY=1` when the app port is reachable without the proxy.

### Backups

What must be saved together:

- `data/blog.db`, and its `blog.db-wal` and `blog.db-shm` files if they exist (the database runs in WAL mode: recent changes live in `-wal` until a checkpoint, so copying `blog.db` alone can lose them or give a damaged copy),
- `data/media/` (uploads),
- `data/suppression-list.txt` (the unsubscribe record, see Newsletter) and, if you use the demo content, `data/demo-seed.json`,
- `data/key-check.txt` (it lets the blog notice when the encryption key doesn't match the database; the blog says so at start-up and on the owner's dashboard),
- `data/secret.key`, or the `APP_SECRET` value. **Without it the saved two-step secrets and the email password can't be read**: everyone with two-step sign-in is locked out until the owner turns it off for them with `npm run user -- reset-2fa`, and the email password must be typed again. Keep this key somewhere separate from the database backup (anyone holding both can read the secrets), but do keep it.

`data/cache/og` (the generated social images) is disposable: leave it out of backups. The blog makes the pictures again when they are asked for, and deletes ones unused for 7 days.

**Backups hold sensitive data** (password hashes, reader and subscriber email addresses, session details). Keep them private: make the folder owner-only (`umask 077` before creating it, or `chmod 700`), and encrypt backups that leave the machine (for example with `age` or `gpg`) or store them on an encrypted disk. Keep `secret.key` somewhere else.

Pick one way:

1. **Stop the server** (`systemctl stop blog`), copy the whole `data/` folder (including `-wal`, `-shm`, `media/` and `secret.key`), start the server. This gives a database and media tree from the same moment.
2. **While running:** make a consistent database copy, then copy the media folder straight afterwards.

   ```bash
   umask 077                                              # backup files readable by you only
   mkdir -p backup && rm -f backup/blog.db
   sqlite3 data/blog.db "VACUUM INTO 'backup/blog.db'"      # or: sqlite3 data/blog.db ".backup backup/blog.db"
   # no sqlite3 program? this does the same with Node:
   node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/blog.db').exec(\"VACUUM INTO 'backup/blog.db'\")"
   rsync -a data/media/ backup/media/
   cp data/secret.key backup-keys/secret.key
   ```

   Uploaded files are never overwritten, so a media copy taken after the database copy holds every file the copy refers to (apart from any deleted in between). The copy has no `-wal` or `-shm` file; it is complete by itself.

### Restoring

1. **Stop the server.** Never restore under a running server. When you start it again after the restore, start it with `RESUME_NEWSLETTERS=0`, so no newsletter that was mid-send is carried on before you have checked the subscriber list.
2. Move the current `data/` folder aside (don't merge into it). Put back `blog.db` from the backup, **delete any `blog.db-wal` and `blog.db-shm` left over from the old database**, put back `media/`, and put back the matching `secret.key` (or start with the same `APP_SECRET`). Starting without the key would make a new one that can't read the old secrets.
3. Run `npm run user -- end-sessions --all`. A restore brings back every session, and every staff and reader sign-in that existed at backup time, including ones that were later ended. This signs everyone out, cancels sign-ins in progress and removes every recovery code (a backup can bring back codes that were already used). If the backup also holds an old authenticator secret for someone, use `npm run user -- reset-2fa`.
4. Check `npm run user -- list`. Anything changed after the backup is back to the old state: staff you suspended or removed, passwords and two-step settings you changed (use `npm run user -- reset you@example.com` and `reset-2fa`, and ask people to set up two-step again), members you blocked or erased, and **people who unsubscribed**. Re-apply those by hand from your notes, and **re-apply the unsubscribes before sending any newsletter**. Keep `data/suppression-list.txt` from before the restore (copy it over the restored one, or merge them): at start-up the blog marks everyone on it unsubscribed again. For anyone who unsubscribed after the backup and isn't on a list you kept, set them to unsubscribed (Admin > Newsletter > Subscribers) from the requests and complaints you received. Sending to someone who has unsubscribed is the one mistake that can't be undone.
5. Start the server (with `RESUME_NEWSLETTERS=0` as said above), open the admin, and check the newest post and a few pictures. If the site looks empty, run `npm run user -- where`: it shows which data folder is in use, and a wrong `DATA_DIR` is the usual reason. Two-step users can't sign in if the blog was started with a different `secret.key` than the database was sealed with; the start-up message and the dashboard say so.

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
assets/css              tokens.css (Copper & Slate), base, site, article, admin, editor
assets/js               site.js (inline on public pages), admin.js, editor.js
assets/vendor           the bundled Toast UI editor (npm run build:editor)
scripts/                seed, user tools, browser checks, editor bundle
test/                   end-to-end tests (app.test.js runs the blog under /blog, site.test.js at the root)
src/product.js          the software's name and version (from package.json), shown in the admin
deploy/                 systemd service, install script, Cloudflare Tunnel example, and the guide to putting a blog online
design/picker/          the design picker the current look was chosen with (open index.html in a browser)
```

## Design

- **Colours:** Copper & Slate. Slate greys with a copper accent (#C2410C) and teal as the second colour, in light and dark. A switch in the header lets readers choose.
- **Fonts:** Inter for text, JetBrains Mono for code, both self-hosted.
- **Layout:**
  - clean header bar with menu panels
  - big story and sidebar home page
  - picture-first articles with a contents and share rail
  - brand-coloured share buttons
  - code in a file list with colours
  - large download buttons and striped tables sized to their content
  - an open comment thread
- **Admin:** laid out like Ghost, with your brand colour for the selected item and the main buttons.
- **No raw HTML:** raw HTML in Markdown is turned off, so a post or comment can never run a script on the site or in the admin.

## Licenses

Quillo itself: GNU AGPL-3.0-or-later (see [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md)). Copyright (C) 2026 Dhyana Engineering Solutions.

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
