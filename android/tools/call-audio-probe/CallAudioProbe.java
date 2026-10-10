import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.lang.reflect.Method;

/**
 * Feasibility probe for the Shizuku call-audio path.
 *
 * Run as the shell UID (adb shell / Shizuku) during an ACTIVE SIM call:
 *   - records VOICE_DOWNLINK (remote party)          -> downlink.wav
 *   - records VOICE_UPLINK   (what the remote hears) -> uplink.wav
 *   - plays a WAV (e.g. Gemini TTS) or beeps routed to TYPE_TELEPHONY (injection test)
 *
 * Usage: app_process / CallAudioProbe [seconds] [/data/local/tmp/tts.wav]
 * Injection works if uplink RMS rises while the clip plays and the remote party hears it.
 */
public final class CallAudioProbe {
    private static final int RATE = 16000;
    private static final String OUT = "/data/local/tmp/";

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("router")) {
            installAppContext();
            routerTest(args.length > 1 ? args[1] : null);
            return;
        }
        int seconds = args.length > 0 ? Integer.parseInt(args[0]) : 12;
        installAppContext();
        log("uid=" + android.os.Process.myUid() + " sdk=" + android.os.Build.VERSION.SDK_INT
                + " device=" + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL
                + " soc=" + android.os.Build.SOC_MODEL);

        AudioDeviceInfo telephony = findTelephonyOutput();
        log(telephony == null ? "TELEPHONY output device: NOT FOUND" : "TELEPHONY output device: id=" + telephony.getId());

        Capture down = new Capture("downlink", MediaRecorder.AudioSource.VOICE_DOWNLINK, seconds);
        Capture up = new Capture("uplink", MediaRecorder.AudioSource.VOICE_UPLINK, seconds);
        down.start();
        up.start();

        playAudio(telephony, seconds, args.length > 1 ? args[1] : null);

        down.join();
        up.join();
        log("done. pull with: adb pull " + OUT + "downlink.wav ; adb pull " + OUT + "uplink.wav");
    }

    /**
     * "Router" test: can the phone stay silent (no earpiece output, no mic) while capture and
     * injection keep working?
     *   0-5 s   baseline
     *   5-18 s  mic muted + voice-call volume at minimum, WAV injected
     *   18-26 s MODE_CALL_REDIRECT, beeps injected
     * Everything is restored at the end.
     */
    private static void routerTest(String wavPath) throws Exception {
        AudioManager am = (AudioManager) shellContext.getSystemService(android.content.Context.AUDIO_SERVICE);
        AudioDeviceInfo telephony = findTelephonyOutput();
        int savedMode = am.getMode();
        int savedVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
        boolean savedMute = am.isMicrophoneMute();
        log("ROUTER: mode=" + savedMode + " voiceVol=" + savedVolume + " (min="
                + am.getStreamMinVolume(AudioManager.STREAM_VOICE_CALL) + " max="
                + am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL) + ") micMute=" + savedMute);

        Capture down = new Capture("downlink", MediaRecorder.AudioSource.VOICE_DOWNLINK, 26);
        down.start();
        try {
            log("PHASE 1 (0-5s): baseline - remote party should talk");
            sleep(5000);

            log("PHASE 2 (5-18s): mic mute + volume 0, injecting speech");
            try { am.setMicrophoneMute(true); } catch (Exception e) { log("  setMicrophoneMute: " + e); }
            try { am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, 0, 0); } catch (Exception e) { log("  setStreamVolume: " + e); }
            try { am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_MUTE, 0); } catch (Exception e) { log("  ADJUST_MUTE: " + e); }
            log("  now voiceVol=" + am.getStreamVolume(AudioManager.STREAM_VOICE_CALL) + " micMute=" + am.isMicrophoneMute()
                    + " voiceMuted=" + am.isStreamMute(AudioManager.STREAM_VOICE_CALL));
            playAudio(telephony, 13, wavPath);

            log("PHASE 3 (18-26s): MODE_CALL_REDIRECT, injecting beeps");
            try { am.setMode(5 /* MODE_CALL_REDIRECT */); } catch (Exception e) { log("  setMode: " + e); }
            log("  now mode=" + am.getMode());
            playAudio(telephony, 8, null);
        } finally {
            try { am.setMode(savedMode); } catch (Exception ignored) { }
            try { am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_UNMUTE, 0); } catch (Exception ignored) { }
            try { am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, savedVolume, 0); } catch (Exception ignored) { }
            try { am.setMicrophoneMute(savedMute); } catch (Exception ignored) { }
            log("ROUTER: restored mode=" + am.getMode() + " voiceVol=" + am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
                    + " micMute=" + am.isMicrophoneMute());
        }
        down.join();
        log("done. per-second downlink rms above shows whether capture survived each phase");
    }

    /**
     * Bare app_process has no Application; media code (PlayerBase) needs one. Same trick as scrcpy's
     * Workarounds: fake an ActivityThread whose initial Application wraps a com.android.shell context.
     */
    private static void installAppContext() {
        try {
            android.os.Looper.prepareMainLooper();
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            java.lang.reflect.Constructor<?> ctor = atClass.getDeclaredConstructor();
            ctor.setAccessible(true);
            Object at = ctor.newInstance();
            setField(atClass, null, "sCurrentActivityThread", at);
            setField(atClass, at, "mSystemThread", true);

            Class<?> bindClass = Class.forName("android.app.ActivityThread$AppBindData");
            java.lang.reflect.Constructor<?> bindCtor = bindClass.getDeclaredConstructor();
            bindCtor.setAccessible(true);
            Object bind = bindCtor.newInstance();
            android.content.pm.ApplicationInfo info = new android.content.pm.ApplicationInfo();
            info.packageName = "com.android.shell";
            setField(bindClass, bind, "appInfo", info);
            setField(atClass, at, "mBoundApplication", bind);

            Method getSystemContext = atClass.getDeclaredMethod("getSystemContext");
            android.content.Context sys = (android.content.Context) getSystemContext.invoke(at);
            shellContext = new ShellContext(sys);
            android.app.Application app = new android.app.Application();
            setField(android.content.ContextWrapper.class, app, "mBase", shellContext);
            setField(atClass, at, "mInitialApplication", app);
            log("app context: " + shellContext.getAttributionSource());
        } catch (Throwable t) {
            log("app context workaround failed: " + t);
        }
    }

    private static android.content.Context shellContext;

    /** System context that attributes audio to uid 2000 / com.android.shell (audioserver checks the pair). */
    private static final class ShellContext extends android.content.ContextWrapper {
        ShellContext(android.content.Context base) {
            super(base);
        }

        @Override
        public String getPackageName() {
            return "com.android.shell";
        }

        @Override
        public String getOpPackageName() {
            return "com.android.shell";
        }

        @Override
        public android.content.AttributionSource getAttributionSource() {
            return new android.content.AttributionSource.Builder(android.os.Process.SHELL_UID)
                    .setPackageName("com.android.shell")
                    .build();
        }

        @Override
        public android.content.Context getApplicationContext() {
            return this;
        }
    }

    private static void setField(Class<?> cls, Object target, String name, Object value) throws Exception {
        java.lang.reflect.Field f = cls.getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }

    private static AudioDeviceInfo findTelephonyOutput() {
        try {
            Method m = AudioManager.class.getDeclaredMethod("getDevicesStatic", int.class);
            m.setAccessible(true);
            AudioDeviceInfo[] devices = (AudioDeviceInfo[]) m.invoke(null, AudioManager.GET_DEVICES_OUTPUTS);
            StringBuilder all = new StringBuilder();
            AudioDeviceInfo found = null;
            for (AudioDeviceInfo d : devices) {
                all.append(d.getType()).append(' ');
                if (d.getType() == AudioDeviceInfo.TYPE_TELEPHONY) found = d;
            }
            log("output device types: " + all);
            return found;
        } catch (Exception e) {
            log("getDevicesStatic failed: " + e);
            return null;
        }
    }

    /** Reads a 16-bit mono PCM WAV (44-byte header). Returns {rate, samples...} packed as int rate + short[]. */
    private static short[] readWav(String path, int[] rateOut) throws IOException {
        byte[] all = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path));
        java.nio.ByteBuffer b = java.nio.ByteBuffer.wrap(all).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        rateOut[0] = b.getInt(24);
        short[] pcm = new short[(all.length - 44) / 2];
        b.position(44);
        b.asShortBuffer().get(pcm);
        return pcm;
    }

    /** Loops the WAV (1 s gap between repeats) for `seconds` seconds; 800 Hz beeps if no WAV given. */
    private static void playAudio(AudioDeviceInfo telephony, int seconds, String wavPath) {
        int rate = RATE;
        short[] clip;
        if (wavPath != null) {
            try {
                int[] r = new int[1];
                short[] speech = readWav(wavPath, r);
                rate = r[0];
                clip = java.util.Arrays.copyOf(speech, speech.length + rate); // + 1 s silence
                log("INJECT: playing " + wavPath + " (" + speech.length / rate + " s @ " + rate + " Hz)");
            } catch (IOException e) {
                log("INJECT: cannot read " + wavPath + ": " + e);
                return;
            }
        } else {
            clip = new short[rate]; // 0.5 s beep + 0.5 s silence
            for (int j = 0; j < rate / 2; j++) clip[j] = (short) (Math.sin(2 * Math.PI * 800 * j / rate) * 12000);
            log("INJECT: playing beeps");
        }
        int minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack track;
        try {
            AudioTrack.Builder tb = new AudioTrack.Builder();
            if (shellContext != null && android.os.Build.VERSION.SDK_INT >= 34) tb.setContext(shellContext);
            track = tb
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(rate)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(minBuf * 4)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
        } catch (Exception e) {
            log("INJECT: AudioTrack creation failed: " + e);
            sleep(seconds * 1000L);
            return;
        }
        if (telephony != null) log("INJECT: setPreferredDevice(TELEPHONY) -> " + track.setPreferredDevice(telephony));
        track.play();

        short[] chunk = new short[rate / 10]; // 100 ms
        int pos = 0;
        for (int i = 0; i < seconds * 10; i++) {
            for (int j = 0; j < chunk.length; j++) {
                chunk[j] = clip[pos];
                pos = (pos + 1) % clip.length;
            }
            track.write(chunk, 0, chunk.length);
            if (i == 5) {
                AudioDeviceInfo routed = track.getRoutedDevice();
                log("INJECT: routed device type=" + (routed == null ? "null" : routed.getType())
                        + (routed != null && routed.getType() == AudioDeviceInfo.TYPE_TELEPHONY ? "  <-- TELEPHONY OK" : "  <-- NOT telephony"));
            }
        }
        track.stop();
        track.release();
    }

    private static final class Capture extends Thread {
        private final String name;
        private final int source;
        private final int seconds;

        Capture(String name, int source, int seconds) {
            this.name = name;
            this.source = source;
            this.seconds = seconds;
        }

        @Override
        public void run() {
            int minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord rec;
            try {
                AudioRecord.Builder b = new AudioRecord.Builder()
                        .setAudioSource(source)
                        .setAudioFormat(new AudioFormat.Builder()
                                .setSampleRate(RATE)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                .build())
                        .setBufferSizeInBytes(minBuf * 4);
                if (shellContext != null) b.setContext(shellContext);
                rec = b.build();
            } catch (Exception e) {
                log(name + ": AudioRecord creation failed: " + e);
                return;
            }
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                log(name + ": AudioRecord NOT initialized (permission or source unsupported)");
                rec.release();
                return;
            }
            String path = OUT + name + ".wav";
            try (RandomAccessFile wav = new RandomAccessFile(path, "rw")) {
                wav.setLength(0);
                wav.write(new byte[44]);
                rec.startRecording();
                short[] buf = new short[RATE];
                byte[] bytes = new byte[RATE * 2];
                int total = 0;
                for (int s = 0; s < seconds; s++) {
                    int got = 0;
                    while (got < buf.length) {
                        int r = rec.read(buf, got, buf.length - got);
                        if (r <= 0) break;
                        got += r;
                    }
                    double sum = 0;
                    for (int i = 0; i < got; i++) {
                        sum += (double) buf[i] * buf[i];
                        bytes[2 * i] = (byte) buf[i];
                        bytes[2 * i + 1] = (byte) (buf[i] >> 8);
                    }
                    wav.write(bytes, 0, got * 2);
                    total += got * 2;
                    log(String.format("%-8s sec %2d  rms=%6.0f%s", name, s, got == 0 ? 0 : Math.sqrt(sum / got),
                            got == 0 ? "  (no samples)" : ""));
                }
                rec.stop();
                writeHeader(wav, total);
            } catch (IOException e) {
                log(name + ": write failed: " + e);
            } finally {
                rec.release();
            }
        }
    }

    private static void writeHeader(RandomAccessFile f, int dataLen) throws IOException {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + dataLen).put("WAVE".getBytes())
                .put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes()).putInt(dataLen);
        f.seek(0);
        f.write(b.array());
    }

    private static synchronized void log(String msg) {
        System.out.println(msg);
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }
}
