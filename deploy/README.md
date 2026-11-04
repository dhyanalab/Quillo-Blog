# Putting a Quillo blog online

The simplest way is a small Linux machine (a Raspberry Pi 4 or 5, or any VPS) with a **Cloudflare Tunnel**: no router changes, and Cloudflare provides HTTPS. Each blog is its own install with its own `data/` folder.

## 1. Copy Quillo to the machine

From your computer (replace the address with your server's, for example its Tailscale address):

```bash
scp quillo.tar.gz you@100.64.0.10:~/
ssh you@100.64.0.10
tar -xzf quillo.tar.gz      # makes ~/quillo
```

## 2. Install it as a service

Node 22.13 or newer must be installed. Then:

```bash
cd ~/quillo
bash deploy/install.sh https://blog.example.com
```

The script installs the packages and writes the settings to `/etc/quillo.env` (see `.env.example` for every option). It then installs `deploy/quillo.service`, so the blog starts at boot and restarts itself if it stops, and shows whether the blog answers.

For a brand-new blog, the last lines show a **setup link and setup token**. Keep them for step 4.

## 3. Connect the address with Cloudflare Tunnel

If the machine already runs a tunnel, add the blog to it as in `deploy/cloudflared-ingress.example.yml`. If not, in the Cloudflare dashboard:

1. Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared, and run the install command it shows on the machine.
2. Add a public hostname: your blog's address, service `HTTP`, URL `127.0.0.1:4100`.

## 4. Create the owner account

Open `https://blog.example.com/admin/setup`, paste the setup token, and create the owner account. Then turn on two-step sign-in (Admin > Your profile).

## Updating

```bash
sudo systemctl stop quillo
cd ~ && tar -xzf quillo-new.tar.gz --exclude='quillo/data'    # new code; your data/ folder stays as it is
cd ~/quillo && npm ci --omit=dev --no-audit --no-fund
sudo systemctl start quillo && sudo journalctl -u quillo -n 15 --no-pager
```

The blog saves a copy of the database in `data/backups/` before applying any database update.

## Useful commands

| What | Command |
| --- | --- |
| Is it running? | `systemctl status quillo` |
| Last messages | `sudo journalctl -u quillo -n 30 --no-pager` |
| Restart | `sudo systemctl restart quillo` |
| Forgot the owner password | `cd ~/quillo && node scripts/user.js reset you@example.com` |
