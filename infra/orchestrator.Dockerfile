# Build from the repo root: docker build -f infra/orchestrator.Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
RUN npm install --workspace apps/orchestrator
COPY tsconfig.base.json ./
COPY apps/orchestrator apps/orchestrator
RUN npm run build --workspace apps/orchestrator

FROM node:22-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production

# git: the agent shells out to it directly (via the Bash tool) to commit/push.
# gh: used to open and merge pull requests. python3/make/g++: build better-sqlite3's
# native binding if no prebuilt binary matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg python3 make g++ \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
RUN npm install --workspace apps/orchestrator --omit=dev
COPY --from=build /repo/apps/orchestrator/dist apps/orchestrator/dist
COPY infra/orchestrator-entrypoint.sh /usr/local/bin/orchestrator-entrypoint.sh
RUN chmod +x /usr/local/bin/orchestrator-entrypoint.sh

WORKDIR /repo/apps/orchestrator
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/orchestrator-entrypoint.sh"]
CMD ["node", "dist/index.js"]
