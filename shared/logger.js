// shared/logger.js
// Structured JSON logging (same format as Assignment 1) so Filebeat ->
// Elasticsearch can parse fields directly. Used by BOTH the HTTP service and
// the gRPC service; only app_name and the log file differ.
//
// Every line looks like:
// {"timestamp":"...","level":"info","app_name":"quickbite-grpc","message":"order placed",
//  "requestId":"a1b2c3","orderId":"o_9..."}
//
// requestId is the correlation id: the HTTP service takes it from the
// X-Request-ID header, the gRPC service from the x-request-id metadata key.
// Searching one requestId in Kibana therefore shows the caller's request across
// both services. We never log secrets or personal data.

const winston = require('winston');

function createLogger(appName, logFile) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    defaultMeta: { app_name: appName },
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: logFile }),
    ],
  });
}

module.exports = { createLogger };
