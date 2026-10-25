#!/usr/bin/env bash
# scripts/gen_proto.sh - generate the Python gRPC client code from proto/orders.proto.
#
# Output: clients/generated/orders_pb2.py       (message classes)
#         clients/generated/orders_pb2_grpc.py  (OrderServiceStub + servicer base class)
#
# The Node gRPC server does not need a generated file: @grpc/proto-loader builds
# the service definition from the same .proto when the server starts.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p clients/generated
python3 -m grpc_tools.protoc \
  -I proto \
  --python_out=clients/generated \
  --grpc_python_out=clients/generated \
  proto/orders.proto
echo "generated: clients/generated/orders_pb2.py, clients/generated/orders_pb2_grpc.py"
