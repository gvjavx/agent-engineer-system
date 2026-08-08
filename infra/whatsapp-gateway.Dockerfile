# Build from the repo root: docker build -f infra/whatsapp-gateway.Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json ./
COPY apps/whatsapp-gateway/package.json apps/whatsapp-gateway/package.json
RUN npm install --workspace apps/whatsapp-gateway
COPY tsconfig.base.json ./
COPY apps/whatsapp-gateway apps/whatsapp-gateway
RUN npm run build --workspace apps/whatsapp-gateway

FROM node:22-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json ./
COPY apps/whatsapp-gateway/package.json apps/whatsapp-gateway/package.json
RUN npm install --workspace apps/whatsapp-gateway --omit=dev
COPY --from=build /repo/apps/whatsapp-gateway/dist apps/whatsapp-gateway/dist
WORKDIR /repo/apps/whatsapp-gateway
EXPOSE 3000
CMD ["node", "dist/index.js"]
