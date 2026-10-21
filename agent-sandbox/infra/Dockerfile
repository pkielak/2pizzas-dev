# Infra agent: pi + docker CLI. The ONLY agent that runs on runc (not runsc)
# with the host docker socket mounted — it repairs the stack itself. 00-tea
# auto-enqueues it on infra-class task failures (dockerd restart → 143, OOM
# → 137, ...); `@infra` on gitea-with-agents works it manually. The docker
# socket IS the trust boundary here (same as 00-tea); the gVisor sandbox is
# deliberately absent.
FROM agent-sandbox:pi

RUN apt-get update && apt-get install -y --no-install-recommends docker-cli \
    && rm -rf /var/lib/apt/lists/*

CMD ["sleep", "infinity"]
