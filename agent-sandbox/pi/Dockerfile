FROM agent-sandbox:base

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# models.json contains the API key and is gitignored.
# Create it from models.json.example if missing.
COPY pi-settings/ /tmp/pi-settings-check/
RUN test -f /tmp/pi-settings-check/models.json || \
    (echo "error: pi-settings/models.json not found (cp pi-settings/models.json.example pi-settings/models.json and fill in the key)" >&2 && false)
COPY pi-settings/models.json   /root/.pi/agent/models.json
COPY pi-settings/settings.json /root/.pi/agent/settings.json

CMD ["sleep", "infinity"]
