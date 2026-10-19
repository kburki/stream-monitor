const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load configuration
// ---------------------------------------------------------------------------
// config.json lives next to this script and is NOT checked into git (see
// .gitignore) because it contains a live Slack webhook URL. Copy
// config.example.json to config.json and fill in your own values.
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------
// We track alert/retry status independently for each stream so one stream
// failing doesn't affect the others.
//   alertSent   - true once we've sent the initial "down" Slack message
//   retryCount  - how many 1-minute retries we've done since the alert
//   inRetryMode - true while we're actively retrying every minute
//   gaveUp      - true once we've exhausted retries and stopped retrying
//                 every minute (we fall back to the normal 10-min cycle,
//                 but will still send a "recovered" message if it comes back)
const streamStates = {};
config.streams.forEach(stream => {
  streamStates[stream.name] = {
    alertSent: false,
    retryCount: 0,
    inRetryMode: false,
    gaveUp: false
  };
});

// ---------------------------------------------------------------------------
// Status file for the web UI
// ---------------------------------------------------------------------------
// The web UI runs as a separate process, so it can't see this script's
// in-memory state directly. Instead, after every single stream check we
// write the latest per-stream status (OK/FAIL, when, why) out to status.json
// next to config.json. The web UI just reads this file when asked — it's
// not sensitive data, but is gitignored anyway since it's runtime output,
// not source.
const STATUS_PATH = path.join(__dirname, 'status.json');
const statusData = { streams: {}, lastCycleCompletedAt: null };

function writeStatusFile() {
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(statusData, null, 2));
  } catch (err) {
    console.error(`Could not write status.json: ${err.message}`);
  }
}

function recordStreamStatus(name, info) {
  statusData.streams[name] = { ...info, updatedAt: new Date().toISOString() };
  writeStatusFile();
}

// ---------------------------------------------------------------------------
// Paused streams
// ---------------------------------------------------------------------------
// Lets you take a stream (e.g. a seasonal RTSP camera) out of the check
// rotation without editing config.json or restarting the process — handy
// for something like seasonal cameras that only run part of the year, so you're
// not re-adding/removing config entries each time. paused.json is just a
// plain array of stream names, written by the web UI's pause/resume button.
// We re-read it fresh at the start of every check cycle (and every retry
// cycle) rather than caching it, so a pause/resume from the web UI takes
// effect on the very next cycle without needing to restart this process.
const PAUSED_PATH = path.join(__dirname, 'paused.json');

function loadPausedStreams() {
  try {
    const raw = fs.readFileSync(PAUSED_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    // Missing file (nothing paused yet) or unreadable — treat as "nothing
    // paused" rather than crashing the monitor over it.
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Slack notifications
// ---------------------------------------------------------------------------
// Posts a plain-text message to the Slack Incoming Webhook configured in
// config.json. Fire-and-forget: logs errors but doesn't retry or throw.
function sendSlackAlert(message) {
  const payload = JSON.stringify({ text: message });
  const url = new URL(config.slackWebhook);
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, (res) => {
    console.log(`Slack response: ${res.statusCode}`);
  });
  req.on('error', (e) => console.error(`Slack error: ${e.message}`));
  req.write(payload);
  req.end();
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------
// All log lines and Slack messages use Alaska local time regardless of what
// timezone the machine running this script is actually in.
function formatTime(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/Anchorage',
    dateStyle: 'short',
    timeStyle: 'medium'
  });
}

// ---------------------------------------------------------------------------
// Check a single stream
// ---------------------------------------------------------------------------
// Runs ffmpeg against the stream URL for ~30 seconds with silencedetect
// enabled, watches its stderr output for connection problems or silence
// events, then updates alert/retry state and sends Slack messages as needed.
// Resolves once the check (and any resulting Slack call) has been kicked off.
function checkStream(stream) {
  return new Promise((resolve) => {
    const state = streamStates[stream.name];
    const now = new Date();
    console.log(`[${stream.name}] Checking at ${formatTime(now)}...`);

    let silenceDetected = false;
    let connectionFailed = false;
    let connected = false;

    // RTSP streams (e.g. local/networked cameras) don't understand the
    // HTTP-style -reconnect flags below, and are prone to dropping over UDP
    // (ffmpeg's default RTSP transport) when going through NAT/port
    // forwarding. For rtsp:// URLs we swap the reconnect flags out for
    // -rtsp_transport tcp instead, which is far more reliable in practice.
    const isRtsp = stream.url.toLowerCase().startsWith('rtsp://');
    const transportArgs = isRtsp
      ? ['-rtsp_transport', 'tcp']
      : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];

    // -t 30 caps how long ffmpeg will read the stream. -af silencedetect
    // flags periods of near-silence in the audio (used as a proxy for "dead
    // air"). -f null '-' means "decode but don't write any output file" —
    // we only care about the stderr log lines.
    const ffmpeg = spawn('ffmpeg', [
      ...transportArgs,
      '-t', '30',
      '-i', stream.url,
      '-af', `silencedetect=noise=${stream.noiseLevel}:d=5`,
      '-f', 'null',
      '-'
    ]);

    // Safety-net timeout in case ffmpeg hangs and never exits on its own.
    const timeout = setTimeout(() => {
      ffmpeg.kill();
    }, 35000);

    // ffmpeg writes all of its progress/status info to stderr (not stdout),
    // so we scan that stream for the substrings we care about.
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();

      // Presence of an audio stream / "Stream #0" line means ffmpeg
      // successfully connected and started reading the stream.
      if (output.includes('Audio:') || output.includes('Stream #0')) {
        connected = true;
      }
      // Common ffmpeg error strings indicating we couldn't reach the stream
      // at all (as opposed to connecting but finding silence).
      if (output.includes('Connection refused') ||
          output.includes('No route to host') ||
          output.includes('Failed to open') ||
          output.includes('404 Not Found') ||
          output.includes('403 Forbidden')) {
        connectionFailed = true;
      }
      // silencedetect filter emits "silence_start" when audio drops below
      // the noise threshold for the configured duration, and "silence_end"
      // when it picks back up.
      if (output.includes('silence_start')) {
        silenceDetected = true;
        console.log(`[${stream.name}] Silence detected`);
      }
      if (output.includes('silence_end')) {
        silenceDetected = false;
        console.log(`[${stream.name}] Audio present`);
      }
    });

    ffmpeg.on('close', () => {
      clearTimeout(timeout);
      const checkTime = new Date();
      // A check counts as failed if we couldn't connect at all, never saw
      // an audio stream, or silence was still active when ffmpeg exited.
      const failed = connectionFailed || !connected || silenceDetected;

      if (failed) {
        console.log(`[${stream.name}] FAIL — ${connectionFailed || !connected ? 'could not connect' : 'silence detected'}`);

        if (!state.alertSent) {
          // First failure we've seen for this stream since it was last OK:
          // send the initial "down" alert and enter retry mode.
          const reason = (connectionFailed || !connected) ? 'Stream Unreachable' : 'Dead Air Detected';
          const detail = (connectionFailed || !connected) ? 'Could not connect to stream.' : 'Silence detected during check.';
          sendSlackAlert(`:red_circle: *${stream.name} — ${reason}*\n${detail} Detected at ${formatTime(checkTime)}. Will retry every minute for up to ${config.maxRetries} attempts.`);
          state.alertSent = true;
          state.inRetryMode = true;
          state.retryCount = 0;
          state.gaveUp = false;
        } else if (state.inRetryMode) {
          // Already alerted and actively retrying — bump the retry counter.
          state.retryCount++;
          console.log(`[${stream.name}] Retry ${state.retryCount}/${config.maxRetries}`);
          if (state.retryCount >= config.maxRetries) {
            // Used up all retries without recovery: stop the fast 1-minute
            // retry loop and fall back to the normal check cycle. We'll
            // still notice (and announce) recovery whenever it happens.
            sendSlackAlert(`:warning: *${stream.name} — Still Down*\nStream has not recovered after ${config.maxRetries} retry attempts. Returning to normal check schedule. Will alert again if status changes.`);
            state.inRetryMode = false;
            state.gaveUp = true;
            console.log(`[${stream.name}] Gave up retrying, returning to normal schedule`);
          }
        }
        // If gaveUp is already true, we do nothing further here — we just
        // wait for the next normal 10-minute cycle to catch a recovery.

      } else {
        // Stream is healthy on this check.
        console.log(`[${stream.name}] OK`);
        if (state.alertSent) {
          // We were previously in an alerted state, so announce recovery.
          // Wording differs slightly depending on whether we caught the
          // recovery during active retries or during the normal cycle
          // (after having given up retrying).
          const recoveryMsg = state.gaveUp
            ? `:large_green_circle: *${stream.name} — Stream Recovered*\nAudio confirmed at ${formatTime(checkTime)} during normal check cycle.`
            : `:large_green_circle: *${stream.name} — Stream Recovered*\nAudio confirmed at ${formatTime(checkTime)}.`;
          sendSlackAlert(recoveryMsg);
        }
        // Fully reset state back to baseline "healthy" status.
        state.alertSent = false;
        state.inRetryMode = false;
        state.retryCount = 0;
        state.gaveUp = false;
      }

      recordStreamStatus(stream.name, {
        status: failed ? 'FAIL' : 'OK',
        reason: failed
          ? ((connectionFailed || !connected) ? 'Could not connect' : 'Silence detected')
          : 'Healthy',
        checkedAt: checkTime.toISOString(),
        inRetryMode: state.inRetryMode,
        gaveUp: state.gaveUp
      });

      resolve({ name: stream.name, failed, inRetryMode: state.inRetryMode });
    });

    // Covers the case where ffmpeg itself couldn't even be spawned
    // (e.g. not installed, bad permissions) rather than a stream-level
    // connection failure.
    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[${stream.name}] FFmpeg error: ${err.message}`);
      recordStreamStatus(stream.name, {
        status: 'FAIL',
        reason: `FFmpeg error: ${err.message}`,
        inRetryMode: state.inRetryMode,
        gaveUp: state.gaveUp
      });
      resolve({ name: stream.name, failed: true, inRetryMode: state.inRetryMode });
    });
  });
}

// ---------------------------------------------------------------------------
// Full check cycle — every stream, one at a time
// ---------------------------------------------------------------------------
// Runs on the normal schedule (config.checkIntervalMinutes). Sequential
// (await in a for-loop) rather than parallel so we don't hammer the network
// / spawn many ffmpeg processes at once.
async function checkAllStreams() {
  console.log(`\n--- Starting check cycle at ${formatTime(new Date())} ---`);
  const pausedStreams = loadPausedStreams();
  for (const stream of config.streams) {
    if (pausedStreams.has(stream.name)) {
      console.log(`[${stream.name}] Paused — skipping check`);
      // Reset alert/retry state so that if it's still down whenever it gets
      // resumed, it's treated as a fresh failure (sends a new alert) rather
      // than silently picking back up mid-retry-count from before the pause.
      const state = streamStates[stream.name];
      state.alertSent = false;
      state.inRetryMode = false;
      state.retryCount = 0;
      state.gaveUp = false;
      recordStreamStatus(stream.name, {
        status: 'PAUSED',
        reason: 'Paused by user',
        checkedAt: new Date().toISOString(),
        inRetryMode: false,
        gaveUp: false
      });
      continue;
    }
    await checkStream(stream);
  }
  statusData.lastCycleCompletedAt = new Date().toISOString();
  writeStatusFile();
  console.log(`--- Cycle complete ---\n`);
}

// ---------------------------------------------------------------------------
// Fast retry cycle — only streams currently flagged as down
// ---------------------------------------------------------------------------
// Runs every config.retryIntervalMinutes (typically 1 minute). Filters down
// to streams whose state.inRetryMode is true, so healthy streams are left
// alone and only get checked on the normal 10-minute cycle.
async function retryFailedStreams() {
  const pausedStreams = loadPausedStreams();
  const failedStreams = config.streams.filter(s => streamStates[s.name].inRetryMode && !pausedStreams.has(s.name));
  if (failedStreams.length === 0) return;
  console.log(`\n--- Retry check at ${formatTime(new Date())} (${failedStreams.length} stream(s)) ---`);
  for (const stream of failedStreams) {
    await checkStream(stream);
  }
  console.log(`--- Retry complete ---\n`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log(`Stream Monitor started at ${formatTime(new Date())}`);
console.log(`Checking ${config.streams.length} streams every ${config.checkIntervalMinutes} minutes`);
console.log(`Max retries on failure: ${config.maxRetries} (every ${config.retryIntervalMinutes} minute(s))\n`);

// Run one check immediately on startup rather than waiting for the first
// interval to elapse.
checkAllStreams();

// Normal check cycle: every stream, every config.checkIntervalMinutes.
setInterval(checkAllStreams, config.checkIntervalMinutes * 60 * 1000);

// Fast retry cycle: only streams currently in retry mode, every
// config.retryIntervalMinutes. No-ops (returns immediately) when nothing
// is down.
setInterval(retryFailedStreams, config.retryIntervalMinutes * 60 * 1000);
