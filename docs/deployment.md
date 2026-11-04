# Deployment, backups and restoring

The step-by-step guide for a Raspberry Pi or a VPS with Cloudflare Tunnel is in [deploy/README.md](../deploy/README.md). This page covers other setups, reverse proxies, backups and restoring.

## Other setups

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
