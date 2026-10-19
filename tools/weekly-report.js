#!/usr/bin/env node
//
// weekly-report.js
//
// Reads the stream-monitor log, summarizes the past N days (default 7) per
// stream (uptime %, number of outages, total downtime, longest outage), and
// posts the summary to the Slack webhook in config.json.
//
// Usage:
//   node tools/weekly-report.js                      # post last 7 days to Slack
//   node tools/weekly-report.js --dry-run            # print it, don't post
//   node tools/weekly-report.js --days 14            # different window
//   node tools/weekly-report.js --log /path/to.log   # different log file
//
// Intended to be run weekly from cron (see README). Times are Alaska time,
// matching the monitor's own log timestamps.
//
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes('--dry-run');
const DAYS = Number(argValue('--days', 7));
const LOG_PATH = argValue('--log', '/root/.pm2/logs/stream-monitor-out.log');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ---------------------------------------------------------------------------
// Timestamp handling
// ---------------------------------------------------------------------------
// monitor.js logs times as Alaska local time ("8/21/26, 11:48:04 AM"). We
// parse those into plain Date objects built from the same wall-clock numbers,
// and compute "now" the exact same way, so every comparison is apples to
// apples no matter what timezone this machine is set to.
function parseTimestamp(str) {
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [, month, day, year, hour, minute, second, ampm] = m;
  hour = parseInt(hour, 10);
  if (/pm/i.test(ampm) && hour !== 12) hour += 12;
  if (/am/i.test(ampm) && hour === 12) hour = 0;
  return new Date(2000 + parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hour, parseInt(minute, 10), parseInt(second, 10));
}

function alaskaNow() {
  const str = new Date().toLocaleString('en-US', {
    timeZone: 'America/Anchorage',
    dateStyle: 'short',
    timeStyle: 'medium'
  });
  return parseTimestamp(str);
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(d) {
  return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const MAX_OUTAGES_LISTED = 8;   // per stream, so a very bad week doesn't flood Slack

function fmtStamp(d) {
  return d.toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtOutageLine(o) {
  if (!o.end) return `• ${fmtStamp(o.start)} → *still down* (${fmtDuration(o.ms)} so far)`;
  const sameDay = o.start.toDateString() === o.end.toDateString();
  const endStr = sameDay
    ? o.end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
    : fmtStamp(o.end);
  return `• ${fmtStamp(o.start)} → ${endStr} (${fmtDuration(o.ms)})`;
}

function fmtDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return '0m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Parse the log into per-stream events
// ---------------------------------------------------------------------------
// Each event: { ts: Date, type: 'OK' | 'FAIL' | 'PAUSED' }
// OK/FAIL take their time from the stream's most recent "Checking at" line.
// PAUSED lines carry no time of their own, so they use the cycle start time.
const PREFIX_RE = /^\d+\|[\w-]+\s*\|\s?/;                      // pm2 live-tail prefix, if present
const CYCLE_RE = /^--- Starting check cycle at (.+?) ---$/;
const CHECKING_RE = /^\[(.+?)\] Checking at (.+?)\.\.\.$/;
const OK_RE = /^\[(.+?)\] OK$/;
const FAIL_RE = /^\[(.+?)\] FAIL/;
const PAUSED_RE = /^\[(.+?)\] Paused/;

function parseLog(text) {
  const events = {};        // stream -> [events]
  const lastCheck = {};     // stream -> Date
  let cycleStart = null;
  let earliest = null;

  const push = (name, ts, type) => {
    if (!ts) return;
    (events[name] = events[name] || []).push({ ts, type });
    if (!earliest || ts < earliest) earliest = ts;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(PREFIX_RE, '').trim();
    if (!line) continue;
    let m;
    if ((m = line.match(CYCLE_RE))) { cycleStart = parseTimestamp(m[1]); continue; }
    if ((m = line.match(CHECKING_RE))) { lastCheck[m[1]] = parseTimestamp(m[2]); continue; }
    if ((m = line.match(OK_RE))) { push(m[1], lastCheck[m[1]], 'OK'); continue; }
    if ((m = line.match(FAIL_RE))) { push(m[1], lastCheck[m[1]], 'FAIL'); continue; }
    if ((m = line.match(PAUSED_RE))) { push(m[1], cycleStart, 'PAUSED'); continue; }
  }
  return { events, earliest };
}

// ---------------------------------------------------------------------------
// Summarize one stream over [windowStart, windowEnd]
// ---------------------------------------------------------------------------
function summarize(evts, windowStart, windowEnd, intervalMs) {
  // Walk the whole history so we know whether an outage was already in
  // progress when the window began, then clip outages to the window.
  const outages = [];
  let downSince = null;
  for (const e of evts) {
    if (e.type === 'FAIL') {
      if (!downSince) downSince = e.ts;
    } else if (downSince) {              // OK or PAUSED ends an outage
      outages.push({ start: downSince, end: e.ts });
      downSince = null;
    }
  }
  if (downSince) outages.push({ start: downSince, end: null }); // still down

  let outageCount = 0, downMs = 0, longestMs = 0, stillDown = false;
  const outageList = [];
  for (const o of outages) {
    const s = o.start < windowStart ? windowStart : o.start;
    const endRaw = o.end || windowEnd;
    const e = endRaw > windowEnd ? windowEnd : endRaw;
    if (e <= s) continue;
    outageCount++;
    const d = e - s;
    downMs += d;
    if (d > longestMs) longestMs = d;
    if (!o.end) stillDown = true;
    outageList.push({ start: o.start, end: o.end, ms: (o.end || windowEnd) - o.start });
  }

  const inWindow = evts.filter(e => e.ts >= windowStart && e.ts <= windowEnd);
  const okChecks = inWindow.filter(e => e.type === 'OK').length;
  const failChecks = inWindow.filter(e => e.type === 'FAIL').length;
  const pausedChecks = inWindow.filter(e => e.type === 'PAUSED').length;
  const totalChecks = okChecks + failChecks;

  // Uptime is time-based, not check-based: during an outage the monitor runs
  // extra once-a-minute retry checks, which would make outages look worse
  // than they were if we simply counted OK vs FAIL. Paused cycles are logged
  // once per normal check interval, so they're subtracted from the window.
  const monitoredMs = (windowEnd - windowStart) - pausedChecks * intervalMs;
  const uptimePct = totalChecks && monitoredMs > 0
    ? Math.max(0, Math.min(100, (1 - downMs / monitoredMs) * 100))
    : null;

  return { totalChecks, pausedChecks, uptimePct, outageCount, downMs, longestMs, stillDown, outageList };
}

// ---------------------------------------------------------------------------
// Build the Slack message
// ---------------------------------------------------------------------------
function buildMessage(streamNames, events, earliest, windowStart, windowEnd, intervalMs) {
  const lines = [];
  lines.push(`:bar_chart: *Weekly stream report* — ${fmtDate(windowStart)} to ${fmtDate(windowEnd)} (Alaska time)`);
  if (earliest) {
    lines.push(`_Note: the log only goes back to ${fmtDateTime(earliest)}, so this covers a shorter period._`);
  }
  lines.push('');

  for (const name of streamNames) {
    const s = summarize(events[name] || [], windowStart, windowEnd, intervalMs);

    if (s.totalChecks === 0) {
      const why = s.pausedChecks > 0 ? 'paused all week' : 'no checks recorded';
      lines.push(`:white_circle: *${name}* — ${why}`);
      continue;
    }

    const emoji = s.outageCount === 0 ? ':large_green_circle:'
      : (s.uptimePct >= 99 ? ':large_yellow_circle:' : ':red_circle:');
    let text = `${emoji} *${name}* — ${s.uptimePct.toFixed(2)}% uptime`;
    if (s.outageCount === 0) {
      text += ', no outages';
    } else {
      text += `, ${s.outageCount} outage${s.outageCount === 1 ? '' : 's'}, ${fmtDuration(s.downMs)} total down, longest ${fmtDuration(s.longestMs)}`;
    }
    if (s.stillDown) text += ' — *still down*';
    if (s.pausedChecks > 0) text += ` _(paused for part of the week)_`;
    lines.push(text);

    const shown = s.outageList.slice(0, MAX_OUTAGES_LISTED);
    for (const o of shown) lines.push(`      ${fmtOutageLine(o)}`);
    if (s.outageList.length > shown.length) {
      lines.push(`      _…and ${s.outageList.length - shown.length} more_`);
    }
  }

  lines.push('');
  lines.push('_Downtime is estimated from the check schedule (first failed check to next good check), so it can be off by up to one check interval per outage._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post to Slack
// ---------------------------------------------------------------------------
function postToSlack(webhook, message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text: message });
    const url = new URL(webhook);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`Slack returned ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`Log file not found: ${LOG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const { events, earliest } = parseLog(fs.readFileSync(LOG_PATH, 'utf8'));

  const windowEnd = alaskaNow();
  let windowStart = new Date(windowEnd.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const intervalMs = (config.checkIntervalMinutes || 10) * 60 * 1000;
  // If the log doesn't reach back a full window, only count the time it covers.
  const logStartNote = earliest && earliest > windowStart ? earliest : null;
  if (logStartNote) windowStart = earliest;

  // Report on every stream in config.json, in config order, so a stream with
  // no log lines still shows up rather than silently vanishing.
  const streamNames = config.streams.map(s => s.name);
  const message = buildMessage(streamNames, events, logStartNote, windowStart, windowEnd, intervalMs);

  if (DRY_RUN) {
    console.log(message);
    return;
  }
  await postToSlack(config.slackWebhook, message);
  console.log(`Weekly report posted to Slack at ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error(`Weekly report failed: ${err.message}`);
  process.exit(1);
});
