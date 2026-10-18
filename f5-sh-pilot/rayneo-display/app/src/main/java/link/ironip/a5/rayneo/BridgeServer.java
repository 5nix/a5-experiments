package link.ironip.a5.rayneo;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Handler;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** 无网络监听权限，仅接收 ADB 转发来的 shell/root UID；每行一个 UTF-8 JSON 请求。 */
final class BridgeServer implements AutoCloseable {
    interface Dispatch { JSONObject command(JSONObject request) throws Exception; }
    private final LocalServerSocket server;
    private volatile boolean closed;
    private volatile LocalSocket client;
    BridgeServer(Handler main, Dispatch dispatch) throws Exception {
        server = new LocalServerSocket("a5-rayneo-v1");
        Thread listener = new Thread(() -> {
            while (!closed) {
                try {
                    LocalSocket socket = server.accept();
                    int uid = socket.getPeerCredentials().getUid();
                    // 单连接租约：额外控制端立即拒绝，不能在 accept 队列中积压旧刺激。
                    synchronized (this) {
                        if (closed || (uid != 2000 && uid != 0) || client != null) { socket.close(); continue; }
                        client = socket;
                    }
                    Thread worker = new Thread(() -> serve(socket, main, dispatch), "a5-usb-client");
                    worker.setDaemon(true); worker.start();
                } catch (Exception error) { if (!closed) { android.util.Log.e("A5", "USB 监听失败", error); close(); } }
            }
        }, "a5-usb-listener");
        listener.setDaemon(true); listener.start();
    }
    private void serve(LocalSocket socket, Handler main, Dispatch dispatch) {
        try (LocalSocket connection = socket) {
            connection.setSoTimeout(10000);
            InputStream input = connection.getInputStream(); OutputStream output = connection.getOutputStream();
            while (!closed) {
                String line = line(input); if (line == null) break;
                JSONObject envelope = new JSONObject(line);
                FutureTask<JSONObject> task = new FutureTask<>(() -> {
                    JSONObject reply = new JSONObject().put("protocol", "a5-rayneo/1").put("id", envelope.getLong("id"));
                    try {
                        if (!"a5-rayneo/1".equals(envelope.getString("protocol"))) throw new IllegalArgumentException("device_protocol_mismatch");
                        JSONObject value = dispatch.command(envelope);
                        java.util.Iterator<String> keys = value.keys();
                        while (keys.hasNext()) { String key = keys.next(); reply.put(key, value.get(key)); }
                        reply.put("ok", true);
                    } catch (Exception error) { reply.put("ok", false).put("error", error.getMessage() == null ? "device_error" : error.getMessage()); }
                    return reply;
                });
                main.post(task);
                JSONObject reply;
                try { reply = task.get(2, TimeUnit.SECONDS); }
                catch (Exception error) { task.cancel(false); throw error; }
                output.write((reply.toString() + "\n").getBytes(StandardCharsets.UTF_8)); output.flush();
            }
        } catch (Exception ignored) { /* 断线不干涉显示、计时或账本；不缓存请求。 */ }
        finally { synchronized (this) { if (client == socket) client = null; } }
    }
    private static String line(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int value; (value = input.read()) != -1;) {
            if (value == '\n') return bytes.toString(StandardCharsets.UTF_8.name());
            if (bytes.size() >= 65536) throw new IllegalArgumentException("request_too_large");
            bytes.write(value);
        }
        return null;
    }
    @Override public void close() {
        closed = true;
        try { server.close(); } catch (Exception ignored) { }
        try { if (client != null) client.close(); } catch (Exception ignored) { }
    }
}
