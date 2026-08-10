#!/usr/bin/env node
// §8.5 envelope round-trip checks, from the Node side.
//
//     node tools/smoke_envelope.js
//
// Spawns the real worker through the real client (tools/worker_client.js) — no
// server and no network. What is being verified is the contract itself: that a
// success, an unknown op, a crash, a timeout and an over-cap request all come
// back as well-formed envelopes rather than as a hung request or a stack trace.

const assert = require('node:assert');
const { runWorker, pythonBin } = require('./worker_client.js');

const PASS = [];
const FAIL = [];

function check(name, fn) {
  try {
    fn();
    PASS.push(name);
    console.log('ok   ' + name);
  } catch (e) {
    FAIL.push(name);
    console.log('FAIL ' + name + ' — ' + e.message);
  }
}

function isEnvelope(env) {
  assert.strictEqual(typeof env.ok, 'boolean', 'ok must be boolean');
  assert.ok('result' in env, 'result key required');
  assert.ok('error' in env, 'error key required');
  if (env.ok) {
    assert.strictEqual(env.error, null, 'a success envelope carries no error');
  } else {
    assert.strictEqual(env.result, null, 'a failure envelope carries no result');
    assert.strictEqual(typeof env.error.code, 'string', 'error.code must be a string');
    assert.strictEqual(typeof env.error.message, 'string', 'error.message must be a string');
  }
}

(async function main() {
  console.log(`§8.5 envelope round-trip — python: ${pythonBin()}\n`);

  const ok = await runWorker('echo', { hello: 'route' });
  check('a normal op returns ok:true with a result', () => {
    isEnvelope(ok);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.result.echo, { hello: 'route' });
  });

  const unknown = await runWorker('does-not-exist', {});
  check('an unknown op returns an error envelope, not a crash', () => {
    isEnvelope(unknown);
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.error.code, 'unknown_op');
  });

  const boom = await runWorker('boom', { message: 'deliberate' });
  check('a forced exception returns an error envelope', () => {
    isEnvelope(boom);
    assert.strictEqual(boom.error.code, 'worker_exception');
    assert.match(boom.error.message, /deliberate/);
  });
  check('the stack trace is carried as a log, not as data (§8.5)', () => {
    assert.match(boom.error.details.log, /Traceback/);
  });

  const timedOut = await runWorker('sleep', { seconds: 5 }, { timeoutMs: 700 });
  check('an overrunning worker is killed and reported as python_worker_failure', () => {
    isEnvelope(timedOut);
    assert.strictEqual(timedOut.error.code, 'python_worker_failure');
    assert.match(timedOut.error.message, /timed out/);
    assert.ok(timedOut.meta.elapsedMs < 4000, 'the kill must not wait for the child');
  });

  // FR-ROUTE-010 — ~20 km diagonal, rejected at the bbox stage with numbers.
  const overCap = await runWorker('route', {
    origin: [36.3504, 127.3845],
    destination: [36.4771, 127.5418],
    mode: 'drive',
  });
  check('an over-cap route is rejected visibly (FR-ROUTE-010)', () => {
    isEnvelope(overCap);
    assert.strictEqual(overCap.error.code, 'area_cap_exceeded');
    assert.ok(overCap.error.details.requestedAreaKm2 > 100, 'the requested area must be stated');
    assert.strictEqual(overCap.error.details.capKm2, 100);
    assert.match(overCap.error.message, /rejected, not truncated/);
  });
  check('the rejection is fast — no network was touched', () => {
    assert.ok(overCap.meta.elapsedMs < 15000, `took ${overCap.meta.elapsedMs}ms`);
  });

  const caps = await runWorker('capabilities', {});
  check('capabilities reports the installed dependencies', () => {
    isEnvelope(caps);
    assert.ok(caps.result.ops.includes('route'));
    assert.ok(caps.result.dependencies.osmnx, 'osmnx version or MISSING marker');
  });
  console.log('     python ' + caps.result.python + ', osmnx ' + caps.result.dependencies.osmnx);

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('failed: ' + FAIL.join(', '));
    process.exit(1);
  }
})();
