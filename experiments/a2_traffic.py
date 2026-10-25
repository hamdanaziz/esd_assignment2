#!/usr/bin/env python3
"""Repeatable traffic for the Assignment 2 Grafana panels (HTTP vs gRPC PlaceOrder).

Runs three phases and prints what it sent, so the same run can be repeated and
compared (a fixed random seed makes the mix identical every time):

  baseline  : healthy traffic                                   (default 30 s)
  fault     : injected latency on BOTH services -> latency, in-flight and p95 move (default 30 s)
  recovery  : fault removed                                      (default 30 s)

Traffic mix per request (same for HTTP and gRPC):
  70 % valid order           -> HTTP 201      / gRPC OK
  20 % invalid order         -> HTTP 400      / gRPC INVALID_ARGUMENT
  10 % repeat of an earlier idempotency key (replay, still a success)

Usage:  python experiments/a2_traffic.py [--rps 10] [--baseline 30] [--fault 30] [--recovery 30] [--delay-ms 300]
"""
import argparse
import os
import random
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "clients", "generated"))
sys.path.insert(0, os.path.join(ROOT, "clients"))

import grpc  # noqa: E402
import requests  # noqa: E402
import orders_pb2  # noqa: E402
import orders_pb2_grpc  # noqa: E402

MENU = [("Zinger Burger", 5.5), ("Fries", 2.0), ("Coke", 1.5), ("Chicken Wrap", 4.0), ("Milkshake", 3.0)]
HTTP = os.getenv("BASE_URL", "http://localhost:3000")
GRPC_TARGET = os.getenv("GRPC_TARGET", "localhost:50051")
GRPC_ADMIN = os.getenv("GRPC_METRICS_URL", "http://localhost:9464")

stats = Counter()
lock = threading.Lock()
used_keys = []


def new_key(rng):
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def pick(rng):
    """Returns (kind, items, key_base). A replay re-sends an earlier valid request with the SAME key and body."""
    r = rng.random()
    items = [{"name": n, "price": p, "qty": rng.randint(1, 2)} for n, p in rng.sample(MENU, rng.randint(1, 3))]
    if r < 0.70 or (r >= 0.90 and not used_keys):
        return "valid", items, new_key(rng)
    if r < 0.90:
        return "invalid", [{"name": "", "price": -1, "qty": 0}], None
    with lock:
        key, old_items = rng.choice(used_keys)
    return "replay", old_items, key


def http_call(kind, items, key):
    headers = {"Idempotency-Key": f"{key}-http"} if key else {}  # separate key space per protocol
    try:
        r = requests.post(f"{HTTP}/orders", json={"customerRef": "load", "items": items}, headers=headers, timeout=5)
        with lock:
            stats[f"http {r.status_code}"] += 1
            if kind == "valid" and r.status_code == 201:
                used_keys.append((key, items))
    except requests.RequestException as e:
        with lock:
            stats[f"http error {type(e).__name__}"] += 1


def grpc_call(stub, kind, items, key):
    req = orders_pb2.PlaceOrderRequest(
        customer_ref="load", idempotency_key=f"{key}-grpc" if key else "",
        items=[orders_pb2.OrderItem(name=i["name"], price=i["price"], qty=i["qty"]) for i in items],
    )
    try:
        stub.PlaceOrder(req, timeout=5, metadata=(("x-request-id", f"load-{uuid.uuid4().hex[:8]}"),))
        with lock:
            stats["grpc OK"] += 1
    except grpc.RpcError as e:
        with lock:
            stats[f"grpc {e.code().name}"] += 1


def set_fault(on, delay_ms):
    # HTTP: every 2nd POST /orders delayed; gRPC: every PlaceOrder delayed
    requests.post(f"{HTTP}/admin/fault",
                  json={"enabled": on, "everyNth": 2, "delayMs": delay_ms if on else 0}, timeout=3)
    requests.post(f"{GRPC_ADMIN}/admin/fault", json={"delayMs": delay_ms if on else 0}, timeout=3)


def run_phase(name, seconds, rps, rng, stub, pool):
    print(f"== {name}: {seconds}s at {rps} requests/s per protocol ==  (started {time.strftime('%H:%M:%S')})")
    end = time.time() + seconds
    interval = 1.0 / rps
    while time.time() < end:
        tick = time.time()
        kind, items, key = pick(rng)
        pool.submit(http_call, kind, items, key)
        pool.submit(grpc_call, stub, kind, items, key)
        time.sleep(max(0, interval - (time.time() - tick)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rps", type=float, default=10)
    ap.add_argument("--baseline", type=int, default=30)
    ap.add_argument("--fault", type=int, default=30)
    ap.add_argument("--recovery", type=int, default=30)
    ap.add_argument("--delay-ms", type=int, default=300)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    channel = grpc.insecure_channel(GRPC_TARGET)
    stub = orders_pb2_grpc.OrderServiceStub(channel)
    pool = ThreadPoolExecutor(max_workers=64)
    try:
        set_fault(False, 0)
        run_phase("baseline", a.baseline, a.rps, rng, stub, pool)
        set_fault(True, a.delay_ms)
        run_phase(f"fault (+{a.delay_ms} ms)", a.fault, a.rps, rng, stub, pool)
        set_fault(False, 0)
        run_phase("recovery", a.recovery, a.rps, rng, stub, pool)
    finally:
        set_fault(False, 0)
        pool.shutdown(wait=True)
        channel.close()
    print("\nsent (status counts):")
    for k in sorted(stats):
        print(f"  {k:28s} {stats[k]}")


if __name__ == "__main__":
    main()
