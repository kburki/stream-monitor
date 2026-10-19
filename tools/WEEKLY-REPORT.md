# Weekly status report (tools/weekly-report.js)

Reads the monitor log and posts a per-stream summary of the past 7 days to
the same Slack webhook the alerts use: uptime %, number of outages, total
downtime, and longest outage, followed by the date and time of each outage
(up to 8 per stream, then "...and N more"). A stream that is still down is
flagged. Streams paused for part of the week are noted, and paused time is
left out of the uptime math. Every stream in config.json is listed, even if
it has no log lines.

Keep the script inside the tools/ folder. It finds config.json one folder up.
Run these from /root/stream-monitor.

Preview without posting:

    node tools/weekly-report.js --dry-run

Post to Slack right now:

    node tools/weekly-report.js

Options:

    --days 14                  different window (default 7)
    --log /path/to/file.log    different log file
                               (default /root/.pm2/logs/stream-monitor-out.log)

For outage dates across the whole log (not just the past week), use
tools/parse-outages.js instead.

## Sending it automatically every Monday (with pm2)

    cd /root/stream-monitor
    pm2 start tools/weekly-report.js --name weekly-report --cron-restart "0 16 * * 1" --no-autorestart
    pm2 save

- Starting it this way runs the report once immediately, so a report will
  post to Slack right away. After that it runs every Monday at 16:00 on the
  droplet's clock.
- The droplet clock is UTC, so 16:00 is 8:00 AM Alaska daylight time (9:00 AM
  once clocks fall back on Nov 1).
- In pm2 status the job shows as "stopped" between runs. That is normal: it
  runs, posts, and exits. Check pm2 logs weekly-report to see each run.
- To change the schedule, delete it (pm2 delete weekly-report) and start it
  again with a different cron string.

### Alternative: cron

Run crontab -e and add this line. Run "which node" and use that path if it
differs from /usr/bin/node, since cron has a minimal PATH.

    0 16 * * 1 cd /root/stream-monitor && /usr/bin/node tools/weekly-report.js >> /root/weekly-report.log 2>&1

## Good to know

- Downtime is estimated from the check schedule (first failed check to the
  next good check), so each outage can be off by up to one check interval.
- Uptime is time-based, not a count of OK vs FAIL checks, because the
  one-minute retry checks during an outage would otherwise exaggerate it.
- If the log doesn't reach back a full week (for example after a log flush),
  the report says so and covers only the time the log has.
- It reads the Slack webhook from config.json, so no new secrets are needed.
