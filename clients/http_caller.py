#!/usr/bin/env python3
"""A small "other service" that calls QuickBite's POST /orders reliably.

It demonstrates three reliability patterns around an HTTP call:

  1. TIMEOUT          every request gives up after TIMEOUT_S seconds.
  2. RETRY + BACKOFF  transient failures (timeout, connection error, 502/503/504)
                      are retried up to MAX_RETRIES times with exponential
                      backoff + jitter. Retries ONLY happen because every logical
                      call carries an Idempotency-Key, so a retry can never create
                      a second order. (No key -> no retries.)
  3. CIRCUIT BREAKER  after FAILURE_THRESHOLD consecutive FAILED CALLS (each already
                      retried), the breaker OPENS and further calls fail instantly
                      without touching the network. After RECOVERY_TIMEOUT_S it goes
                      HALF-OPEN and lets one trial call through: success -> CLOSED,
                      failure -> OPEN again.

Settings (defaults)
-------------------
  TIMEOUT_S = 1.0   MAX_RETRIES = 2 (so up to 3 attempts per call)
  BACKOFF   = 0.2s * 2^retry + up to 0.1s jitter   (0.2s, 0.4s)
  FAILURE_THRESHOLD = 3 failed calls   RECOVERY_TIMEOUT_S = 6.0

What counts as a failure for the breaker: timeouts, connection errors, 502/503/504.
It does NOT count 4xx (400 validation, 409, 422 - the caller's fault) or 429
(rate limiting is demonstrated separately by rate_limit_demo.py).

Usage
-----
  python clients/http_caller.py demo                    # full scripted scenario, 503 outage
  python clients/http_caller.py demo --fault timeout    # same, but the outage is slowness -> client timeouts
  python clients/http_caller.py call --item "Fries:2:1" # one call
"""
import argparse
import random
import sys
import time
import uuid

import requests

BASE_URL_DEFAULT = "http://localhost:3000"
RETRYABLE_STATUS = {502, 503, 504}


# ----------------------------------------------------------------------------
# Circuit breaker
# ----------------------------------------------------------------------------
class CircuitBreaker:
    CLOSED, OPEN, HALF_OPEN = "closed", "open", "half-open"

    def __init__(self, failure_threshold=3, recovery_timeout=6.0, clock=time.monotonic, on_change=None):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._clock = clock
        self._on_change = on_change or (lambda old, new: None)
        self.state = self.CLOSED
        self.failures = 0
        self.opened_at = None
        self._trial_in_flight = False

    def _set(self, new):
        if new != self.state:
            old, self.state = self.state, new
            self._on_change(old, new)

    def seconds_until_retry(self):
        if self.state != self.OPEN:
            return 0.0
        return max(0.0, self.recovery_timeout - (self._clock() - self.opened_at))

    def allow(self):
        """May a call go to the network right now?"""
        if self.state == self.CLOSED:
            return True
        if self.state == self.OPEN:
            if self._clock() - self.opened_at >= self.recovery_timeout:
                self._set(self.HALF_OPEN)  # recovery period over: allow ONE trial call
                self._trial_in_flight = True
                return True
            return False
        # HALF_OPEN: only the single trial call is allowed
        if not self._trial_in_flight:
            self._trial_in_flight = True
            return True
        return False

    def record_success(self):
        self.failures = 0
        self._trial_in_flight = False
        self._set(self.CLOSED)

    def record_failure(self):
        self._trial_in_flight = False
        if self.state == self.HALF_OPEN:
            self.opened_at = self._clock()
            self._set(self.OPEN)
            return
        self.failures += 1
        if self.failures >= self.failure_threshold:
            self.opened_at = self._clock()
            self._set(self.OPEN)


class CircuitOpenError(Exception):
    pass


# ----------------------------------------------------------------------------
# The caller
# ----------------------------------------------------------------------------
class QuickBiteCaller:
    def __init__(self, base_url=BASE_URL_DEFAULT, timeout=1.0, max_retries=2, backoff_base=0.2,
                 breaker=None, session=None, sleep=time.sleep, log=print):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.session = session or requests.Session()
        self._sleep = sleep
        self.log = log
        self.breaker = breaker or CircuitBreaker(
            on_change=lambda old, new: self.log(f"    *** BREAKER {old} -> {new}")
        )

    def place_order(self, items, customer_ref="caller_svc", idempotency_key=None):
        """One logical call. Returns the requests.Response (even for 4xx/429) or raises."""
        key = idempotency_key or str(uuid.uuid4())  # one key for ALL attempts of this call
        request_id = f"caller-{uuid.uuid4().hex[:8]}"  # correlation id, also searchable in Kibana
        body = {"customerRef": customer_ref, "items": items}
        headers = {"Idempotency-Key": key, "X-Request-ID": request_id}
        # Retrying is only allowed because the key protects against duplicates.
        retries_allowed = self.max_retries if key else 0

        # The breaker gates the whole logical call once, up front.
        if not self.breaker.allow():
            wait = self.breaker.seconds_until_retry()
            self.log(f"    BLOCKED by open circuit breaker (no network call; retry in {wait:.1f}s)")
            raise CircuitOpenError(f"circuit open, retry in {wait:.1f}s")
        if self.breaker.state == CircuitBreaker.HALF_OPEN:
            retries_allowed = 0  # the recovery trial is a single probe: fail fast, re-open on failure
            self.log("    half-open: sending ONE trial request (no retries)")

        for attempt in range(1, retries_allowed + 2):
            outcome, resp = self._attempt(body, headers)
            total = retries_allowed + 1
            if outcome == "ok":
                self.breaker.record_success()
                replay = " (Idempotent-Replayed: true)" if resp.headers.get("Idempotent-Replayed") else ""
                self.log(f"    attempt {attempt}/{total}: HTTP {resp.status_code}{replay} -> success "
                         f"[key={key[:8]} request_id={request_id}]")
                return resp
            if outcome == "client_error":
                # 4xx / 429: not transient, retrying the same request will not help, and it is not the server's fault.
                self.breaker.record_success()
                self.log(f"    attempt {attempt}/{total}: HTTP {resp.status_code} -> not retryable, returning to caller")
                return resp

            # transient failure
            if attempt <= retries_allowed:
                delay = self.backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.1)
                self.log(f"    attempt {attempt}/{total}: {resp} -> retry in {delay:.2f}s (same Idempotency-Key)")
                self._sleep(delay)
            else:
                self.log(f"    attempt {attempt}/{total}: {resp} -> out of retries, call FAILED")
                self.breaker.record_failure()
                raise RuntimeError(f"call failed after {attempt} attempts: {resp}")

    def _attempt(self, body, headers):
        """Returns ('ok'|'client_error'|'transient', response-or-description)."""
        try:
            resp = self.session.post(f"{self.base_url}/orders", json=body, headers=headers, timeout=self.timeout)
        except requests.exceptions.Timeout:
            return "transient", f"TIMEOUT after {self.timeout}s"
        except requests.exceptions.ConnectionError as e:
            return "transient", f"CONNECTION ERROR ({type(e).__name__})"
        if resp.status_code in RETRYABLE_STATUS:
            return "transient", f"HTTP {resp.status_code}"
        if 200 <= resp.status_code < 300:
            return "ok", resp
        return "client_error", resp


# ----------------------------------------------------------------------------
# Scripted demo
# ----------------------------------------------------------------------------
ITEMS = [{"name": "Zinger Burger", "price": 5.5, "qty": 1}]


def set_fault(base_url, **cfg):
    r = requests.post(f"{base_url}/admin/fault", json=cfg, timeout=3)
    r.raise_for_status()


def run_call(caller, n, label):
    print(f"[call {n}] {label}")
    try:
        resp = caller.place_order(ITEMS)
        print(f"[call {n}] result: HTTP {resp.status_code} order={resp.json().get('id')}")
    except CircuitOpenError as e:
        print(f"[call {n}] result: fast-fail, {e}")
    except RuntimeError as e:
        print(f"[call {n}] result: FAILED ({e})")


def demo(base_url, fault_mode, timeout, recovery):
    caller = QuickBiteCaller(base_url, timeout=timeout,
                             breaker=None)
    caller.breaker.recovery_timeout = recovery
    print(f"settings: timeout={timeout}s max_retries={caller.max_retries} (<=3 attempts) "
          f"backoff=0.2s*2^n+jitter breaker=open after {caller.breaker.failure_threshold} failed calls, "
          f"recovery={recovery}s, outage mode={fault_mode}\n")

    set_fault(base_url, enabled=False)
    print("== Phase 1: healthy server ==")
    for n in (1, 2):
        run_call(caller, n, "place order")

    print("\n== Phase 2: two transient failures, then the server recovers -> RETRY succeeds ==")
    if fault_mode == "timeout":
        set_fault(base_url, enabled=True, slowNext=2, delayMs=int(timeout * 1000) + 800)
    else:
        set_fault(base_url, enabled=True, failNext=2)
    run_call(caller, 3, "place order (first 2 attempts will fail)")

    print("\n== Phase 3: sustained outage -> failed calls pile up -> BREAKER OPENS ==")
    if fault_mode == "timeout":
        set_fault(base_url, enabled=True, slowNext=1000, delayMs=int(timeout * 1000) + 800)
    else:
        set_fault(base_url, enabled=True, failNext=1000)
    for n in (4, 5, 6):
        run_call(caller, n, "place order (server is down)")
    print("-- breaker is open: next calls must not reach the network --")
    for n in (7, 8):
        run_call(caller, n, "place order (breaker open)")

    print("\n== Phase 4: server fixed; wait for recovery period, then HALF-OPEN trial ==")
    set_fault(base_url, enabled=False)
    wait = caller.breaker.seconds_until_retry() + 0.2
    print(f"(waiting {wait:.1f}s for the recovery timeout)")
    time.sleep(wait)
    run_call(caller, 9, "trial call in half-open state")
    for n in (10, 11):
        run_call(caller, n, "place order (breaker closed again)")
    print("\ndemo finished; breaker state:", caller.breaker.state)


def main(argv=None):
    p = argparse.ArgumentParser(description="QuickBite HTTP caller (timeout, retry, circuit breaker)")
    p.add_argument("--base-url", default=BASE_URL_DEFAULT)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="scripted scenario: success, retry, breaker open, recovery")
    d.add_argument("--fault", choices=["503", "timeout"], default="503")
    d.add_argument("--timeout", type=float, default=1.0)
    d.add_argument("--recovery", type=float, default=6.0)
    c = sub.add_parser("call", help="make a single call")
    c.add_argument("--item", action="append", default=[], help="name:price:qty")
    c.add_argument("--idempotency-key")
    args = p.parse_args(argv)

    if args.cmd == "demo":
        demo(args.base_url, args.fault, args.timeout, args.recovery)
        return 0
    items = []
    for s in args.item or ["Fries:2:1"]:
        name, price, qty = s.rsplit(":", 2)
        items.append({"name": name, "price": float(price), "qty": int(qty)})
    caller = QuickBiteCaller(args.base_url)
    resp = caller.place_order(items, idempotency_key=args.idempotency_key)
    print(resp.status_code, resp.text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
