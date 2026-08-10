// Node side of the PRD §8.5 Python worker contract.
//
// One process per request: spawn the worker, write {op, params} to stdin, read
// the response envelope from stdout, kill it if it overruns the timeout. No
// long-lived process and no port to manage, so §9 independence and §27.4 hold.
//
// Every failure this module can see — spawn failure, non-zero exit, unparseable
// stdout, timeout — is normalised into the same error envelope with the code
// `python_worker_failure`, which server.js propagates as HTTP 502 and the
// client renders on the Watch surface (§25). Worker-reported failures
// (area_cap_exceeded, no_route, …) keep their own codes and pass through
// untouched.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const WORKER = path.join(ROOT, 'tools', 'worker.py');
const DEFAULT_TIMEOUT_MS = 60000; // §8.5 recommended default
const LOG_TAIL = 4000;

// The app-local venv is preferred when present, so a machine-wide python3
// without osmnx cannot shadow a correct install (README documents the venv).
function pythonBin() {
  const venv = path.join(ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

function tail(text) {
  const s = String(text || '').trim();
  return s.length > LOG_TAIL ? '…' + s.slice(-LOG_TAIL) : s;
}

function failure(message, details) {
  return { ok: false, result: null, error: { code: 'python_worker_failure', message, details } };
}

function runWorker(op, params, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const bin = pythonBin();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [WORKER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(failure(`could not spawn ${bin}: ${e}`, { op, python: bin }));
    }

    let out = '';
    let logs = '';
    let settled = false;
    const started = Date.now();

    const finish = (envelope) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      envelope.meta = { op, python: bin, elapsedMs: Date.now() - started };
      // stderr is logs only, never parsed as data (§8.5) — surfaced with a
      // failure because a stack trace is what makes it debuggable.
      if (!envelope.ok && logs.trim()) {
        envelope.error.details = { ...(envelope.error.details || {}), log: tail(logs) };
      }
      resolve(envelope);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        failure(
          `Python worker timed out after ${Math.round(timeoutMs / 1000)}s (op "${op}"). ` +
            'An uncached road network download may be slower than the timeout — retry, or narrow the area.',
          { op, timeoutMs },
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      logs += d;
      if (logs.length > 2 * LOG_TAIL) logs = logs.slice(-2 * LOG_TAIL);
    });
    child.on('error', (e) => finish(failure(`Python worker could not run (${bin}): ${e}`, { op, python: bin })));

    child.on('close', (code, signal) => {
      if (settled) return;
      let envelope = null;
      try { envelope = JSON.parse(out); } catch { envelope = null; }
      if (!envelope || typeof envelope.ok !== 'boolean' || !('result' in envelope) || !('error' in envelope)) {
        return finish(
          failure(
            `Python worker returned no valid response envelope (exit ${code}${signal ? `, ${signal}` : ''}).`,
            { op, exitCode: code, signal, stdout: tail(out) },
          ),
        );
      }
      if (code !== 0) {
        return finish(failure(`Python worker exited ${code} (op "${op}").`, { op, exitCode: code, signal }));
      }
      finish(envelope);
    });

    child.stdin.on('error', () => {}); // EPIPE when the child dies before reading
    child.stdin.end(JSON.stringify({ op, params: params || {} }));
  });
}

module.exports = { runWorker, pythonBin, DEFAULT_TIMEOUT_MS, WORKER };
