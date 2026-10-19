FROM agent-sandbox:base

# pi CLI — pinned for reproducibility; bump deliberately and re-run the
# smoke test (pi >= 0.82 needs Node >= 22.19, see the base image).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.1

# pi >= 0.8x bundles llama.cpp as an EXTENSION provider: auth resolution
# delegates to it and refuses to resolve without LLAMA_BASE_URL (the
# models.json baseUrl is only used for model definitions). Without this the
# run dies instantly with "Provider is not configured: llama.cpp".
ARG LLAMA_BASE_URL=http://localhost:8080
ENV LLAMA_BASE_URL=${LLAMA_BASE_URL}

# models.json contains the API key and is gitignored.
# Create it from models.json.example if missing.
COPY pi-settings/ /tmp/pi-settings-check/
RUN test -f /tmp/pi-settings-check/models.json || \
    (echo "error: pi-settings/models.json not found (cp pi-settings/models.json.example pi-settings/models.json and fill in the key)" >&2 && false)
COPY pi-settings/models.json   /root/.pi/agent/models.json
COPY pi-settings/settings.json /root/.pi/agent/settings.json

CMD ["sleep", "infinity"]
