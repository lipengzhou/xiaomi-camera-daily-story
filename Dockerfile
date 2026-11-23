# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS media-base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM media-base AS build

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS test

COPY public ./public
COPY test ./test
COPY container-test ./container-test
RUN npm run check
CMD ["npm", "run", "test:container"]

FROM media-base AS runtime

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public

ENV NODE_ENV=production \
    XIAOMI_STORY_RUNTIME=fnos \
    TZ=Asia/Shanghai

USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
