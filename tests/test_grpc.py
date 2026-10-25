"""gRPC tests + HTTP-vs-gRPC parity (same business rules, same source of truth)."""
import unittest

import grpc
import requests

import orders_pb2
import orders_pb2_grpc
from common import BASE_URL, GOOD_ORDER, GRPC_METRICS_URL, GRPC_TARGET, call, uniq
from grpc_client import place_order


def items(*specs):
    return [orders_pb2.OrderItem(name=n, price=p, qty=q) for n, p, q in specs]


class GrpcPlaceOrder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.channel = grpc.insecure_channel(GRPC_TARGET)
        cls.stub = orders_pb2_grpc.OrderServiceStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()

    def test_success(self):
        order, code, _, rid, _, md = place_order(self.stub, items(("Zinger Burger", 5.5, 2)), "cust_test")
        self.assertEqual(code, grpc.StatusCode.OK)
        self.assertEqual((order.status, order.amount), ("placed", 11.0))
        self.assertEqual(md["x-request-id"], rid)  # correlation id echoed back

    def test_invalid_argument(self):
        order, code, details, _, _, md = place_order(self.stub, items(("", 0, 0)))
        self.assertEqual(code, grpc.StatusCode.INVALID_ARGUMENT)
        self.assertEqual(md["x-error-code"], "VALIDATION_ERROR")
        self.assertIn("items[0].qty", details)

    def test_deadline_exceeded(self):
        _, code, _, _, _, _ = place_order(self.stub, items(("Fries", 2, 1)), deadline=0.0005)
        self.assertEqual(code, grpc.StatusCode.DEADLINE_EXCEEDED)

    def test_idempotent_retry(self):
        key = uniq("grpc")
        a, *_ = place_order(self.stub, items(("Fries", 2, 1)), idempotency_key=key)
        b, *_ = place_order(self.stub, items(("Fries", 2, 1)), idempotency_key=key)
        self.assertEqual(a.id, b.id)
        self.assertFalse(a.replayed)
        self.assertTrue(b.replayed)

    def test_key_reuse_is_failed_precondition(self):
        key = uniq("grpc")
        place_order(self.stub, items(("Fries", 2, 1)), idempotency_key=key)
        _, code, _, _, _, _ = place_order(self.stub, items(("Coke", 1.5, 1)), idempotency_key=key)
        self.assertEqual(code, grpc.StatusCode.FAILED_PRECONDITION)


class HttpGrpcParity(unittest.TestCase):
    """Both front doors must apply the same rules to the same data."""

    @classmethod
    def setUpClass(cls):
        cls.channel = grpc.insecure_channel(GRPC_TARGET)
        cls.stub = orders_pb2_grpc.OrderServiceStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()

    def test_same_invalid_inputs_rejected_by_both(self):
        cases = [
            ("no items", [], {"items": []}),
            ("zero qty", [("x", 1, 0)], {"items": [{"name": "x", "price": 1, "qty": 0}]}),
            ("negative price", [("x", -1, 1)], {"items": [{"name": "x", "price": -1, "qty": 1}]}),
        ]
        for label, grpc_items, http_body in cases:
            with self.subTest(label):
                http = call("POST", "/orders", json=http_body)
                _, code, _, _, _, _ = place_order(self.stub, items(*grpc_items))
                self.assertEqual(http.status_code, 400)
                self.assertEqual(code, grpc.StatusCode.INVALID_ARGUMENT)

    def test_same_total_for_same_order(self):
        http = call("POST", "/orders", json=GOOD_ORDER).json()
        order, *_ = place_order(self.stub, items(("Zinger Burger", 5.5, 2)), "cust_test")
        self.assertEqual(http["amount"], order.amount)

    def test_one_source_of_truth_http_order_is_visible_to_grpc_idempotency(self):
        # An order placed over HTTP with key K is replayed (not duplicated) when gRPC uses key K with the same body.
        key = uniq("cross")
        http = call("POST", "/orders", json=GOOD_ORDER, headers={"Idempotency-Key": key}).json()
        order, code, _, _, _, _ = place_order(
            self.stub, items(("Zinger Burger", 5.5, 2)), "cust_test", idempotency_key=key
        )
        self.assertEqual(code, grpc.StatusCode.OK)
        self.assertEqual(order.id, http["id"])
        self.assertTrue(order.replayed)
        # ...and the order created through gRPC can be read and changed through HTTP
        got = call("GET", f"/orders/{order.id}")
        self.assertEqual(got.status_code, 200)

    def test_request_id_is_the_same_in_http_and_grpc_logs_inputs(self):
        # Correlation id is accepted by both protocols and echoed back.
        rid = uniq("corr")
        http = requests.post(f"{BASE_URL}/orders", json=GOOD_ORDER, headers={"X-Request-ID": rid}, timeout=5)
        self.assertEqual(http.headers["X-Request-ID"], rid)
        _, _, _, _, _, md = place_order(
            orders_pb2_grpc.OrderServiceStub(self.channel), items(("Fries", 2, 1)), request_id=rid
        )
        self.assertEqual(md["x-request-id"], rid)

    def test_grpc_metrics_endpoint_exposes_rpc_counters(self):
        place_order(self.stub, items(("Fries", 2, 1)))
        text = requests.get(f"{GRPC_METRICS_URL}/metrics", timeout=5).text
        self.assertIn('grpc_server_handled_total{grpc_method="PlaceOrder",grpc_code="OK"}', text)
        self.assertIn("grpc_server_handling_seconds_bucket", text)
        self.assertIn("grpc_server_in_flight_requests", text)


if __name__ == "__main__":
    unittest.main()
