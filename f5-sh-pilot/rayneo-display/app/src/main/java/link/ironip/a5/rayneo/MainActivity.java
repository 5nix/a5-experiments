package link.ironip.a5.rayneo;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.WindowManager;
import com.ffalcon.mercury.android.sdk.ui.activity.BaseMirrorActivity;
import link.ironip.a5.rayneo.databinding.ActivityMainBinding;
import org.json.JSONObject;

public final class MainActivity extends BaseMirrorActivity<ActivityMainBinding> {
    // 按雷鸟最高亮度 6000 nits 线性假设，1/6 对应约 1000 nits；不是实测光学亮度。
    private static final float FIXED_BRIGHTNESS = 1.0f / 6.0f;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Ledger ledger;
    private BridgeServer bridge;
    private boolean foreground, fault;
    private Display active;
    private static final class Display {
        final JSONObject request;
        int drawnEyes, hiddenEyes;
        boolean drawn, failed, hiding;
        Display(JSONObject request) { this.request = request; }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyFixedBrightness();
        getWindow().getDecorView().setSystemUiVisibility(5894);
        try { ledger = new Ledger(this); bridge = new BridgeServer(main, this::command); }
        catch (Exception error) { fault = true; android.util.Log.e("A5", "显示端初始化失败", error); }
    }
    private MessageView left() { return (MessageView) getMBindingPair().getLeft().getRoot(); }
    private MessageView right() { return (MessageView) getMBindingPair().getRight().getRoot(); }
    /** 处理本地控制协议；状态包含安装包身份，展示请求先经校验与永久去重。 */
    private JSONObject command(JSONObject envelope) throws Exception {
        String command = envelope.getString("command"); JSONObject payload = envelope.getJSONObject("payload");
        if (command.equals("status")) return new JSONObject().put("ready", foreground && !fault && hasWindowFocus() && left().getWidth() > 0 && right().getWidth() > 0)
            .put("busy", active != null).put("ledger_id", ledger.id)
            .put("device_info", new JSONObject().put("model", android.os.Build.MODEL).put("manufacturer", android.os.Build.MANUFACTURER)
                .put("firmware", android.os.Build.DISPLAY).put("android_api", Integer.toString(android.os.Build.VERSION.SDK_INT))
                .put("mercury_sdk", "0.2.6-20260310143142_94a01a90").put("app_package", getPackageName()));
        if (command.equals("events")) return new JSONObject().put("ledger_id", ledger.id).put("events", ledger.events(payload.getLong("after")));
        if (!command.equals("show")) throw new IllegalArgumentException("unknown_command");
        validate(payload);
        if (ledger.duplicate(payload)) return new JSONObject().put("request_id", payload.getString("request_id")).put("deduplicated", true).put("text_sha256", Ledger.textHash(payload.getString("text")));
        if (!foreground || !hasWindowFocus() || fault) throw new IllegalStateException("device_not_foreground");
        if (active != null) throw new IllegalStateException("device_busy_no_queue");
        if (!left().prepare(payload.getString("text")) || !right().prepare(payload.getString("text"))) throw new IllegalArgumentException("device_text_does_not_fit");
        // 先落盘；若接受后崩溃，恢复只报告未知，永不重放刺激。
        ledger.accept(payload);
        Display display = new Display(payload); active = display;
        left().show(() -> eyeDrawn(display)); right().show(() -> eyeDrawn(display));
        main.postDelayed(() -> {
            if (active == display && !display.drawn) { fail(display, "device_draw_timeout"); hide(display); }
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
        if (text.trim().isEmpty() || text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 16000 || request.getInt("duration_ms") != 8500)
            throw new IllegalArgumentException("invalid_stimulus");
    }
    private void event(Display display, String kind, String error) {
        try { ledger.event(display.request, kind, error); }
        catch (Exception failure) { fault = true; android.util.Log.e("A5", "设备证据落盘失败", failure); }
    }
    private void fail(Display display, String error) {
        if (!display.failed) { display.failed = true; event(display, "failed", error); }
    }
    private void eyeDrawn(Display display) {
        if (active != display || display.hiding || ++display.drawnEyes != 2) return;
        display.drawn = true;
        // 从双眼应用绘制回调起独立计时；网络、电脑实验页面和回执轮询不参与。
        long hideAt = SystemClock.uptimeMillis() + 8500;
        main.postAtTime(() -> hide(display), hideAt);
        event(display, "drawn", null);
        if (!foreground || !hasWindowFocus()) fail(display, "device_foreground_lost");
    }
    private void hide(Display display) {
        if (active != display || display.hiding) return;
        display.hiding = true;
        left().hide(() -> eyeHidden(display)); right().hide(() -> eyeHidden(display));
        main.postDelayed(() -> {
            if (active == display) fail(display, "device_hide_draw_timeout");
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
    @Override protected void onResume() { super.onResume(); applyFixedBrightness(); foreground = true; }
    @Override protected void onPause() {
        foreground = false;
        if (active != null) fail(active, "device_foreground_lost");
        // 不取消或重置已启动的展示计时。
        super.onPause();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (!focused && active != null) fail(active, "device_window_focus_lost");
    }
    @Override protected void onDestroy() {
        if (active != null) fail(active, "device_activity_destroyed_delivery_unknown");
        if (bridge != null) bridge.close();
        main.removeCallbacksAndMessages(null);
        if (ledger != null) ledger.close();
        super.onDestroy();
    }
}
