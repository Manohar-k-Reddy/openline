#!/usr/bin/env bash
# Build and run the call-audio probe as the shell UID (same identity Shizuku uses).
# Usage: ./probe.sh build        -> compile + dex to probe.jar
#        ./probe.sh tts ["text"]  -> Gemini TTS into build/tts.wav (needs GEMINI_API_KEY)
#        ./probe.sh run [secs]    -> push + run during an ACTIVE call, then pull WAVs
#                                   (plays build/tts.wav if present, else beeps)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite /data/... device paths
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
SDK="${SDK//\\//}"
ADB="$SDK/platform-tools/adb"
ANDROID_JAR="$(ls -d "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
D8="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)d8"
[ -f "$D8" ] || D8="$D8.bat"

case "${1:-}" in
  build)
    rm -rf build/classes build/probe.jar && mkdir -p build/classes
    javac -source 11 -target 11 -Xlint:-options -cp "$ANDROID_JAR" -d build/classes CallAudioProbe.java
    "$D8" --min-api 29 --output build/probe.jar build/classes/*.class
    echo "built build/probe.jar"
    ;;
  tts)
    # needs GEMINI_API_KEY in the environment
    python tts.py "${2:-Hello! This is the HTTP Gateway voice test. If you can hear me clearly, the AI audio injection into this phone call is working.}" build/tts.wav
    ;;
  run)
    "$ADB" push build/probe.jar /data/local/tmp/probe.jar >/dev/null
    WAV_ARG=""
    if [ -f build/tts.wav ]; then
      "$ADB" push build/tts.wav /data/local/tmp/tts.wav >/dev/null
      WAV_ARG=/data/local/tmp/tts.wav
    fi
    "$ADB" shell CLASSPATH=/data/local/tmp/probe.jar app_process / CallAudioProbe "${2:-20}" $WAV_ARG
    "$ADB" pull /data/local/tmp/downlink.wav build/ >/dev/null 2>&1 || true
    "$ADB" pull /data/local/tmp/uplink.wav build/ >/dev/null 2>&1 || true
    echo "WAVs (if any) in $(pwd)/build"
    ;;
  *) echo "usage: $0 build | tts [text] | run [seconds]"; exit 1 ;;
esac
