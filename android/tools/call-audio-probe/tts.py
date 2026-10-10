"""Generate a speech WAV with Gemini TTS for the call-audio probe.

Usage: GEMINI_API_KEY=... python tts.py "text to speak" out.wav
Output: 24 kHz, 16-bit, mono PCM WAV.
"""
import base64
import json
import os
import sys
import urllib.request
import wave

MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
VOICE = os.environ.get("GEMINI_TTS_VOICE", "Kore")


def main() -> None:
    text, out = sys.argv[1], sys.argv[2]
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}},
        },
    }
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    part = data["candidates"][0]["content"]["parts"][0]["inlineData"]
    pcm = base64.b64decode(part["data"])
    rate = 24000
    for kv in part.get("mimeType", "").split(";"):
        if kv.strip().startswith("rate="):
            rate = int(kv.split("=")[1])
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    print(f"wrote {out}: {len(pcm) / 2 / rate:.1f}s @ {rate} Hz ({MODEL}/{VOICE})")


if __name__ == "__main__":
    main()
