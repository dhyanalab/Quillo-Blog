# Changelog

All notable changes to Quillo are listed here. Versions follow [Semantic Versioning](https://semver.org/): the first number changes when an update needs action from you, the second for new features, the third for fixes.

## [Unreleased]

## [1.0.0] - 2026-11-04

The first stable release. Every blog owner can now choose their blog's look in the admin.

### Added

- **Admin > Design**: choose how the blog looks, with a live preview of your real home page and an article. The preview switches between light and dark, and between computer and phone sizes. Nothing changes for readers until you press Save, and "Back to the original look" undoes everything.
  - **Colours:** 6 themes: Copper & Slate (the original), Classic Blue, Forest Green, Ocean Teal, Signal Red, and Graphite & Yellow. Each has a light and a dark version, and every one is checked for readable text.
  - **Fonts:** 5 pairs, all self-hosted: Inter (the original), IBM Plex, Plus Jakarta Sans, Manrope with a Source Serif reading text, and Outfit with Nunito. Pages preload only the chosen pair.
  - **Light and dark:** follow each reader's device with a switch (the original), or Light only.
  - **Header:** a clean bar (the original), two rows in news style with a large search box, or a dark bar.
  - **Home page:** big story and sidebar (the original), Magazine, or a three-column Newsroom.
  - **Article page:** picture first (the original), classic with a sidebar, or a centred reading column.
  - **Article parts:**
    - share buttons: brand colours (the original), outline icons, one Share button with a menu, or quiet icons;
    - source code: a file list (the original), a tabbed panel, or a dark editor. Long files show their first lines with Show all;
    - code colours: coloured or plain;
    - downloads: big buttons (the original), a GitHub card with file cards, or a file table;
    - tables: striped (the original), clean lines, or a boxed grid;
    - comments: an open thread (the original) or comment cards.
  - **Admin:** the admin's own look (your brand colour, light grey, or a dark sidebar) and the post editor (Visual with a Markdown switch, Visual only, or Markdown with a preview beside it).
  - **Templates:** 5 ready-made looks (Original, Newsroom, Magazine, Long reads and Workshop). You can also save your own combinations under a name, up to 20, and switch back to them later.

### Changed

Existing blogs keep their look exactly: every default is the original choice. A screenshot comparison of 12 public pages at two widths, in light and dark, found no changed pixels.

### Project

- A `VERSION` file is now the single place the version is kept. `npm run set-version -- x.y.z` updates package.json, the lockfile and the README badge to match, and a test checks they agree.
- The README is now a product page, with a logo, badges, screenshots and quick start. The detailed guides moved to `docs/`: admin guide, configuration, deployment and development.
- `.gitignore` now also covers keys and certificates, packaged copies of a blog (which can hold its database and key), editor and tool folders, and test output.

## [0.10.0] - 2026-11-04

### Added

- White-label: Quillo no longer carries a built-in brand.
  - First-run setup asks for the blog's name, description and time zone (pre-set to the computer's own), and offers a "Powered by Quillo" footer line.
  - New blogs start as "My Blog", with neutral wording and no electronics examples. Empty sponsor boxes stay hidden until the owner asks for them.
  - Settings > Post features: the Source code box, download buttons with a GitHub button, and "Tested with" are switches. They are off on a new blog.
  - Settings: the mark shown when there's no logo (initials or an icon), the region for search engines and social cards, and what the blog calls a post ("Related recipes", "Search the projects").
  - The browser-tab icon follows the mark.
  - Admin > Ads: the Advertise page's three reasons and "Who advertises here" list are editable.
  - `PRODUCT_NAME` lets resellers with a commercial licence show their own product name.

### Fixed

- Time zones: the lists now offer "UTC" and current names such as Asia/Kolkata, which Node's own list lacked. A saved old name shows as its current one.
- The footer year no longer stays on the old year after New Year on a quiet site.

### Changed

Existing blogs keep their look: database update 008 saves their current mark, features, wording, region and Advertise text as settings. Four small phrases are now neutral on every blog:

- "More from …" on the About page;
- "Search the projects" in the search box;
- the search page hint;
- "share your thoughts" under posts without comments.

## [0.9.0] - 2026-11-04

The first versioned release. The project, until now an in-house blog, is renamed **Quillo** and licensed as open source.

### Added

- Name, licence and project files:
  - The project is named Quillo. The admin sidebar shows the version.
  - Licensed under the GNU AGPL-3.0-or-later, with a commercial licence available (LICENSING.md).
  - CHANGELOG.md, SECURITY.md, CONTRIBUTING.md and `.env.example` (every server setting).
  - `deploy/`: a systemd service, an install script and a Cloudflare Tunnel example.
  - `design/picker/`: the design picker the current look was chosen with.
- Blog platform:
  - The public site is laid out like CircuitDigest: a big story and sidebar home page, picture-first articles, category pages, search, RSS and a sitemap.
  - A Ghost-style admin with a visual editor and a Markdown switch, autosave, revisions, scheduling, a media library, categories and tags, menus, redirects and staff roles (owner, admin, editor, author, contributor).
  - Reader accounts with email verification, and moderated comments with likes.
  - A newsletter with double opt-in, sent through your own SMTP account, with one-click unsubscribe.
  - First-party sponsor banners in 9 places, labelled "Sponsored".
  - Built-in SEO and answer-engine support: structured data, social share images, IndexNow, and cookieless analytics (Plausible or Umami).
  - Source code boxes, STL and PDF downloads, and a GitHub button for project posts.

### Security

Three security audits, with fixes after each:

- Two-step sign-in, with recovery codes and known-browser protection.
- Staff rank rules enforced in the data layer.
- Rate limits that survive restarts.
- Protected `__Host-` cookies, and HMAC tokens on every form.
- A strict Content Security Policy with no inline styles or scripts on public pages.
- Encrypted secrets with a key check.
- Upload checks with linear-time SVG scanning, and limits on Markdown output.
- Request body limits that depend on sign-in.
- Every dependency pinned exactly, with DOMPurify 3.4.17, and `npm audit` clean.

[Unreleased]: https://github.com/dhyanalab/Quillo-Blog/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dhyanalab/Quillo-Blog/compare/v0.10.0...v1.0.0
[0.10.0]: https://github.com/dhyanalab/Quillo-Blog/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/dhyanalab/Quillo-Blog/releases/tag/v0.9.0
