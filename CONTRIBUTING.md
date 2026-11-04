# Contributing to Quillo

Thank you for helping. A few rules keep the project healthy and its licensing clear.

## Before you start

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Security problems: don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Working on the code

```bash
npm ci
npm run dev        # http://localhost:4100 and /admin
npm test           # the whole suite must pass before you send a change
```

- Node 22.13 or newer.
- Keep the existing style: ES modules, two-space indent, double quotes, short plain comments.
- No new npm dependency without discussing it first.
- Every behaviour change comes with a test in `test/`.
- Admin screens are for non-technical owners: plain words, point and click, no codes or syntax to type.
- Don't add third-party scripts, trackers or fonts from other servers. Everything a page loads comes from the blog's own address.

## Licence of contributions

Quillo is distributed under the AGPL-3.0-or-later and also under a commercial licence (see [LICENSING.md](LICENSING.md)). By sending a contribution you confirm that:

1. you wrote it, or have the right to submit it;
2. you license it to Dhyana Engineering Solutions under the AGPL-3.0-or-later, and you allow Dhyana Engineering Solutions to also distribute it under the commercial licence.

Add this line to every commit message to confirm it:

```
Signed-off-by: Your Name <you@example.com>
```

(`git commit -s` adds it for you.)
