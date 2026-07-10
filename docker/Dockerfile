FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

RUN useradd --create-home --shell /bin/bash wake \
  && mkdir -p /home/wake/.codex-runtime \
  && mkdir -p /home/wake/.cursor \
  && chown -R wake:wake /home/wake/.codex-runtime \
  && chown -R wake:wake /home/wake/.cursor

ENV CODEX_HOME=/home/wake/.codex-runtime
ENV PATH=/home/wake/.local/bin:$PATH

USER wake
WORKDIR /home/wake

RUN curl https://cursor.com/install -fsS | bash \
  && printf '#!/bin/bash\n[ "$1" = "agent" ] && shift\nexec ~/.local/bin/agent "$@"\n' \
     > ~/.local/bin/cursor \
  && chmod +x ~/.local/bin/cursor

ENTRYPOINT ["sleep", "infinity"]
