# Stream Monitor

Monitors a set of audio/video streams for dead air or connectivity failures
using `ffmpeg`'s `silencedetect` filter, and posts alerts to Slack.

## Requirements

- Node.js (any reasonably recent version)
- `ffmpeg` installed and on `PATH`

## Setup on a new machine

1. Clone this repo.
2. Copy the example config and fill in your real values:
   ```bash
   cp config.example.json config.json
   ```
3. Edit `config.json`:
   - `slackWebhook` — your Slack Incoming Webhook URL (keep this secret —
     it is gitignored and should never be committed)
   - `streams` — name, stream URL, and `noiseLevel` for each stream to watch
   - `checkIntervalMinutes` / `retryIntervalMinutes` / `maxRetries` — timing
4. Run it:
   ```bash
   node monitor.js
   ```

## Running continuously

For a production machine, run this under a process manager so it restarts
on crash/reboot, e.g. with `pm2`:
```bash
pm2 start monitor.js --name stream-monitor
pm2 save
```
or as a `systemd` service.

## Web UI (optional)

A small password-protected web page lets you edit `config.json` (streams,
timings, Slack webhook) and start/stop/restart the monitor from a browser,
instead of editing the file by hand.

Setup:
```bash
cd webui
npm install
cp .env.example .env
# edit .env and set a real ADMIN_PASSWORD
ADMIN_PASSWORD=yourpassword PORT=3000 node server.js
```
Then open `http://localhost:3000` and log in with any username and the
password you set (browser will prompt for HTTP Basic Auth).

**Security note:** HTTP Basic Auth is not encrypted in transit — it's fine
on `localhost` or a trusted private/LAN network, but if you ever expose this
port beyond your own network, put a reverse proxy with HTTPS (e.g. nginx +
Let's Encrypt, or Caddy) in front of it so the password isn't sent in
plaintext. Never commit `webui/.env` — it's already in `.gitignore`.

Saving config in the UI writes straight to `config.json`; you still need to
hit **Restart** (or restart it yourself if running under pm2/systemd) for
the running monitor process to pick up the new values.

The page also shows a **Last check results** panel: after every check,
`monitor.js` writes its per-stream status (OK/FAIL, reason, timing) to
`status.json` next to `config.json`, and the web UI polls that file every
few seconds. This is read-only — it just reflects whatever the running
monitor process last saw, and updates live even if you're not the one who
started/stopped the process.

## Pausing streams

Each stream card has a **Pause/Resume** button. A paused stream is skipped
entirely by the monitor — no ffmpeg check runs, no Slack alerts fire, no
retries happen — until you resume it. This is meant for something like a
seasonal RTSP camera (e.g. only deployed for a few weeks a year for an
event) that you don't want removed from `config.json` and re-added each
time, or a stream you know is down for maintenance and don't want alerts
about while you sort it out.

Under the hood this writes to `paused.json` (gitignored, just a plain list
of stream names) next to `config.json`. `monitor.js` re-reads that file at
the start of every check cycle, so pausing/resuming takes effect on the
**next** cycle — no restart needed. For a currently-failing stream that's
actively retrying every minute, that means within about a minute; for a
healthy stream, within one `checkIntervalMinutes` cycle (10 minutes by
default).

One caveat: pause state is tracked by stream **name**. If you rename a
paused stream and save, it'll show as unpaused under the new name (the old
name just becomes an orphaned, harmless entry in `paused.json`) — repause it
under the new name if that happens.

## Viewing logs

PM2 captures everything the script logs to `~/.pm2/logs/`:
```bash
pm2 logs stream-monitor                # live tail
pm2 logs stream-monitor --lines 200    # last 200 lines instead of just new ones
```
The raw files (useful for grepping/searching without the `pm2 logs` prefix):
```bash
/root/.pm2/logs/stream-monitor-out.log      # normal output
/root/.pm2/logs/stream-monitor-error.log    # uncaught JS errors (should be empty)
```

Find failures and their resolution:
```bash
grep -n "FAIL" /root/.pm2/logs/stream-monitor-out.log
grep -n -E "FAIL|Retry|Gave up|Recovered" /root/.pm2/logs/stream-monitor-out.log
```
Count failures per stream:
```bash
grep -oE "\[.*?\] FAIL" /root/.pm2/logs/stream-monitor-out.log | sort | uniq -c | sort -rn
```

For a full breakdown of outage windows (start/end/duration per stream) rather
than just raw failure lines, use `tools/parse-outages.js`:
```bash
node tools/parse-outages.js /root/.pm2/logs/stream-monitor-out.log
```

## RTSP / camera streams

`rtsp://` URLs (e.g. local network cameras) are detected automatically. For
these, the script uses `-rtsp_transport tcp` instead of the HTTP-style
`-reconnect` flags, since TCP is much more reliable for RTSP through NAT or
port forwarding. Everything else — silence detection, alerting, retries —
works the same way as for HTTP(S) streams, as long as the camera has an
audio track enabled.

## How it works

- Every `checkIntervalMinutes`, each stream is checked in turn: `ffmpeg`
  reads ~30 seconds of the stream and flags silence or connection failures.
- On first failure, a Slack alert is sent and the stream enters a fast
  retry loop (every `retryIntervalMinutes`) for up to `maxRetries` attempts.
- If it recovers, a "recovered" message is sent. If retries are exhausted
  without recovery, a "still down" message is sent and the stream falls
  back to the normal check cycle (it will still announce recovery whenever
  it eventually happens).
