FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/worker-state && chown node:node /app/worker-state && chmod 700 /app/worker-state
USER node
EXPOSE 5230
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-5230}/health" || exit 1
CMD ["node", "index.js"]
