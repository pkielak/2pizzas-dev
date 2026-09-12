FROM agent-sandbox:base

RUN npm install -g opencode-ai

# opencode.json contains the API key and is gitignored.
# Create it from opencode.json.example if missing.
COPY opencode-config/ /tmp/opencode-config-check/
RUN test -f /tmp/opencode-config-check/opencode.json || \
    (echo "error: opencode-config/opencode.json not found (cp opencode-config/opencode.json.example opencode-config/opencode.json and fill in the key)" >&2 && false)
COPY opencode-config/opencode.json /root/.config/opencode/opencode.json

CMD ["sleep", "infinity"]
