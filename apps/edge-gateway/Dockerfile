# syntax=docker/dockerfile:1
#
# GitVise sandbox image: the in-container agent (Node.js), the git-engine N-API addon from
# @gitvise/core-native (Rust, libgit2), and the build toolchain sandboxed commands need.
#
# Build context is apps/edge-gateway. Run `npm run sync:native` first, so ./native/git-engine holds
# the Rust source. Wrangler builds this image on `wrangler deploy` (containers.image in wrangler.jsonc).

# Stage 1: compile the git-engine addon for linux-x64 glibc.
FROM rust:1-bookworm AS native-build
WORKDIR /src
COPY native/git-engine/ ./git-engine/
RUN cargo build --release --manifest-path git-engine/Cargo.toml --lib \
 && mkdir -p /out \
 && cp git-engine/target/release/libgit_engine.so /out/git-engine.linux-x64-gnu.node

# Stage 2: runtime.
FROM node:24-bookworm-slim AS runtime

# git and zstd serve hydration. The build toolchain lets sandboxed commands compile code.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      zstd \
      ca-certificates \
      tini \
      build-essential \
      python3 \
      pkg-config \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    GITVISE_WORKSPACE=/workspace \
    GITVISE_REPO=/var/gitvise/repo.git \
    GITVISE_NATIVE_ENGINE=/opt/gitvise/native/git-engine.linux-x64-gnu.node

COPY --from=native-build /out/git-engine.linux-x64-gnu.node /opt/gitvise/native/
COPY container/agent.mjs /opt/gitvise/agent.mjs

RUN mkdir -p /workspace /var/gitvise \
 && chown -R node:node /workspace /var/gitvise

# The sandbox has no network and no install step, so the toolchain a cloud agent's verifier runs must be baked in.
# `tsc --noEmit` is the verifier's check. The TypeScript version tracks the monorepo's pin (~6.0.3).
# Installed as root: the node user cannot write to the global npm prefix (/usr/local/lib/node_modules).
RUN npm install -g --no-audit --no-fund typescript@~6.0.3 pnpm@10 \
 && npm cache clean --force

USER node
WORKDIR /workspace
EXPOSE 8080

# tini reaps the zombie processes that sandboxed commands leave behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/gitvise/agent.mjs"]
