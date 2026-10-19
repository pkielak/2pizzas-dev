# Android build job image for the `android` runner label (android-runner).
#
# Base = stock Gitea Actions ubuntu-latest job image (Ubuntu 24.04, Node 24,
# git, ...). Adds JDK 21 (current Capacitor 7 templates need it) and the Android
# SDK, then PRE-WARMS ~/.gradle by building a throwaway Capacitor project so
# the Gradle wrapper distribution + AGP dependencies are cached in the image
# layer. Job containers are ephemeral — the image layer is the only place a
# cache survives between runs, so without this every job re-downloads ~300 MB.
#
# Build: docker build -t gitea-android:latest runner/android
FROM docker.gitea.com/runner-images:ubuntu-latest

ENV DEBIAN_FRONTEND=noninteractive

# JDK 21 — current @capacitor/android@7 templates set sourceCompatibility 21
# (AGP 8.x works with 17+, but the template needs 21). Stock image: no JDK.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

# Android SDK (cmdline-tools + what Capacitor 7 templates need; 34 AND 35 so
# both older and newer @capacitor/android templates compile).
ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL -o /tmp/cmdline-tools.zip \
         https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip
# sh -c: the build shell runs `bash -o pipefail`, where `yes |` dies with
# SIGPIPE (141) once sdkmanager stops reading — dash has no pipefail.
RUN sh -c 'yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null' \
    && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
        "platform-tools" \
        "build-tools;34.0.0" "build-tools;35.0.0" \
        "platforms;android-34" "platforms;android-35"
ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Pre-warm ~/.gradle (runs as root, HOME=/root — job containers run as root
# too, so the cache is visible to jobs). Builds a minimal Capacitor app:
# downloads the Gradle wrapper distribution + AGP + all plugin deps.
RUN set -eux \
    && mkdir -p /warmup/build \
    && cd /warmup \
    && echo '<html></html>' > build/index.html \
    && echo '{"name":"warmup","version":"0.0.0","private":true}' > package.json \
    && echo '{"appId":"app.warmup","appName":"warmup","webDir":"build"}' > capacitor.config.json \
    && npm install --no-audit --no-fund @capacitor/cli@7 @capacitor/android@7 \
    && npx cap add android \
    && cd android \
    && ./gradlew --no-daemon assembleDebug \
    && cd / \
    && rm -rf /warmup
