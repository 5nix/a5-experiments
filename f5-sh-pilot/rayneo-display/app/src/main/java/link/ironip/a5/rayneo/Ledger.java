package link.ironip.a5.rayneo;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import android.provider.Settings;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.UUID;

/** 已接受请求永久去重。清应用数据或卸载会丢失账本，不能用作恢复方法。 */
final class Ledger extends SQLiteOpenHelper {
    private final String clockId;
    final String id;
    Ledger(Context context) throws Exception {
        super(context, "display.sqlite", null, 1);
        clockId = "android_uptime_ms:boot-" + Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1) + ":process-" + UUID.randomUUID();
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("PRAGMA synchronous=FULL");
        try (Cursor row = db.rawQuery("SELECT value FROM settings WHERE key='ledger_id'", null)) {
            if (row.moveToFirst()) id = row.getString(0);
            else { id = UUID.randomUUID().toString(); db.execSQL("INSERT INTO settings VALUES ('ledger_id',?)", new Object[]{id}); }
        }
        ArrayList<JSONObject> interrupted = new ArrayList<>();
        try (Cursor rows = db.rawQuery("SELECT body FROM requests WHERE finished=0", null)) {
            while (rows.moveToNext()) interrupted.add(new JSONObject(rows.getString(0)));
        }
        for (JSONObject request : interrupted) event(request, "failed", "device_process_restarted_delivery_unknown");
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,body TEXT NOT NULL,finished INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new IllegalStateException("ledger_migration_required"); }
    private String fingerprint(JSONObject request) throws Exception {
        JSONArray fields = new JSONArray();
        for (String key : new String[]{"request_id", "session_id", "participant_id", "stage_id", "message_id", "device_id", "text"}) fields.put(request.getString(key));
        fields.put(request.getInt("duration_ms"));
        if (!request.optString("display_mode", "legacy_8500").equals("legacy_8500")) fields.put(request.getString("display_mode"));
        return textHash(fields.toString());
    }
    static String textHash(String text) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte part : digest) result.append(String.format("%02x", part & 255));
        return result.toString();
    }
    boolean duplicate(JSONObject request) throws Exception {
        try (Cursor row = getReadableDatabase().rawQuery("SELECT fingerprint FROM requests WHERE id=?", new String[]{request.getString("request_id")})) {
            if (!row.moveToFirst()) return false;
            if (!row.getString(0).equals(fingerprint(request))) throw new IllegalArgumentException("request_id_content_conflict");
            return true;
        }
    }
    void accept(JSONObject request) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            ContentValues row = new ContentValues(); row.put("id", request.getString("request_id")); row.put("fingerprint", fingerprint(request));
            row.put("body", request.toString()); row.put("finished", 0); db.insertOrThrow("requests", null, row);
            append(request, "accepted", null); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    private void append(JSONObject request, String kind, String error) throws Exception {
        JSONObject event = new JSONObject().put("event_id", UUID.randomUUID().toString()).put("request_id", request.getString("request_id"))
            .put("device_id", request.getString("device_id")).put("kind", kind).put("device_wall_ms", System.currentTimeMillis())
            .put("device_monotonic_ms", SystemClock.uptimeMillis()).put("clock_id", clockId).put("error", error == null ? JSONObject.NULL : error);
        ContentValues row = new ContentValues(); row.put("body", event.toString()); getWritableDatabase().insertOrThrow("events", null, row);
    }
    void event(JSONObject request, String kind, String error) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            append(request, kind, error);
            if (kind.equals("hidden") || kind.equals("failed")) db.execSQL("UPDATE requests SET finished=1 WHERE id=?", new Object[]{request.getString("request_id")});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    JSONArray events(long after) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT 25", new String[]{Long.toString(after)})) {
            while (rows.moveToNext()) result.put(new JSONObject().put("seq", rows.getLong(0)).put("event", new JSONObject(rows.getString(1))));
        }
        return result;
    }
    boolean hasEvent(String requestId, String deviceId, String kind) throws Exception {
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT body FROM events ORDER BY seq DESC", null)) {
            while (rows.moveToNext()) {
                JSONObject event = new JSONObject(rows.getString(0));
                if (event.getString("request_id").equals(requestId) && event.getString("device_id").equals(deviceId) && event.getString("kind").equals(kind)) return true;
            }
        }
        return false;
    }
}
