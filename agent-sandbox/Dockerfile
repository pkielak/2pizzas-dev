# Base agent sandbox: common tooling for all coding agents.
# Agent-specific layers live in ./pi and ./opencode.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git openssh-client \
    build-essential jq unzip tar xz-utils ttyd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# tea CLI
RUN curl -fsSL -o /usr/local/bin/tea \
      https://dl.gitea.com/tea/0.15.1/tea-0.15.1-linux-amd64 \
    && chmod +x /usr/local/bin/tea

# Pre-configure tea (Gitea CLI)
# Token is injected via env at runtime (see runner-pi/config.yaml)
# This just sets the endpoint so tea doesn't prompt
RUN mkdir -p /root/.config/tea \
    && cat > /root/.config/tea/config.yml << 'EOF'
endpoint: http://host.openshell.internal:3000
user: USER
EOF

CMD ["sleep", "infinity"]
