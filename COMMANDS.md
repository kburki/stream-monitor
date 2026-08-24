# Command Reference

Quick reference for day-to-day operation of the KTOO stream monitor. All
commands assume you're SSH'd into the droplet, in `/root/stream-monitor`
unless noted otherwise.

## PM2 — the monitor process

```
pm2 status                          # see if it's running
pm2 logs stream-monitor             # live tail of logs
pm2 logs stream-monitor --lines 200 # last 200 lines instead of just new ones
pm2 restart stream-monitor          # restart (needed after editing monitor.js or config.json)
pm2 stop stream-monitor
pm2 start stream-monitor
pm2 describe stream-monitor         # detailed info, including log file paths
```

## PM2 — the web UI

```
pm2 status                              # stream-monitor-webui shows here too
pm2 logs stream-monitor-webui
pm2 restart stream-monitor-webui        # needed after editing webui/server.js or public/index.html
pm2 stop stream-monitor-webui
pm2 start stream-monitor-webui
```

To (re)start it fresh with the password set inline:
```
cd webui
ADMIN_PASSWORD=yourpassword PORT=3000 pm2 start server.js --name stream-monitor-webui
pm2 save
```

## Reading logs directly

Raw log files (no `pm2 logs` prefix, easier to grep):
```
/root/.pm2/logs/stream-monitor-out.log
/root/.pm2/logs/stream-monitor-error.log
```

Find failures:
```
grep -n "FAIL" /root/.pm2/logs/stream-monitor-out.log
```

Find failures plus retry/recovery context:
```
grep -n -E "FAIL|Retry|Gave up|Recovered" /root/.pm2/logs/stream-monitor-out.log
```

Count failures per stream:
```
grep -oE "\[.*?\] FAIL" /root/.pm2/logs/stream-monitor-out.log | sort | uniq -c | sort -rn
```

## Outage duration parser (tools/parse-outages.js)

Reconstructs start/end/duration of every outage per stream from the log.

```
node tools/parse-outages.js /root/.pm2/logs/stream-monitor-out.log
```

Filter to one stream:
```
node tools/parse-outages.js /root/.pm2/logs/stream-monitor-out.log --stream "KTOO 360TV"
```

Output includes:
- The date range the log file actually covers
- Every outage's start time, end time, and duration per stream
- A totals section: outage count, total downtime, longest single outage per stream

## Pausing a stream (e.g. seasonal cameras)

Easiest way is the Pause/Resume button on each stream card in the web UI —
no restart needed, takes effect within about a minute (if it's actively
retrying) up to one check cycle (if healthy).

You can also do it by hand on the droplet if the web UI isn't up:
```
cat > /root/stream-monitor/paused.json << 'EOF'
["5819NE Cam"]
EOF
```
Put a `[]` in that file (or delete it) to resume everything. Name matching
is exact and case-sensitive — must match the `name` field in `config.json`.

## Web UI access

The web UI (`http://localhost:3000` once tunneled, or `http://64.23.245.75:3000`
directly if your IP is allowed through the firewall) lets you:
- Edit streams, timings, and the Slack webhook (writes to `config.json`)
- See live per-stream status (reads `status.json`, written by the monitor after every check)
- Start/Stop/Restart the actual PM2-managed monitor process

To reach it via SSH tunnel instead of opening the firewall (safer — no
plaintext password over the open internet):

On your Mac, in a fresh terminal (separate from any existing SSH session):
```
ssh -L 3000:localhost:3000 root@64.23.245.75
```
Leave that connected, then visit `http://localhost:3000` in your browser.

## Firewall (ufw) — restricting the web UI to specific IPs

```
ufw status                                          # see current rules
ufw allow from YOUR_IP to any port 3000              # allow one IP
```

Find your current public IP (run from the machine you want to allow, not the droplet):
```
curl ifconfig.me
```

## Git

```
git status                          # see what's changed
git add .                           # stage everything changed
git status                          # confirm config.json / webui/.env are NOT listed
git commit -m "Short description"   # commit staged changes
git push                            # push to GitHub
```

(First-time-only setup — already done — was `git init`, `git remote add origin <url>`,
and `git push -u origin main`.)

## Where things live

```
/root/stream-monitor/monitor.js              the monitor script (PM2: stream-monitor)
/root/stream-monitor/config.json             real config — NOT in git
/root/stream-monitor/config.example.json     sanitized template — in git
/root/stream-monitor/status.json             live status written by monitor.js — NOT in git
/root/stream-monitor/webui/server.js         web UI backend (PM2: stream-monitor-webui)
/root/stream-monitor/webui/.env              real web UI password — NOT in git
/root/stream-monitor/webui/public/index.html web UI frontend
/root/stream-monitor/tools/parse-outages.js  outage log parser
/root/.pm2/logs/stream-monitor-out.log       monitor's log output
```
