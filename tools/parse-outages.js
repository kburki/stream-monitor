#!/usr/bin/env node
//
// parse-outages.js
//
// Reads a stream-monitor log file (raw log file, or output copy-pasted from
// `pm2 logs`) and reconstructs outage windows per stream: when each outage
// started (first FAIL after being healthy), when it ended (next OK), and
// how long it lasted.
//
// Usage:
//   node parse-outages.js /root/.pm2/logs/stream-monitor-out.log
//   node parse-outages.js /root/.pm2/logs/stream-monitor-out.log --stream "Stream 2"
//
const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node parse-outages.js <log-file> [--stream "Name"]');
  process.exit(1);
}

const streamFilterIndex = process.argv.indexOf('--stream');
const streamFilter = streamFilterIndex !== -1 ? process.argv[streamFilterIndex + 1] : null;

// pm2 logs (live tail) prefixes each line with "0|stream-m | " — strip that
// if present so this works whether you pasted `pm2 logs` output or pointed
// this at the raw log file directly.
const PREFIX_RE = /^\d+\|[\w-]+\s*\|\s?/;

// Matches "[Stream Name] Checking at 8/21/26, 11:48:04 AM..."
const CHECKING_RE = /^\[(.+?)\] Checking at (.+?)\.\.\.$/;
// Matches "[Stream Name] OK"
const OK_RE = /^\[(.+?)\] OK$/;
// Matches "[Stream Name] FAIL — ..."
const FAIL_RE = /^\[(.+?)\] FAIL/;

// Parses "8/21/26, 11:48:04 AM" (the en-US short/medium format used by
// formatTime() in monitor.js) into a JS Date. We don't need to worry about
// the actual Alaska timezone offset here — we only ever compare timestamps
// against each other, so as long as parsing is consistent, durations come
// out correct.
function parseTimestamp(str) {
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [, month, day, year, hour, minute, second, ampm] = m;
  hour = parseInt(hour, 10);
  if (/pm/i.test(ampm) && hour !== 12) hour += 12;
  if (/am/i.test(ampm) && hour === 12) hour = 0;
  return new Date(2000 + parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hour, parseInt(minute, 10), parseInt(second, 10));
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

const raw = fs.readFileSync(filePath, 'utf8');
const lines = raw.split('\n');

// Per-stream tracking state
const lastCheckTime = {};   // stream -> Date of most recent "Checking at" line
const downSince = {};       // stream -> Date when the current outage started (or undefined if healthy)
const outages = {};         // stream -> array of { start, end, durationMs, ongoing }

// Tracks the earliest and latest timestamp seen anywhere in the log, so we
// can report what date range this file actually covers.
let earliestTs = null;
let latestTs = null;

function ensureStream(name) {
  if (!outages[name]) outages[name] = [];
}

for (const rawLine of lines) {
  const line = rawLine.replace(PREFIX_RE, '').trim();
  if (!line) continue;

  let match;
  if ((match = line.match(CHECKING_RE))) {
    const [, name, tsStr] = match;
    const ts = parseTimestamp(tsStr);
    if (ts) {
      lastCheckTime[name] = ts;
      if (!earliestTs || ts < earliestTs) earliestTs = ts;
      if (!latestTs || ts > latestTs) latestTs = ts;
    }
    continue;
  }

  if ((match = line.match(OK_RE))) {
    const [, name] = match;
    ensureStream(name);
    if (downSince[name]) {
      const end = lastCheckTime[name];
      outages[name].push({
        start: downSince[name],
        end,
        durationMs: end - downSince[name],
        ongoing: false
      });
      delete downSince[name];
    }
    continue;
  }

  if ((match = line.match(FAIL_RE))) {
    const [, name] = match;
    ensureStream(name);
    if (!downSince[name]) {
      downSince[name] = lastCheckTime[name];
    }
    continue;
  }
}

// Any stream still "down" at end of file has an ongoing/unresolved outage
// as of the last line in this log.
for (const name of Object.keys(downSince)) {
  ensureStream(name);
  outages[name].push({
    start: downSince[name],
    end: null,
    durationMs: null,
    ongoing: true
  });
}

if (earliestTs && latestTs) {
  const spanMs = latestTs - earliestTs;
  console.log(`Log covers: ${earliestTs.toLocaleString('en-US')}  ->  ${latestTs.toLocaleString('en-US')}  (${formatDuration(spanMs)})`);
} else {
  console.log('Could not find any timestamped "Checking at" lines in this file.');
}

const streamNames = Object.keys(outages).filter(n => !streamFilter || n === streamFilter);

if (streamNames.length === 0) {
  console.log('No matching streams found in this log.');
  process.exit(0);
}

for (const name of streamNames) {
  const list = outages[name];
  if (list.length === 0) continue;
  console.log(`\n=== ${name} (${list.length} outage${list.length === 1 ? '' : 's'}) ===`);
  for (const o of list) {
    const startStr = o.start ? o.start.toLocaleString('en-US') : '(unknown)';
    if (o.ongoing) {
      console.log(`  ${startStr}  ->  STILL DOWN as of end of log`);
    } else {
      const endStr = o.end.toLocaleString('en-US');
      console.log(`  ${startStr}  ->  ${endStr}   (${formatDuration(o.durationMs)})`);
    }
  }
}

// Summary totals
console.log('\n=== Totals ===');
for (const name of streamNames) {
  const list = outages[name];
  const resolved = list.filter(o => !o.ongoing);
  const totalMs = resolved.reduce((sum, o) => sum + o.durationMs, 0);
  const longest = resolved.reduce((max, o) => Math.max(max, o.durationMs), 0);
  console.log(`${name}: ${resolved.length} resolved outage(s), total downtime ${formatDuration(totalMs)}, longest single outage ${formatDuration(longest)}`);
}
