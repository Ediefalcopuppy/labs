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

The repository ships the system-level `habitat.service` and `openclaw.service` units only. The Kepler clock listener runs inside `habitat.service`; there is no separate clock service or systemd user unit.

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

## Kepler live clock operations

### Registration tokens stay separated

`KEPLER_PLANET_TOKEN` is the bearer token Habitat uses only to register or upgrade a habitat with Kepler. Kepler returns a different, habitat-specific stream token during registration. Habitat stores that stream token in the `habitat_registration_secrets` table in `.habitat/habitat.sqlite`, separately from the public habitat state, and the dashboard never receives it.

Do not put either token in the stream URL, browser code, command arguments, or service logs. The general `habitat status` command intentionally shows complete registration details, including the stream token, for a local operator; treat its output as secret and do not redirect it to the journal or paste it into support logs. The clock-specific status and watch commands below are token-free.

The dashboard's Clock Status, Clock Listen On, and Clock Listen Off actions call the same-origin local API with relative paths. The browser does not connect to Kepler or open a WebSocket. In development, Vite proxies `/clock` to `HABITAT_SERVER_URL`; in deployment, serve the dashboard and API through the same trusted origin.

### Local CLI and API controls

Run the CLI from the Habitat checkout. It uses `HABITAT_API_BASE_URL` and defaults to `http://127.0.0.1:3000`:

```bash
bun run src/index.ts clock status
bun run src/index.ts clock listen on
bun run src/index.ts clock listen off
bun run src/index.ts clock watch
bun run src/index.ts --json clock status
bun run src/index.ts --jsonl clock watch
```

The equivalent local HTTP controls are:

```bash
curl -fsS http://127.0.0.1:3000/clock/status
curl -fsS -X POST http://127.0.0.1:3000/clock/listen/on
curl -fsS -X POST http://127.0.0.1:3000/clock/listen/off
curl -fsSN http://127.0.0.1:3000/clock/events
```

`clock status` is a snapshot of the persisted mode, desired listening state, current connection state, latest applied planet tick, recent timestamps and error, and whether manual ticks are allowed. `clock watch` consumes the backend's local Server-Sent Events feed and prints future public tick events; it does not connect to Kepler itself or change listening mode. Pressing Ctrl+C stops only that watch process. Manual ticks are rejected while live listening is enabled, so run `clock listen off` before advancing the simulation manually.

Habitat applies only future notices observed while live listening is enabled; reconnecting resumes from future notices without attempting local catch-up.

### Restart recovery

The desired clock mode is persisted in `.habitat/habitat.sqlite` and is recovered by `habitat.service`:

- With listening off, a restart stays in manual mode and does not open the Kepler stream. After `sudo systemctl restart habitat.service`, `bun run src/index.ts clock status` should report `manual`, listening disabled, disconnected, and manual ticks allowed.
- With listening on, a graceful stop preserves the Kepler/listening intent while closing the active connection. After `sudo systemctl restart habitat.service`, the backend automatically reconnects; `clock status` may briefly report connecting before it reports connected. It resumes from future notices under the no-catch-up policy above.

Use the repository's system service name for both checks:

```bash
sudo systemctl restart habitat.service
sudo systemctl status habitat.service
bun run src/index.ts clock status
```

To verify request activity in the system journal without displaying registration or stream tokens, filter to the backend startup and token-free clock route log lines:

```bash
sudo journalctl -u habitat.service --since "10 minutes ago" --no-pager \
  | grep -E 'Habitat backend listening|\[(request|response)\].*/clock/(status|listen/(on|off)|events)'
```

Do not use the token-bearing general `habitat status` output for journal verification.

Always return the persisted listener to off after testing, including after an on-mode restart check:

```bash
bun run src/index.ts clock listen off
bun run src/index.ts clock status
```

Confirm the final status is manual, listening is disabled, the connection is disconnected, and manual ticks are allowed.

## Why `0.0.0.0` is required

`0.0.0.0` tells the server to bind on every network interface instead of only localhost. That is what lets OpenClaw or another machine reach the Habitat backend over the network.

## Why `.env` and `habitat.sqlite` stay in the checkout

The checkout keeps `.env` and `.habitat/habitat.sqlite` around so local development can be repeated without recreating configuration and state from scratch. They are ignored by Git so the repository does not accidentally capture machine-specific secrets, URLs, or live habitat data.

## Deployed revision

- Git commit: `26dbbc61476f558b011a6aae587e094e930f1e46`

## Server-specific paths

- Habitat checkout: `~/labs/habitat`
- OpenClaw executable: `/usr/local/bin/openclaw`
