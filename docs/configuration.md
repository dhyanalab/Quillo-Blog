# Configuration

What each blog sets in the admin, and the server settings (environment variables). The file [`.env.example`](../.env.example) lists every server setting with a short explanation.

## In the admin and on the server

First-run setup asks for the blog's name, a one-line description, the time zone and whether to show a small "Powered by Quillo" line in the footer. A new blog starts neutral: no topic features, and the blog's initials stand in for a logo.

**Settings** in the admin holds the site's content settings:

- title, domain, logo (or, until there is one, the mark shown instead: the initials or an icon), region and time zone, and links to the Menus page
- what the blog calls a post ("post", "recipe", "project"...), used in phrases such as "Related posts"
- **Post features**, switched on for blogs about making things: a Source code box, download buttons with a GitHub button, and a "Tested with" line. Switched off, they vanish from the editor and from every post; saved content is kept.
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
| `PRODUCT_NAME` | `Quillo` | The software's name in the admin and the optional "Powered by" footer line. For resellers with a commercial licence (see LICENSING.md). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_SECURE` | | Pin the mail server (`SMTP_SECURE` is `ssl` or `starttls`). They win over the saved settings, and the admin shows those fields as locked. |
| `SMTP_PASSWORD` | | The mail password. Used only together with `SMTP_HOST`, so it is never sent to a server chosen in the admin. |
| `ALLOW_PRIVATE_SMTP` | | `1` allows a mail server on a private or loopback address (refused by default). |
| `MAIL_DELAY_MS` | `400` | Pause between newsletter emails, to stay under the email service's rate limit (0 to 60000; anything else uses the default). |

### Production and development

The blog starts in production mode. For work on your own computer use `npm run dev`, or `npm start -- --dev`, or `NODE_ENV=development`. Never run a public site in development mode: it shows stack traces and reloads templates on every request. `npm run seed` and the browser scripts are meant for practice sites.
