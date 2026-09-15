# Ops sandbox: the pi agent plus the Docker CLI.
#
# The ops workflow (ops-assist.yaml, infra repo only) mounts
# /var/run/docker.sock (host daemon) and the live infra dir at /infra,
# so this agent can operate the stack: compose up/logs, image rebuilds,
# runner re-registration.
FROM agent-sandbox:pi

ARG DOCKER_VERSION=27.5.1
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

CMD ["sleep", "infinity"]
