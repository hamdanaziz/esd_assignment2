# Build context is the REPO ROOT (see docker-compose.yml): the gRPC service shares
# ./shared (business rules + DB code) with the HTTP service and needs ./proto.
FROM node:20-alpine

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY shared ./shared
COPY proto ./proto
COPY grpc-service ./grpc-service

RUN mkdir -p /app/logs

ENV GRPC_PORT=50051
ENV METRICS_PORT=9464
ENV LOG_FILE=/app/logs/quickbite-grpc.log

EXPOSE 50051 9464

CMD ["node", "grpc-service/server.js"]
