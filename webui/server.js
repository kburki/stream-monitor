const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration for the web UI itself (separate from the monitor's config.json)
// ---------------------------------------------------------------------------
// ADMIN_PASSWORD and PORT come from environment variables so the password is
// never hardcoded or committed. Set them when starting the server, e.g.:
//   ADMIN_PASSWORD=changeme PORT=3000 node server.js
// or put them in a .env file (see .env.example) and use a tool like
// `dotenv` / `env-cmd` to load it — kept out of this file to avoid adding
// dependencies you may not want.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;
// The name of the PM2 process to control — must match whatever name you
// used when you originally ran `pm2 start monitor.js --name <this>`.
const PM2_PROCESS_NAME = process.env.PM2_PROCESS_NAME || 'stream-monitor';

if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is not set.');
  console.error('Set it before starting the server, e.g.:');
  console.error('  ADMIN_PASSWORD=yourpassword node server.js');
  process.exit(1);
}

// Path to the monitor's real config.json (one directory up, next to monitor.js)
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
// monitor.js writes this file after every stream check — see monitor.js's
// recordStreamStatus()/writeStatusFile() for what populates it.
const STATUS_PATH = path.join(__dirname, '..', 'status.json');
// The web UI writes this file to tell monitor.js which streams to skip.
// monitor.js re-reads it fresh every check cycle, so pausing/resuming here
// takes effect on the monitor's next cycle without needing a restart.
const PAUSED_PATH = path.join(__dirname, '..', 'paused.json');

// ---------------------------------------------------------------------------
// PM2 process control
// ---------------------------------------------------------------------------
// IMPORTANT: this shells out to the real `pm2` CLI to control the SAME
// process you manage from the terminal with `pm2 start/stop/restart`. It
// does not spawn its own copy of monitor.js — doing that would create a
// second, untracked process running alongside the PM2-managed one, both
// hitting the same streams and potentially double-alerting to Slack.
function runPm2(args) {
  return new Promise((resolve) => {
    execFile('pm2', args, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: (stderr || err.message || '').trim() || 'pm2 command failed.' });
      } else {
        resolve({ ok: true, message: stdout.trim() || 'Done.' });
      }
    });
  });
}

function getStatus() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], (err, stdout) => {
      if (err) {
        resolve({ running: false, found: false, error: 'Could not reach pm2.' });
        return;
      }
      let processes;
      try {
        processes = JSON.parse(stdout);
      } catch {
        resolve({ running: false, found: false, error: 'Could not parse pm2 output.' });
        return;
      }
      const proc = processes.find(p => p.name === PM2_PROCESS_NAME);
      if (!proc) {
        resolve({ running: false, found: false });
        return;
      }
      resolve({
        running: proc.pm2_env.status === 'online',
        found: true,
        status: proc.pm2_env.status,
        restarts: proc.pm2_env.restart_time,
        uptime: proc.pm2_env.pm_uptime
      });
    });
  });
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Simple HTTP Basic Auth gate in front of EVERYTHING — the page itself, its
// JS/CSS, and every /api/* call. Any username works; only the password is
// checked against ADMIN_PASSWORD.
// NOTE: Basic Auth credentials are base64-encoded, not encrypted. This is
// fine for localhost, an SSH tunnel, or a firewall-restricted IP allowlist.
// If you ever expose this beyond a trusted network, put it behind HTTPS
// (e.g. a reverse proxy with a TLS certificate) so the password isn't sent
// in the clear.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Stream Monitor Config"');
    return res.status(401).send('Authentication required.');
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  const password = decoded.slice(separatorIndex + 1);
  if (password !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Stream Monitor Config"');
    return res.status(401).send('Invalid password.');
  }
  next();
}

// Applied globally, BEFORE express.static, so the page itself (not just the
// API calls) requires the password — this is what makes the browser show
// its native login prompt on first visit.
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config endpoints
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: `Could not read config.json: ${err.message}` });
  }
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;

  // Minimal shape validation so a bad save doesn't leave the monitor with
  // an unusable config.json.
  if (
    typeof newConfig !== 'object' ||
    typeof newConfig.slackWebhook !== 'string' ||
    typeof newConfig.checkIntervalMinutes !== 'number' ||
    typeof newConfig.retryIntervalMinutes !== 'number' ||
    typeof newConfig.maxRetries !== 'number' ||
    !Array.isArray(newConfig.streams)
  ) {
    return res.status(400).json({ error: 'Config is missing required fields or has the wrong types.' });
  }
  for (const stream of newConfig.streams) {
    if (!stream.name || !stream.url || !stream.noiseLevel) {
      return res.status(400).json({ error: 'Every stream needs a name, url, and noiseLevel.' });
    }
  }

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not write config.json: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Monitor process control endpoints
// ---------------------------------------------------------------------------
app.get('/api/monitor/status', async (req, res) => {
  res.json(await getStatus());
});

app.get('/api/monitor/last-status', (req, res) => {
  try {
    const raw = fs.readFileSync(STATUS_PATH, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    // Most common cause: the monitor hasn't completed its first check yet
    // since being started, so status.json doesn't exist. Not an error.
    res.json({ streams: {}, lastCycleCompletedAt: null });
  }
});

// ---------------------------------------------------------------------------
// Pause/resume individual streams
// ---------------------------------------------------------------------------
// A paused stream is skipped by the monitor entirely — no ffmpeg check, no
// alerts, no retries — until resumed. Useful for seasonal streams (e.g. a
// camera that's only online part of the year) so you don't have to remove
// and re-add it from config.json every time.
function loadPaused() {
  try {
    const arr = JSON.parse(fs.readFileSync(PAUSED_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function savePaused(list) {
  fs.writeFileSync(PAUSED_PATH, JSON.stringify(list, null, 2));
}

app.get('/api/paused', (req, res) => {
  res.json({ paused: loadPaused() });
});

app.post('/api/paused', (req, res) => {
  const { name, paused } = req.body;
  if (typeof name !== 'string' || !name || typeof paused !== 'boolean') {
    return res.status(400).json({ error: 'Body must include a stream "name" and a boolean "paused".' });
  }
  let list = loadPaused();
  if (paused) {
    if (!list.includes(name)) list.push(name);
  } else {
    list = list.filter(n => n !== name);
  }
  try {
    savePaused(list);
    res.json({ ok: true, paused: list });
  } catch (err) {
    res.status(500).json({ error: `Could not write paused.json: ${err.message}` });
  }
});

app.post('/api/monitor/start', async (req, res) => {
  res.json(await runPm2(['start', PM2_PROCESS_NAME]));
});

app.post('/api/monitor/stop', async (req, res) => {
  res.json(await runPm2(['stop', PM2_PROCESS_NAME]));
});

app.post('/api/monitor/restart', async (req, res) => {
  res.json(await runPm2(['restart', PM2_PROCESS_NAME]));
});

app.listen(PORT, () => {
  console.log(`Stream monitor config UI running at http://localhost:${PORT}`);
});
