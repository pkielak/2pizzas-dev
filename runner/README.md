# runner

Gitea Actions runners for this instance. Two of them, deliberately separate:

| Runner | Label | Runtime | Purpose |
|---|---|---|---|
| `my-runner` | `ubuntu-latest` | runc | ordinary CI (mirror-to-github, security-scan gate) |
| `android-runner` | `android` | runc | native Android builds (Capacitor APKs) |

**Agents do NOT run on these runners** — agent jobs are one-shot runsc
containers launched by 2pizzas (`agent-sandbox/`), not Actions runs.

## Files

```
config.yaml           shared runner config (joins the gitea_gitea compose network)
android/Dockerfile    gitea-android:latest — job image for the `android` label
```

## The android job image

Job containers are ephemeral, so the **image layer is the only place a
Gradle cache survives between runs**. `android/Dockerfile` bakes JDK 21 +
Android SDK + a pre-warmed `~/.gradle` (built by compiling a throwaway
Capacitor project) on the stock ubuntu-latest job image — without it every
job re-downloads ~300 MB.

```bash
docker build -t gitea-android:latest runner/android
```

Rebuild it when the baked Capacitor/AGP/SDK set changes. Release signing
(when needed): keystore goes in `.env` + the runner's `env:`, never into the
image.

Details: root `AGENTS.md`.
