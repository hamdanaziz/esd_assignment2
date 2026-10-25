#!/usr/bin/env python3
"""gRPC client for QuickBite's PlaceOrder RPC.

Calls the gRPC service directly (no browser, no HTTP API), sets a DEADLINE,
sends an x-request-id so logs can be correlated across services, and prints
either the result or the gRPC status + details.

Examples
--------
  # success
  python clients/grpc_client.py --customer cust_42 --item "Zinger Burger:5.5:2" --item "Fries:2:1"

  # failure: invalid input -> INVALID_ARGUMENT
  python clients/grpc_client.py --item ":0:0"

  # idempotent retry: same key twice -> second reply has replayed=True
  python clients/grpc_client.py --item "Fries:2:1" --idempotency-key demo-123
  python clients/grpc_client.py --item "Fries:2:1" --idempotency-key demo-123

  # failure: deadline too short -> DEADLINE_EXCEEDED (raised by the client, not the server)
  python clients/grpc_client.py --item "Fries:2:1" --deadline 0.001

Exit code: 0 on OK, 1 on any gRPC error, 2 on bad command-line input.
"""
import argparse
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated"))

import grpc  # noqa: E402
import orders_pb2  # noqa: E402
import orders_pb2_grpc  # noqa: E402


def parse_item(text):
    """'name:price:qty' -> OrderItem. The name may be empty (used to test validation)."""
    try:
        name, price, qty = text.rsplit(":", 2)
        return orders_pb2.OrderItem(name=name, price=float(price), qty=int(qty))
    except ValueError:
        raise argparse.ArgumentTypeError(f"item must look like name:price:qty, got {text!r}")


def place_order(stub, items, customer_ref="", idempotency_key="", deadline=2.0, request_id=None):
    """Make one PlaceOrder call. Returns (order_or_None, grpc_code, details, request_id, elapsed_ms, trailing)."""
    request_id = request_id or str(uuid.uuid4())
    request = orders_pb2.PlaceOrderRequest(
        customer_ref=customer_ref, items=items, idempotency_key=idempotency_key
    )
    started = time.perf_counter()
    try:
        # timeout= is the DEADLINE: gRPC propagates it to the server and cancels the call when it passes.
        order, call = stub.PlaceOrder.with_call(
            request, timeout=deadline, metadata=(("x-request-id", request_id),)
        )
        elapsed = (time.perf_counter() - started) * 1000
        return order, grpc.StatusCode.OK, "", request_id, elapsed, dict(call.initial_metadata() or [])
    except grpc.RpcError as err:
        elapsed = (time.perf_counter() - started) * 1000
        trailing = dict(err.trailing_metadata() or [])
        return None, err.code(), err.details(), request_id, elapsed, trailing


def main(argv=None):
    p = argparse.ArgumentParser(description="QuickBite gRPC PlaceOrder client")
    p.add_argument("--target", default=os.getenv("GRPC_TARGET", "localhost:50051"))
    p.add_argument("--customer", default="", help="customer_ref, e.g. cust_42")
    p.add_argument("--item", action="append", type=parse_item, default=[], help="name:price:qty (repeatable)")
    p.add_argument("--idempotency-key", default="")
    p.add_argument("--deadline", type=float, default=2.0, help="seconds before the call is cancelled (default 2)")
    p.add_argument("--request-id", default=None, help="x-request-id to send (default: random UUID)")
    args = p.parse_args(argv)

    with grpc.insecure_channel(args.target) as channel:
        stub = orders_pb2_grpc.OrderServiceStub(channel)
        order, code, details, request_id, ms, md = place_order(
            stub, args.item, args.customer, args.idempotency_key, args.deadline, args.request_id
        )

    print(f"request_id : {request_id}")
    print(f"deadline   : {args.deadline}s   elapsed: {ms:.1f} ms")
    print(f"grpc status: {code.name} ({code.value[0]})")
    if code == grpc.StatusCode.OK:
        print(f"order      : id={order.id} status={order.status} amount={order.amount} replayed={order.replayed}")
        print(f"             items={[(i.name, i.price, i.qty) for i in order.items]}")
        return 0
    print(f"details    : {details}")
    if md.get("x-error-code"):
        print(f"error code : {md['x-error-code']}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
