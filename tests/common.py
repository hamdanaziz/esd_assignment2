"""Shared helpers for the integration tests (they talk to the running docker compose stack)."""
import os
import sys
import uuid

import requests
import yaml
from openapi_core import OpenAPI
from openapi_core.contrib.requests import RequestsOpenAPIRequest, RequestsOpenAPIResponse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "clients", "generated"))
sys.path.insert(0, os.path.join(ROOT, "clients"))

BASE_URL = os.getenv("BASE_URL", "http://localhost:3000")
GRPC_TARGET = os.getenv("GRPC_TARGET", "localhost:50051")
GRPC_METRICS_URL = os.getenv("GRPC_METRICS_URL", "http://localhost:9464")

OPENAPI = OpenAPI.from_file_path(os.path.join(ROOT, "openapi.yaml"))
SESSION = requests.Session()


def call(method, path, **kwargs):
    """Make a request AND check that the response matches openapi.yaml (status, headers, body schema)."""
    req = requests.Request(method, BASE_URL + path, **kwargs).prepare()
    resp = SESSION.send(req, timeout=5)
    OPENAPI.validate_response(RequestsOpenAPIRequest(req), RequestsOpenAPIResponse(resp))
    return resp


def uniq(prefix="t"):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


GOOD_ORDER = {"customerRef": "cust_test", "items": [{"name": "Zinger Burger", "price": 5.5, "qty": 2}]}
