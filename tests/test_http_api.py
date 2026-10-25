"""HTTP API tests: valid request, invalid input, repeated request, state changes, rate limit.
Every response is also validated against openapi.yaml (a contract test).

Run the stack first:  docker compose up -d --build
Then:                 python -m unittest discover -s tests -v
"""
import time
import unittest

from common import GOOD_ORDER, call, uniq


class PlaceOrder(unittest.TestCase):
    def test_valid_request_creates_order(self):
        r = call("POST", "/orders", json=GOOD_ORDER)
        self.assertEqual(r.status_code, 201)
        body = r.json()
        self.assertEqual(body["status"], "placed")
        self.assertEqual(body["amount"], 11.0)
        self.assertEqual(r.headers["Location"], f"/orders/{body['id']}")
        self.assertTrue(r.headers["X-Request-ID"])

    def test_invalid_input_returns_400_with_consistent_error_shape(self):
        bad_bodies = [
            {},                                                        # no items
            {"items": []},                                             # empty items
            {"items": [{"name": "", "price": -1, "qty": 0}]},          # bad item fields
            {"items": [{"name": "x", "price": "5", "qty": 1}]},        # price wrong type
            {"customerRef": "Ali Khan!", "items": [GOOD_ORDER["items"][0]]},  # bad customerRef
        ]
        for body in bad_bodies:
            with self.subTest(body=body):
                r = call("POST", "/orders", json=body)
                self.assertEqual(r.status_code, 400)
                err = r.json()["error"]
                self.assertEqual(err["code"], "VALIDATION_ERROR")
                self.assertTrue(err["details"])
                self.assertEqual(err["requestId"], r.headers["X-Request-ID"])

    def test_malformed_json_returns_400(self):
        r = call("POST", "/orders", data="{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], "INVALID_JSON")

    def test_repeated_request_with_same_key_creates_only_one_order(self):
        key = uniq("idem")
        first = call("POST", "/orders", json=GOOD_ORDER, headers={"Idempotency-Key": key})
        again = call("POST", "/orders", json=GOOD_ORDER, headers={"Idempotency-Key": key})
        self.assertEqual(first.status_code, 201)
        self.assertEqual(again.status_code, 201)
        self.assertEqual(first.json()["id"], again.json()["id"])  # same order, not a duplicate
        self.assertNotIn("Idempotent-Replayed", first.headers)
        self.assertEqual(again.headers["Idempotent-Replayed"], "true")

    def test_same_key_with_different_body_is_rejected(self):
        key = uniq("idem")
        call("POST", "/orders", json=GOOD_ORDER, headers={"Idempotency-Key": key})
        other = {"items": [{"name": "Fries", "price": 2, "qty": 1}]}
        r = call("POST", "/orders", json=other, headers={"Idempotency-Key": key})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "IDEMPOTENCY_KEY_REUSED")

    def test_without_key_repeats_create_separate_orders(self):
        a = call("POST", "/orders", json=GOOD_ORDER).json()["id"]
        b = call("POST", "/orders", json=GOOD_ORDER).json()["id"]
        self.assertNotEqual(a, b)  # documents WHY the key matters


class OrderLifecycle(unittest.TestCase):
    def setUp(self):
        self.id = call("POST", "/orders", json=GOOD_ORDER).json()["id"]

    def test_get_order(self):
        r = call("GET", f"/orders/{self.id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["id"], self.id)

    def test_unknown_order_is_404(self):
        r = call("GET", "/orders/o_000000000000")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"]["code"], "NOT_FOUND")

    def test_mark_ready_is_repeatable(self):
        first = call("PATCH", f"/orders/{self.id}", json={"status": "ready"})
        again = call("PATCH", f"/orders/{self.id}", json={"status": "ready"})  # retry: harmless no-op
        self.assertEqual((first.status_code, again.status_code), (200, 200))
        self.assertEqual(first.json()["readyAt"], again.json()["readyAt"])

    def test_cancel_after_ready_conflicts(self):
        call("PATCH", f"/orders/{self.id}", json={"status": "ready"})
        r = call("PATCH", f"/orders/{self.id}", json={"status": "cancelled"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"]["code"], "CONFLICT")

    def test_invalid_status_is_400(self):
        r = call("PATCH", f"/orders/{self.id}", json={"status": "teleported"})
        self.assertEqual(r.status_code, 400)


class RateLimit(unittest.TestCase):
    """GET /orders: 10 requests / 10 s / client IP."""

    def test_429_with_retry_after_then_allowed_again(self):
        time.sleep(10.5)  # make sure we start at the beginning of a fresh window
        statuses = [call("GET", "/orders", params={"limit": 1}).status_code for _ in range(10)]
        self.assertEqual(statuses, [200] * 10)

        blocked = call("GET", "/orders", params={"limit": 1})
        self.assertEqual(blocked.status_code, 429)
        retry_after = int(blocked.headers["Retry-After"])
        self.assertTrue(1 <= retry_after <= 10)
        self.assertEqual(blocked.json()["error"]["code"], "RATE_LIMITED")

        time.sleep(retry_after + 0.3)  # wait exactly as told
        self.assertEqual(call("GET", "/orders", params={"limit": 1}).status_code, 200)

    def test_other_endpoints_are_not_limited(self):
        # the limiter only protects GET /orders; placing orders must keep working
        for _ in range(12):
            self.assertEqual(call("POST", "/orders", json=GOOD_ORDER).status_code, 201)


if __name__ == "__main__":
    unittest.main()
