# The AI's own place: a small Linux with the AI app in it and nothing of yours.
# Built once, with network. Run without network of its own (see ../sandbox.md).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code --no-audit --no-fund && npm cache clean --force
# Not root, and no access to anything outside /work.
USER node
WORKDIR /work
