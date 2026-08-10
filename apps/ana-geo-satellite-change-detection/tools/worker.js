// Node side of the Python worker contract (PRD §8.5).
//
//   spawn `python3 tools/worker.py`, JSON request on stdin, JSON response on
//   stdout, stderr treated as logs only, 60 s default timeout.
//
// Every failure path returns the *same* error envelope shape as the worker, so
// server.js and the Watch surface never have to tell "the worker said no" apart
// from "the worker never answered" (§25).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'worker.py');
const DEFAULT_TIMEOUT_MS = 60_000; // §8.5 recommended default

// Prefer the app-local virtualenv, so `node server.js` works without the caller
// having activated anything; fall back to whatever python3 is on PATH.
function pythonBin() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = path.join(ROOT, '.venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}

function fail(code, message) {
  return { ok: false, result: null, error: { code, message } };
}

/**
 * @param {string} op      worker op name
 * @param {object} params  structured parameters — never a shell string (§27.4)
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, result: object|null, error: {code: string, message: string}|null}>}
 */
function runWorker(op, params, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonBin(), [SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(fail('worker_failure', `cannot spawn python worker: ${e}`));
    }

    let out = '';
    let errLog = '';
    let settled = false;
    const done = (env) => { if (!settled) { settled = true; clearTimeout(timer); resolve(env); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(fail('worker_timeout', `python worker exceeded ${timeoutMs / 1000}s (op: ${op})`));
    }, timeoutMs);

    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { errLog += c; if (errLog.length > 64 * 1024) errLog = errLog.slice(-64 * 1024); });

    child.on('error', (e) => {
      done(fail('worker_failure', `python worker could not start: ${e.message} (tried ${pythonBin()})`));
    });

    child.on('close', (code) => {
      if (errLog.trim()) console.error(`[worker:${op}] ${errLog.trim()}`); // logs only (§8.5)
      if (!out.trim()) {
        return done(fail('worker_failure', `python worker exited ${code} with no response (see server log)`));
      }
      try {
        done(JSON.parse(out));
      } catch (e) {
        done(fail('worker_failure', `python worker wrote non-JSON on stdout: ${String(out).slice(0, 300)}`));
      }
    });

    child.stdin.on('error', () => { /* closed by an early exit; `close` reports it */ });
    child.stdin.end(JSON.stringify({ op, params }));
  });
}

module.exports = { runWorker, DEFAULT_TIMEOUT_MS, pythonBin };
