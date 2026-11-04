'use strict';

/**
 * Shared circuit breaker + retry with exponential backoff and jitter.
 * Prevents failed Supabase (or other) calls from piling up.
 */
function createCircuit({
  name = 'circuit',
  failureThreshold = 3,
  openMs = 30000,
  maxOpenMs = 5 * 60e3,
  timeoutMs = 12000,
} = {}) {
  let failures = 0;
  let openUntil = 0;
  let halfOpen = false;
  let lastError = null;
  let lastOkAt = 0;
  let inFlight = 0;
  const MAX_IN_FLIGHT = 1;

  function state() {
    const now = Date.now();
    if (openUntil && now >= openUntil) {
      halfOpen = true;
      openUntil = 0;
    }
    return {
      name,
      open: openUntil > now,
      halfOpen,
      failures,
      openUntil,
      lastError,
      lastOkAt,
      inFlight,
    };
  }

  function allow() {
    const now = Date.now();
    if (openUntil > now) return false;
    // Open window elapsed → half-open probe (single in-flight)
    if (openUntil && now >= openUntil) {
      halfOpen = true;
      openUntil = 0;
    } else if (!openUntil && failures > 0 && !halfOpen && lastOkAt === 0) {
      // cold start after failures cleared openUntil via state(); stay half-open until success
      halfOpen = true;
    }
    if (inFlight >= MAX_IN_FLIGHT) return false;
    return true;
  }

  function recordSuccess() {
    failures = 0;
    halfOpen = false;
    openUntil = 0;
    lastOkAt = Date.now();
    lastError = null;
  }

  function recordFailure(err) {
    failures += 1;
    lastError = (err && err.message) || String(err || 'error');
    if (failures >= failureThreshold || halfOpen) {
      const exp = Math.min(maxOpenMs, openMs * Math.pow(2, Math.max(0, failures - failureThreshold)));
      const jitter = Math.floor(Math.random() * Math.min(2000, exp * 0.2));
      openUntil = Date.now() + exp + jitter;
      halfOpen = false;
    }
  }

  async function run(fn) {
    if (!allow()) {
      const err = new Error(`[${name}] circuit open`);
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }
    inFlight += 1;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (ctrl) ctrl.abort(); } catch (_) {}
        const err = new Error(`[${name}] timeout ${timeoutMs}ms`);
        err.code = 'TIMEOUT';
        reject(err);
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fn(ctrl ? ctrl.signal : undefined)),
        timeoutPromise,
      ]);
      recordSuccess();
      return result;
    } catch (e) {
      recordFailure(e);
      throw e;
    } finally {
      clearTimeout(timer);
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  async function withRetry(fn, { retries = 2, baseMs = 400 } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        return await run(fn);
      } catch (e) {
        last = e;
        if (e && e.code === 'CIRCUIT_OPEN') throw e;
        if (i === retries) break;
        const wait = Math.min(8000, baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw last;
  }

  return { allow, run, withRetry, recordSuccess, recordFailure, state };
}

module.exports = { createCircuit };
