# Build context is the REPO ROOT (see docker-compose.yml) so that ./shared and
# ./proto can be copied in next to ./app.
FROM node:20-alpine

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY shared ./shared
COPY app ./app

RUN mkdir -p /app/logs

ENV PORT=3000
ENV LOG_FILE=/app/logs/quickbite.log

EXPOSE 3000

CMD ["node", "app/server.js"]
