FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && python3 -m playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node docs ./docs
COPY --chown=node:node login-service ./login-service

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    PYTHONDONTWRITEBYTECODE=1 \
    XDG_CONFIG_HOME=/tmp/chromium-config \
    XDG_CACHE_HOME=/tmp/chromium-cache

USER node
EXPOSE 4173
CMD ["node", "server.js"]
