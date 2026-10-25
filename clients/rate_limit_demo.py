#!/usr/bin/env python3
"""Rate-limit demo for GET /orders.

Policy (server side, app/rateLimit.js):
  limit   : 10 requests per 10-second fixed window   (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS)
  shared  : by every caller with the same client IP, on this endpoint only
  allowed again: when the current window ends - the 429 response says how many seconds in Retry-After

This script sends 13 requests back-to-back, prints status + rate-limit headers, then
sleeps for exactly Retry-After seconds and shows that calls are accepted again.
"""
import sys
import time

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"


def hit(i):
    r = requests.get(f"{BASE}/orders", params={"limit": 1}, timeout=3)
    extra = f" Retry-After={r.headers['Retry-After']}s" if "Retry-After" in r.headers else ""
    print(f"request {i:2d}: HTTP {r.status_code}  RateLimit-Limit={r.headers.get('RateLimit-Limit')} "
          f"Remaining={r.headers.get('RateLimit-Remaining')} Reset={r.headers.get('RateLimit-Reset')}s{extra}")
    return r


last = None
for i in range(1, 14):
    last = hit(i)

if last.status_code == 429:
    wait = int(last.headers["Retry-After"])
    print(f"\n429 body: {last.text}")
    print(f"\nsleeping {wait}s (the Retry-After value) ...")
    time.sleep(wait + 0.2)
    print()
    hit(14)
    hit(15)
