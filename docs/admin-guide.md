# Admin guide

How to write, publish and run a Quillo blog from the admin. For server settings see [configuration.md](configuration.md); for putting a blog online, [deployment.md](deployment.md).

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
- **Source code** (Settings > Post features): full code files go in the Source code section below the text, not in the article. Readers get a box after the FAQ and above Downloads. It has one row per file, with copy and download buttons, coloured code, and a ZIP of every file. Short snippets that explain a step can stay in the text.
- **Downloads** (Settings > Post features): a GitHub link plus PDF, STL, 3MF, STEP or ZIP files from the media library, shown as large download buttons. Files are checked by their contents and always served as downloads.
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

## Design

The admin's **Design** screen sets how the blog looks. Administrators and the owner can use it.

- **The preview** on the right shows your real home page and an article, the one with the most parts (code, downloads, a table). Switch it between **Home page** and **Article**, **Light** and **Dark**, and **Computer** and **Phone** sizes. Links in the preview don't open.
- **Nothing changes for readers until you press Save design.** **Back to the original look** sets every choice back to the first one (marked "Original").
- **Colours and type:** 6 colour themes (each with a light and a dark version), 5 font pairs, and Light and dark or Light only.
- **Page layouts:**
  - **Header:** clean bar, two rows in news style, or dark bar.
  - **Home page:** big story and sidebar, Magazine, or Newsroom.
  - **Article page:** picture first, classic with sidebar, or centred reading.
- **Article parts:** share buttons, the source code box, code colours, downloads, tables and comments, each with its own styles.
- **Admin:** the admin's own look and the post editor. These change the admin for everyone on your team.
- **Templates:**
  - Pick **Use** on a ready-made template to fill in its choices, then change anything you like.
  - To keep a combination, type a name under **Save as a template**. Saving doesn't change your blog.
  - You can keep up to 20. Saving with a name you already used replaces that template.
  - Templates don't include the admin look or the editor.

## The home page

The layout is chosen in **Design**. Whichever layout you pick, it is filled in the same way:

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

The admin's **Ads** screen (owner and administrators) places banners you sell directly to sponsors, served from your own site.

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

Every email has the subscriber's own unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers, so Gmail and Outlook show their own one-click unsubscribe button. The link opens `/unsubscribe/<code>/`, where a POST unsubscribes without a form token (the private code is the proof). New codes are keyed (made from a secret only the server has) and are accepted for the year they were made and the next; older random codes in emails already sent keep working and are stored only as hashes. Every unsubscribe is also added, as a SHA-256 of the lower-cased address, to `<DATA_DIR>/suppression-list.txt`; at start-up anyone on that list is marked unsubscribed again, so restoring an older database can't bring an opt-out back. The SMTP password is never shown in the admin or passed to templates, and is stored encrypted (see `APP_SECRET` in [configuration.md](configuration.md)).

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
