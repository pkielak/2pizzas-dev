# Base agent sandbox: common tooling for all coding agents.
# Agent-specific layers live in ./pi and ./opencode.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git openssh-client \
    build-essential jq unzip tar xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22: pi 0.82.x requires >= 22.19.0 (its bundled undici uses Node 22 APIs)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# tea CLI
RUN curl -fsSL -o /usr/local/bin/tea \
      https://dl.gitea.com/tea/0.15.1/tea-0.15.1-linux-amd64 \
    && chmod +x /usr/local/bin/tea

# gitleaks (static binary) — deterministic secret scan over git history
RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz" \
    | tar xz -C /usr/local/bin gitleaks

# semgrep — deterministic code/security scanner for agents and the reviewer.
# The registry rule packs (p/secrets + auto) are downloaded at build time and
# baked as LOCAL configs in /etc/semgrep — the gVisor sandbox then needs NO
# runtime egress to the semgrep registry. A build failure here is deliberate:
# missing rules mean the sandboxed scan silently finds nothing.
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip curl \
    && python3 -m pip install --break-system-packages semgrep \
    && mkdir -p /etc/semgrep /tmp/sgwarm \
    && curl -fsSL -o /etc/semgrep/secrets.yaml https://semgrep.dev/c/p/secrets \
    && curl -fsSL -o /etc/semgrep/auto.yaml https://semgrep.dev/c/auto \
    && echo 'x = 1' > /tmp/sgwarm/x.py \
    && semgrep scan --config /etc/semgrep/secrets.yaml --config /etc/semgrep/auto.yaml /tmp/sgwarm \
    && rm -rf /tmp/sgwarm /var/lib/apt/lists/*

# Pre-configure tea (Gitea CLI)
# Token is injected via env at runtime (see 2pizzas bootstrap)
# This just sets the endpoint so tea doesn't prompt
ARG GITEA_HOST=host.docker.internal:3000
ARG GITEA_USER=admin
RUN mkdir -p /root/.config/tea \
    && cat > /root/.config/tea/config.yml << 'EOF'
endpoint: http://GITEA_HOST_PLACEHOLDER
user: GITEA_USER_PLACEHOLDER
EOF
# substitute the ARGs (heredoc above can't expand them directly)
RUN sed -i "s|GITEA_HOST_PLACEHOLDER|${GITEA_HOST}|; s|GITEA_USER_PLACEHOLDER|${GITEA_USER}|" /root/.config/tea/config.yml

CMD ["sleep", "infinity"]
