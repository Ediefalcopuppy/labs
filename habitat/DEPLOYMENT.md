# Deployment

This repository is wired for a simple two-service setup on the same Ubuntu machine:

- Habitat runs as a Bun service.
- OpenClaw runs as a separate systemd service and talks to Habitat through `HABITAT_API_BASE_URL`.

The recommended layout is:

- Habitat listens on `0.0.0.0:3000` so it is reachable outside localhost.
- OpenClaw gets `HABITAT_API_BASE_URL=http://127.0.0.1:3000` when it runs on the same machine.
- If OpenClaw runs on a different machine, point that variable at the reachable host or Tailscale address instead.

## Systemd units

Example unit files are in [`systemd/`](systemd/).

### Habitat

`systemd/habitat.service` starts the backend with:

- `HOST=0.0.0.0`
- `PORT=3000`
- `bun run server`

### OpenClaw

`systemd/openclaw.service` expects an environment file at `/etc/openclaw/habitat.env` and reads:

- `HABITAT_API_BASE_URL`

For the local-machine case, that file can contain:

```ini
HABITAT_API_BASE_URL=http://127.0.0.1:3000
```

## How to install

1. Copy `systemd/habitat.service` to `/etc/systemd/system/habitat.service`.
2. Copy `systemd/openclaw.service` to `/etc/systemd/system/openclaw.service`.
3. Create `/etc/openclaw/habitat.env` with the backend URL OpenClaw should use.
4. Run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now habitat.service
sudo systemctl enable --now openclaw.service
```

If you want to apply changes after editing either unit file:

```bash
sudo systemctl daemon-reload
sudo systemctl restart habitat.service
sudo systemctl restart openclaw.service
```

To verify the services:

```bash
sudo systemctl status habitat.service
sudo systemctl status openclaw.service
journalctl -u habitat.service -f
journalctl -u openclaw.service -f
```

## Why `0.0.0.0` is required

`0.0.0.0` tells the server to bind on every network interface instead of only localhost. That is what lets OpenClaw or another machine reach the Habitat backend over the network.

## Why `.env` and `habitat.sqlite` stay in the checkout

The checkout keeps `.env` and `.habitat/habitat.sqlite` around so local development can be repeated without recreating configuration and state from scratch. They are ignored by Git so the repository does not accidentally capture machine-specific secrets, URLs, or live habitat data.

## Deployed revision

- Git commit: `26dbbc61476f558b011a6aae587e094e930f1e46`

## Server-specific paths

- Habitat checkout: `~/labs/habitat`
- OpenClaw executable: `/usr/local/bin/openclaw`
