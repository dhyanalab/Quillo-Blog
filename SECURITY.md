# Security

## Reporting a problem

Please email **info@dhyanalab.in** with "Quillo security" in the subject. Don't open a public issue.

Include what you found, how to reproduce it, and the Quillo version (shown at the bottom of the admin sidebar). We reply within 3 working days and keep you informed until it's fixed. We credit reporters in the release notes unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest release. Update with the steps in [deploy/README.md](deploy/README.md) ("Updating").

## Keeping your blog safe

- Run the latest release, and keep Node up to date.
- Turn on two-step sign-in for every admin (Admin > Your profile > Two-step sign-in).
- Keep the server's port private behind a proxy or tunnel, and set `TRUST_PROXY=1` only then.
- Set `SITE_URL` to your https address.
- Back up `data/` and keep `secret.key` safe and separate (README.md, "Backups").
