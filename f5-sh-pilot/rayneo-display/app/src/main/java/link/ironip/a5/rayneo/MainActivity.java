package link.ironip.a5.rayneo;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.PowerManager;
import android.view.View;
import android.view.WindowManager;
import android.media.AudioManager;
import android.media.SoundPool;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import com.ffalcon.mercury.android.sdk.ui.activity.BaseMirrorActivity;
import link.ironip.a5.rayneo.databinding.ActivityMainBinding;
import org.json.JSONObject;

public final class MainActivity extends BaseMirrorActivity<ActivityMainBinding> {
    // 按雷鸟最高亮度 6000 nits 线性假设，1/6 对应约 1000 nits；不是实测光学亮度。
    private static final float FIXED_BRIGHTNESS = 1.0f / 6.0f;
    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock displayWakeLock;
    private Ledger ledger;
    private BridgeServer bridge;
    private boolean foreground, fault;
    private Display active;
    private SoundPool tone;
    private int cueId;
    private boolean cueReady;
    private String cuePreparationError;
    private AudioFocusRequest cueFocus;
    private static final class Display {
        final JSONObject request;
        int drawnEyes, hiddenEyes;
        boolean drawn, failed, hiding, confirmed, cueFailed;
        String hideReason;
        Display(JSONObject request) { this.request = request; }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyFixedBrightness();
        setTurnScreenOn(true);
        if (tone == null) {
            try {
                tone = new SoundPool.Builder().setMaxStreams(1).setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()).build();
                tone.setOnLoadCompleteListener((pool, sample, status) -> { cueReady = status == 0; if (!cueReady) cuePreparationError = "device_audio_load_failed"; });
                cueId = tone.load(this, R.raw.notification, 1);
            }
            catch (RuntimeException error) { cuePreparationError = "device_audio_initialization_failed"; }
        }
        getWindow().getDecorView().setSystemUiVisibility(5894);
        try { ledger = new Ledger(this); bridge = new BridgeServer(main, this::command); }
        catch (Exception error) { fault = true; android.util.Log.e("A5", "显示端初始化失败", error); }
    }
    private MessageView left() { return (MessageView) getMBindingPair().getLeft().getRoot(); }
    private MessageView right() { return (MessageView) getMBindingPair().getRight().getRoot(); }
    /** 处理本地控制协议；状态包含安装包身份，展示请求先经校验与永久去重。 */
    private JSONObject command(JSONObject envelope) throws Exception {
        String command = envelope.getString("command"); JSONObject payload = envelope.getJSONObject("payload");
        if (command.equals("status")) return new JSONObject().put("ready", isDisplayReady())
            .put("busy", active != null).put("ledger_id", ledger.id)
            .put("device_info", new JSONObject().put("model", android.os.Build.MODEL).put("manufacturer", android.os.Build.MANUFACTURER)
                .put("firmware", android.os.Build.DISPLAY).put("android_api", Integer.toString(android.os.Build.VERSION.SDK_INT))
                .put("mercury_sdk", "0.2.6-20260310143142_94a01a90").put("app_package", getPackageName())
                .put("display_modes", "legacy_8500,tone_8500,confirm_until_ack")
                .put("app_version", "1.1.4").put("fixed_duration_ms", "8500,11000").put("frame_evidence", "android_dual_eye_onDraw")
                .put("interactive", Boolean.toString(((PowerManager)getSystemService(POWER_SERVICE)).isInteractive())));
        if (command.equals("events")) return new JSONObject().put("ledger_id", ledger.id).put("events", ledger.events(payload.getLong("after")));
        if (command.equals("confirm") || command.equals("cancel")) {
            String requestId = payload.getString("request_id"), deviceId = payload.getString("device_id");
            if (ledger.hasEvent(requestId, deviceId, command.equals("confirm") ? "confirmed" : "hidden"))
                return new JSONObject().put("request_id", requestId).put("deduplicated", true);
            Display display = active;
            if (display == null || !display.request.getString("request_id").equals(requestId) || !display.request.getString("device_id").equals(deviceId)) throw new IllegalStateException("device_confirmation_request_mismatch");
            if (!mode(display).equals("confirm_until_ack")) throw new IllegalStateException("device_confirmation_not_required");
            if (command.equals("cancel")) { fail(display, "experiment_stopped"); hide(display, "experiment_stopped"); }
            else {
                if (!display.drawn || display.failed || display.hiding) throw new IllegalStateException("device_not_confirmable");
                if (!display.confirmed) {
                    display.confirmed = true; event(display, "confirmed", null);
                    hide(display, "user_confirmed");
                }
            }
            return new JSONObject().put("request_id", requestId);
        }
        if (!command.equals("show")) throw new IllegalArgumentException("unknown_command");
        validate(payload);
        if (ledger.duplicate(payload)) return new JSONObject().put("request_id", payload.getString("request_id")).put("deduplicated", true).put("text_sha256", Ledger.textHash(payload.getString("text")));
        if (!isDisplayReady()) throw new IllegalStateException("device_display_not_ready");
        holdDisplayAwake();
        if (active != null) throw new IllegalStateException("device_busy_no_queue");
        if (!left().prepare(payload.getString("text")) || !right().prepare(payload.getString("text"))) throw new IllegalArgumentException("device_text_does_not_fit");
        // 先落盘；若接受后崩溃，恢复只报告未知，永不重放刺激。
        ledger.accept(payload);
        Display display = new Display(payload); active = display;
        left().show(() -> eyeDrawn(display)); right().show(() -> eyeDrawn(display));
        main.postDelayed(() -> {
            if (active == display && !display.drawn) { fail(display, "device_draw_timeout"); hide(display, "draw_timeout"); }
        }, 2000);
        return new JSONObject().put("request_id", payload.getString("request_id")).put("deduplicated", false).put("text_sha256", Ledger.textHash(payload.getString("text")))
            .put("layout", new JSONObject().put("left", left().metrics()).put("right", right().metrics()));
    }
    private void validate(JSONObject request) throws Exception {
        for (String key : new String[]{"request_id", "session_id", "participant_id", "stage_id", "message_id", "device_id"}) {
            String value = request.getString(key);
            if (value.isEmpty() || value.length() > 160) throw new IllegalArgumentException("invalid_" + key);
        }
        String text = request.getString("text");
        int duration = request.getInt("duration_ms");
        if (text.trim().isEmpty() || text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 16000 || (duration != 8500 && duration != 11000))
            throw new IllegalArgumentException("invalid_stimulus");
        String mode = request.optString("display_mode", "legacy_8500");
        if (!mode.equals("legacy_8500") && !mode.equals("tone_8500") && !mode.equals("confirm_until_ack")) throw new IllegalArgumentException("invalid_display_mode");
    }
    private long event(Display display, String kind, String error) {
        try { return ledger.event(display.request, kind, error, kind.equals("hidden") ? display.hideReason : null); }
        catch (Exception failure) { fault = true; android.util.Log.e("A5", "设备证据落盘失败", failure); return -1; }
    }
    private void fail(Display display, String error) {
        if (!display.failed) { display.failed = true; event(display, "failed", error); }
    }
    private String mode(Display display) { return display.request.optString("display_mode", "legacy_8500"); }
    private void eyeDrawn(Display display) {
        if (active != display || display.hiding || ++display.drawnEyes != 2) return;
        display.drawn = true;
        // 从双眼应用绘制回调起独立计时；网络、电脑实验页面和回执轮询不参与。
        long drawnAt = event(display, "drawn", null);
        if (drawnAt < 0) { fail(display, "device_draw_evidence_failed"); hide(display, "evidence_failure"); return; }
        if (!mode(display).equals("confirm_until_ack")) {
            long hideAt = drawnAt + display.request.optInt("duration_ms", 11000);
            main.postAtTime(() -> hide(display, "auto_timeout"), hideAt);
        }
        if (!isDisplayReady()) fail(display, "device_display_not_ready");
        if (mode(display).equals("tone_8500")) playCue(display);
    }
    private void cueFailed(Display display, String reason) {
        if (!display.cueFailed) { display.cueFailed = true; event(display, "cue_failed", reason); }
    }
    private void playCue(Display display) {
        AudioManager audio = (AudioManager)getSystemService(AUDIO_SERVICE);
        try {
            if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) { cueFailed(display, "device_audio_muted"); return; }
            if (cuePreparationError != null || tone == null || !cueReady) { cueFailed(display, cuePreparationError == null ? "device_audio_not_loaded" : cuePreparationError); return; }
            AudioFocusRequest focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(change -> { if (change < 0) cueFailed(display, "device_audio_focus_lost"); }, main).build();
            cueFocus = focus;
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                cueFailed(display, "device_audio_focus_denied"); audio.abandonAudioFocusRequest(focus); cueFocus = null; return;
            }
            if (tone.play(cueId, 1f, 1f, 1, 0, 1f) == 0) cueFailed(display, "device_audio_start_failed");
            else event(display, "cue_started", null);
            // 音频约983ms；播放后释放临时焦点，不延迟、不循环或补播。
            main.postDelayed(() -> { audio.abandonAudioFocusRequest(focus); if (cueFocus == focus) cueFocus = null; }, 1100);
        } catch (RuntimeException error) { cueFailed(display, "device_audio_start_failed"); }
    }

    private void hide(Display display, String reason) {
        if (active != display || display.hiding) return;
        display.hiding = true;
        display.hideReason = reason;
        left().hide(() -> eyeHidden(display)); right().hide(() -> eyeHidden(display));
        main.postDelayed(() -> {
            if (active == display) {
                fail(display, "device_hide_draw_timeout");
                // 两眼内容已清除，但没有可见帧回调：保留失败，不捏造hidden，也不永久锁死后续恢复。
                active = null;
            }
        }, 2000);
    }
    private void eyeHidden(Display display) {
        if (active != display || ++display.hiddenEyes != 2) return;
        if (display.drawn) event(display, "hidden", null);
        active = null;
    }
    /** 固定当前显示窗口的亮度，重新进入前台时再次应用。 */
    private void applyFixedBrightness() {
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.screenBrightness = FIXED_BRIGHTNESS;
        getWindow().setAttributes(attributes);
    }
    private boolean isDisplayReady() {
        PowerManager power = (PowerManager)getSystemService(POWER_SERVICE);
        android.view.Display screen = getWindow().getDecorView().getDisplay();
        return foreground && !fault && hasWindowFocus() && power.isInteractive()
            && screen != null && screen.getState() == android.view.Display.STATE_ON
            && left().isShown() && right().isShown() && left().getWidth() > 0 && right().getWidth() > 0;
    }
    @SuppressWarnings("deprecation")
    private void holdDisplayAwake() {
        if (displayWakeLock == null) {
            PowerManager power = (PowerManager)getSystemService(POWER_SERVICE);
            displayWakeLock = power.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, getPackageName()+":display");
            displayWakeLock.setReferenceCounted(false);
        }
        displayWakeLock.acquire(60 * 60 * 1000L);
    }
    @Override protected void onResume() { super.onResume(); applyFixedBrightness(); foreground = true; holdDisplayAwake(); }
    @Override protected void onPause() {
        foreground = false;
        if (active != null) fail(active, "device_foreground_lost");
        // 不取消或重置已启动的展示计时。
        if (displayWakeLock != null && displayWakeLock.isHeld()) displayWakeLock.release();
        super.onPause();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (!focused && active != null) fail(active, "device_window_focus_lost");
    }
    @Override protected void onDestroy() {
        if (active != null) fail(active, "device_activity_destroyed_delivery_unknown");
        if (bridge != null) bridge.close();
        if (tone != null) tone.release();
        if (cueFocus != null) ((AudioManager)getSystemService(AUDIO_SERVICE)).abandonAudioFocusRequest(cueFocus);
        if (displayWakeLock != null && displayWakeLock.isHeld()) displayWakeLock.release();
        main.removeCallbacksAndMessages(null);
        if (ledger != null) ledger.close();
        super.onDestroy();
    }
}
