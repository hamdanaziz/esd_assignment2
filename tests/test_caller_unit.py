"""Unit tests for the Python caller's reliability logic - no server needed (fake clock + fake HTTP session)."""
import unittest

import requests

from common import ROOT  # noqa: F401  (sets sys.path)
from http_caller import CircuitBreaker, CircuitOpenError, QuickBiteCaller


class FakeResponse:
    def __init__(self, status, headers=None):
        self.status_code, self.headers = status, headers or {}

    def json(self):
        return {"id": "o_fake"}


class FakeSession:
    """Plays back a scripted list of outcomes: int status, or an Exception to raise."""

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"headers": dict(headers), "timeout": timeout})
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return FakeResponse(step)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(script, clock=None, threshold=3, recovery=10.0):
    clock = clock or Clock()
    breaker = CircuitBreaker(failure_threshold=threshold, recovery_timeout=recovery, clock=clock)
    sleeps = []
    caller = QuickBiteCaller(session=FakeSession(script), breaker=breaker, sleep=sleeps.append, log=lambda *_: None)
    return caller, breaker, clock, sleeps


ITEMS = [{"name": "x", "price": 1, "qty": 1}]


class RetryTests(unittest.TestCase):
    def test_retries_transient_failure_then_succeeds_with_same_key(self):
        caller, _, _, sleeps = make([503, requests.exceptions.Timeout(), 201])
        resp = caller.place_order(ITEMS)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(caller.session.calls), 3)
        keys = {c["headers"]["Idempotency-Key"] for c in caller.session.calls}
        self.assertEqual(len(keys), 1)  # every attempt reused ONE key -> no duplicate orders
        self.assertEqual(len(sleeps), 2)
        self.assertLess(sleeps[0], sleeps[1])  # exponential backoff

    def test_timeout_is_passed_to_every_request(self):
        caller, *_ = make([503, 201])
        caller.place_order(ITEMS)
        self.assertTrue(all(c["timeout"] == caller.timeout for c in caller.session.calls))

    def test_gives_up_after_max_retries(self):
        caller, *_ = make([503, 503, 503])
        with self.assertRaises(RuntimeError):
            caller.place_order(ITEMS)
        self.assertEqual(len(caller.session.calls), 3)  # 1 try + 2 retries

    def test_does_not_retry_client_errors(self):
        caller, breaker, *_ = make([400])
        self.assertEqual(caller.place_order(ITEMS).status_code, 400)
        self.assertEqual(len(caller.session.calls), 1)
        self.assertEqual(breaker.failures, 0)

    def test_429_is_not_retried_and_not_a_breaker_failure(self):
        caller, breaker, *_ = make([429])
        self.assertEqual(caller.place_order(ITEMS).status_code, 429)
        self.assertEqual(breaker.failures, 0)


class BreakerTests(unittest.TestCase):
    def fail_one_call(self, caller):
        with self.assertRaises(RuntimeError):
            caller.place_order(ITEMS)

    def test_opens_after_threshold_blocks_then_recovers(self):
        caller, breaker, clock, _ = make([503] * 9 + [201, 201], threshold=3, recovery=10.0)
        for _ in range(3):
            self.fail_one_call(caller)
        self.assertEqual(breaker.state, "open")

        before = len(caller.session.calls)
        with self.assertRaises(CircuitOpenError):
            caller.place_order(ITEMS)
        self.assertEqual(len(caller.session.calls), before)  # blocked: no network call

        clock.t += 10.1  # recovery period passes
        self.assertEqual(caller.place_order(ITEMS).status_code, 201)  # half-open trial succeeds
        self.assertEqual(breaker.state, "closed")

    def test_failed_trial_reopens(self):
        caller, breaker, clock, _ = make([503] * 12, threshold=3, recovery=10.0)
        for _ in range(3):
            self.fail_one_call(caller)
        clock.t += 10.1
        self.fail_one_call(caller)  # trial call fails (after its retries)
        self.assertEqual(breaker.state, "open")
        with self.assertRaises(CircuitOpenError):
            caller.place_order(ITEMS)


if __name__ == "__main__":
    unittest.main()
