package com.example.hello;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import com.example.hello.databinding.ActivityMainBinding;
import com.ffalcon.mercury.android.sdk.ui.activity.BaseMirrorActivity;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BaseMirrorActivity<ActivityMainBinding> {
    private static final String INSTRUCTIONS = "接下来您会看到不同的现实背景照片，\n同时眼镜中会出现文本。请您阅读文本，\n同时轻微转动头部，\n感受文字在照片不同位置的效果。\n每次体验后，将会问您一些问题，\n请根据真实感受回答。\n全部完成后会在眼镜中听到“滴滴”的声音。";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PhotoSession session;
    private List<PhotoSession.Material> materials;
    private boolean foreground, controlRegistered, fatalError, completionSoundPlayed;
    private String controlToken = "";
    private MediaPlayer completionPlayer;
    private AudioManager audioManager;
    private int previousVolume = -1, temporaryVolume = -1;
    private final BroadcastReceiver computerControl = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String result = command(intent);
            setResultCode(result.startsWith("OK ") ? 1 : -1); setResultData(result);
        }
    };
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                android.view.View.SYSTEM_UI_FLAG_FULLSCREEN |
                android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        try {
            materials = loadMaterials();
            reset();
            IntentFilter filter = new IntentFilter("com.example.f0photo.main.CONTROL");
            if (Build.VERSION.SDK_INT >= 33)
                registerReceiver(computerControl, filter, "android.permission.DUMP", handler, Context.RECEIVER_EXPORTED);
            else registerReceiver(computerControl, filter, "android.permission.DUMP", handler);
            controlRegistered = true;
        } catch (Exception e) {
            fatalError = true; message("材料读取失败\n" + e.getMessage(), false);
        }
    }
    private List<PhotoSession.Material> loadMaterials() throws Exception {
        List<PhotoSession.Material> values = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                getAssets().open("materials.csv"), StandardCharsets.UTF_8))) {
            String header = reader.readLine();
            if (header == null || !header.replace("\uFEFF", "").equals("id,text"))
                throw new IllegalArgumentException("表头须为id,text");
            String row;
            while ((row = reader.readLine()) != null) {
                if (row.trim().isEmpty()) continue;
                int separator = row.indexOf(',');
                if (separator < 1) throw new IllegalArgumentException("材料须有id和text两列");
                String text = row.substring(separator + 1);
                if (text.startsWith("\"") && text.endsWith("\""))
                    text = text.substring(1, text.length()-1).replace("\"\"", "\"");
                values.add(new PhotoSession.Material(Integer.parseInt(row.substring(0,separator)),text));
            }
        }
        return values;
    }
    private StimulusView left() { return (StimulusView) getMBindingPair().getLeft().getRoot(); }
    private StimulusView right() { return (StimulusView) getMBindingPair().getRight().getRoot(); }
    private void message(String text, boolean cross) {
        left().showMessage(text, cross); right().showMessage(text, cross);
    }
    private void reset() {
        session = new PhotoSession(materials); controlToken = ""; completionSoundPlayed = false;
        prepareCompletionSound(); message(INSTRUCTIONS, true);
    }
    private void display() {
        if (session.state == PhotoSession.State.SHOWING) {
            String text = session.current().text;
            right().showFrame(text, null); left().showFrame(text, null);
        } else if (session.state == PhotoSession.State.CLEARING) {
            right().showFrame(null, null);
            left().showFrame(null, () -> {
                if (session.blankDrawn()) {
                    playCompletionSound();
                    message("实验结束", false);
                }
            });
        }
    }
    private String status() {
        return session.state == PhotoSession.State.SHOWING ? "SHOWING_" + session.current().id : session.state.name();
    }
    private String navigate(String action) {
        boolean changed;
        switch (action) {
            case "start": changed = session.start(); break;
            case "1": changed = session.previous(); break;
            case "2": changed = session.next(); break;
            default: return "ERROR UNKNOWN_COMMAND";
        }
        if (changed) display();
        return "OK " + status();
    }
    private String command(Intent intent) {
        if (fatalError || !foreground || session == null) return "ERROR APP_NOT_READY";
        String action = intent.getStringExtra("command"), token = intent.getStringExtra("token");
        if (token == null || !token.matches("[a-fA-F0-9]{32}")) return "ERROR INVALID_TOKEN";
        if ("prepare".equals(action)) {
            if (session.state != PhotoSession.State.READY) return "ERROR RESTART_REQUIRED";
            controlToken = token; return "OK READY";
        }
        if (!token.equals(controlToken)) return "ERROR PREPARE_REQUIRED";
        if ("status".equals(action)) return "OK " + status();
        return navigate(action);
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (fatalError || session == null) return super.dispatchKeyEvent(event);
        if (event.getAction() != KeyEvent.ACTION_DOWN || event.getRepeatCount() > 0) return true;
        if (!foreground) return true;
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_SPACE: navigate("start"); break;
            case KeyEvent.KEYCODE_1:
            case KeyEvent.KEYCODE_NUMPAD_1: navigate("1"); break;
            case KeyEvent.KEYCODE_2:
            case KeyEvent.KEYCODE_NUMPAD_2: navigate("2"); break;
            case KeyEvent.KEYCODE_ESCAPE: finish(); break;
            default: break;
        }
        return true;
    }
    // The temple is not a navigation control in this version. Avoid base double-click exit.
    @Override public boolean dispatchTouchEvent(MotionEvent event) { return true; }
    @Override protected void onResume() {
        super.onResume(); foreground = true;
        left().setFocusableInTouchMode(true); left().requestFocus();
    }
    @Override protected void onPause() { foreground = false; super.onPause(); }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (session != null && session.state == PhotoSession.State.FINISHED) reset();
    }
    @Override protected void onDestroy() {
        if (controlRegistered) unregisterReceiver(computerControl);
        handler.removeCallbacksAndMessages(null); releaseCompletionSound(); super.onDestroy();
    }
    private void prepareCompletionSound() {
        releaseCompletionSound();
        try {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
            completionPlayer = MediaPlayer.create(this, R.raw.completion_beep, attributes, 0);
            if (completionPlayer == null) throw new IllegalStateException("Cannot load completion_beep.wav");
            completionPlayer.setVolume(1f, 1f);
            // Prefer the glasses' built-in speaker instead of a connected external audio device.
            if (audioManager != null) for (AudioDeviceInfo device :
                    audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    completionPlayer.setPreferredDevice(device); break;
                }
            }
            completionPlayer.setOnCompletionListener(player -> restoreVolume());
            completionPlayer.setOnErrorListener((player, what, extra) -> {
                Log.e("F0", "Completion audio failed: " + what + "/" + extra);
                restoreVolume(); return true;
            });
        } catch (RuntimeException e) {
            Log.e("F0", "Unable to prepare completion audio", e);
            releaseCompletionSound();
        }
    }
    private void playCompletionSound() {
        if (completionSoundPlayed || session.state != PhotoSession.State.FINISHED) return;
        completionSoundPlayed = true;
        try {
            if (completionPlayer == null) prepareCompletionSound();
            if (completionPlayer == null) return;
            if (audioManager != null) {
                int volume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
                int minimum = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC) / 2);
                if (volume < minimum) {
                    previousVolume = volume; temporaryVolume = minimum;
                    try { audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, minimum, 0); }
                    catch (RuntimeException e) { Log.w("F0", "Cannot raise media volume", e); }
                }
            }
            completionPlayer.start();
            handler.postDelayed(this::restoreVolume, 1500);
        } catch (RuntimeException e) {
            Log.e("F0", "Completion audio unavailable", e);
            restoreVolume();
        }
    }
    private void restoreVolume() {
        if (previousVolume >= 0 && audioManager != null) {
            try {
                if (audioManager.getStreamVolume(AudioManager.STREAM_MUSIC) == temporaryVolume)
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, previousVolume, 0);
            } catch (RuntimeException e) { Log.w("F0", "Cannot restore media volume", e); }
        }
        previousVolume = -1; temporaryVolume = -1;
    }
    private void releaseCompletionSound() {
        restoreVolume();
        if (completionPlayer != null) {
            completionPlayer.release(); completionPlayer = null;
        }
    }

}
