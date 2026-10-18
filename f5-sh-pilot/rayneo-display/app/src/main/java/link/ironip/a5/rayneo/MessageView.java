package link.ironip.a5.rayneo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.AttributeSet;
import android.view.View;

/** 全文一次绘制；显式换行保留，放不下则拒绝，禁止省略号和截断。 */
public final class MessageView extends View {
    private StaticLayout prepared, visible;
    private Runnable drawn;
    public MessageView(Context context, AttributeSet attrs) { super(context, attrs); setBackgroundColor(Color.BLACK); }
    public boolean prepare(String text) {
        int width = getWidth() - 64, height = getHeight() - 64;
        if (width <= 0 || height <= 0) return false;
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG | TextPaint.SUBPIXEL_TEXT_FLAG);
        paint.setColor(Color.WHITE);
        for (int size = 24; size >= 18; size--) {
            paint.setTextSize(size);
            StaticLayout candidate = StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
                .setAlignment(Layout.Alignment.ALIGN_CENTER).setLineSpacing(0, 1.5f).setIncludePad(true).build();
            boolean fits = candidate.getHeight() <= height;
            for (int i = 0; i < candidate.getLineCount(); i++) fits &= candidate.getLineWidth(i) <= width;
            if (fits) { prepared = candidate; return true; }
        }
        prepared = null; return false;
    }
    public org.json.JSONObject metrics() throws org.json.JSONException {
        return new org.json.JSONObject().put("canvas_width_px", getWidth()).put("canvas_height_px", getHeight())
            .put("text_size_px", prepared.getPaint().getTextSize()).put("line_count", prepared.getLineCount())
            .put("text_height_px", prepared.getHeight());
    }
    public void show(Runnable callback) { visible = prepared; drawn = callback; invalidate(); }
    public void hide(Runnable callback) { visible = null; drawn = callback; invalidate(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (visible != null) {
            canvas.save(); canvas.translate((getWidth() - visible.getWidth()) / 2f, (getHeight() - visible.getHeight()) / 2f);
            visible.draw(canvas); canvas.restore();
        }
        Runnable callback = drawn; drawn = null;
        if (callback != null) post(callback);
    }
}
