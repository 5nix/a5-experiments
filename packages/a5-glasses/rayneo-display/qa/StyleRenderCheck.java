package link.ironip.a5.rayneo;

import android.app.Instrumentation;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Bundle;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** 在独立 QA 包中离屏绘制，不启动 Activity、USB 桥或实验会话。 */
public final class StyleRenderCheck extends Instrumentation {
    private JSONObject report;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    private static void require(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    private static void close(double actual, double expected, String field) { require(Math.abs(actual - expected) < 0.001, field + ": " + actual); }
    private JSONObject render(String text, String filename, Integer expectedLines) throws Exception {
        MessageView view = new MessageView(getTargetContext(), null);
        view.layout(0, 0, 640, 480);
        require(view.prepare(text), "正文不能完整显示：" + filename);
        JSONObject metrics = view.metrics();
        int lines = metrics.getInt("line_count");
        if (expectedLines != null) require(lines == expectedLines, "换行错误：" + filename + " lines=" + lines);
        close(metrics.getDouble("text_size_px"), 16.2, "text_size_px");
        close(metrics.getDouble("max_text_width_px"), 257.85, "max_text_width_px");
        close(metrics.getDouble("padding_px"), 13.5, "padding_px");
        close(metrics.getDouble("letter_spacing_em"), 0.02, "letter_spacing_em");
        close(metrics.getDouble("line_height_px"), lines >= 5 ? 24.3 : 21.87, "line_height_px");
        require(metrics.getInt("font_weight") == 500 && metrics.getString("alignment").equals("left"), "字重或对齐错误");
        view.show(null);
        Bitmap bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888);
        view.draw(new Canvas(bitmap));
        int top = (int) ((480 - metrics.getDouble("card_height_px")) / 2);
        int background = bitmap.getPixel(320, top + 3);
        require(Color.red(background) == 89 && Color.green(background) == 89 && Color.blue(background) == 89, "白色遮罩 alpha 错误");
        require(bitmap.getPixel(0, 0) == Color.BLACK, "卡片外背景错误");
        int whitePixels = 0;
        for (int y = 0; y < 480; y++) for (int x = 0; x < 640; x++) if (Color.red(bitmap.getPixel(x, y)) >= 245) whitePixels++;
        require(whitePixels > 10, "正文未绘制为白色");
        File out = new File(getTargetContext().getFilesDir(), "style-render-check"); out.mkdirs();
        try (FileOutputStream stream = new FileOutputStream(new File(out, filename + ".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream); }
        bitmap.recycle(); return metrics;
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Throwable[] issue = new Throwable[1];
            runOnMainSync(() -> {
                try {
                    report = new JSONObject(); JSONArray checks = new JSONArray(); report.put("checks", checks);
                    // 回归：自动换行处的尾空格可使 getLineWidth 超宽，可见正文仍放得下。
                    checks.put(new JSONObject().put("case", "default-notification").put("metrics", render(
                        "这是一条眼镜测试通知。\n请确认双眼文字清晰，消息将在 8.5 秒后自动消失。", "default-notification", 3)));
                    String row = "这是一行示例文本这是一行示例文"; // 15 个汉字。
                    require(row.codePointCount(0, row.length()) == 15, "QA 样本文本长度错误");
                    for (int n = 1; n <= 6; n++) checks.put(new JSONObject().put("case", "lines-" + n).put("metrics", render(String.join("\n", java.util.Collections.nCopies(n, row)), "lines-" + n, n)));
                    checks.put(new JSONObject().put("case", "16-characters-wrap").put("metrics", render(row + "字", "wrap-16", 2)));
                    String material;
                    try (var input = getTargetContext().getAssets().open("stimuli.json"); var bytes = new java.io.ByteArrayOutputStream()) {
                        byte[] buffer = new byte[4096]; int count;
                        while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
                        material = bytes.toString(StandardCharsets.UTF_8.name());
                    }
                    JSONArray stimuli = new JSONObject(material).getJSONArray("stimuli");
                    for (int i = 0; i < stimuli.length(); i++) {
                        JSONObject item = stimuli.getJSONObject(i);
                        checks.put(new JSONObject().put("case", item.getString("message_id")).put("metrics", render(item.getString("text"), "stimulus-" + i, null)));
                    }
                    MessageView oversized = new MessageView(getTargetContext(), null); oversized.layout(0, 0, 640, 480);
                    require(!oversized.prepare(String.join("\n", java.util.Collections.nCopies(30, row))), "超长正文不得缩字或裁切");
                    report.put("passed", true).put("independent_qa_package", true).put("experiment_data_modified", false);
                } catch (Throwable failure) { issue[0] = failure; }
            });
            if (issue[0] != null) throw issue[0];
            File out = new File(getTargetContext().getFilesDir(), "style-render-check/report.json");
            try (FileOutputStream stream = new FileOutputStream(out)) { stream.write(report.toString(2).getBytes(StandardCharsets.UTF_8)); }
            result.putString("result", report.toString()); finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) { result.putString("error", failure.toString()); finish(Activity.RESULT_CANCELED, result); }
    }
}
