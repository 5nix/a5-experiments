package link.ironip.a5.rayneo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.text.LineBreaker;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextDirectionHeuristics;
import android.util.AttributeSet;
import android.view.View;

/** 全文一次绘制；显式换行保留，放不下则拒绝，禁止省略号和截断。 */
public final class MessageView extends View {
    private static final String STYLE_VERSION = "x3-pro-27ppd-v1";
    private static final float PPD = 27f;
    private static final float TEXT_SIZE = 0.6f * PPD;
    private static final float TEXT_WIDTH = 9.55f * PPD;
    private static final float PADDING = 0.5f * PPD;
    private static final float LETTER_SPACING = 0.02f;
    private static final float MASK_OPACITY = 0.35f;
    private StaticLayout prepared, visible;
    private float preparedLineHeight, visibleLineHeight;
    private final Paint mask = new Paint(Paint.ANTI_ALIAS_FLAG);
    private Runnable drawn;
    public MessageView(Context context, AttributeSet attrs) {
        super(context, attrs); setBackgroundColor(Color.BLACK);
        mask.setColor(Color.WHITE); mask.setAlpha(Math.round(255 * MASK_OPACITY));
    }
    public boolean prepare(String text) {
        prepared = null;
        if (getWidth() < TEXT_WIDTH + 2 * PADDING || getHeight() <= 2 * PADDING) return false;
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG | TextPaint.SUBPIXEL_TEXT_FLAG);
        paint.setColor(Color.WHITE);
        paint.setTextSize(TEXT_SIZE);
        paint.setLetterSpacing(LETTER_SPACING);
        paint.setTypeface(Typeface.create(Typeface.create("sans-serif", Typeface.NORMAL), 500, false));
        // StaticLayout 的宽度只能是整数；向下取整保证不超过 9.55°，卡片仍使用精确浮点宽度。
        StaticLayout candidate = StaticLayout.Builder.obtain(text, 0, text.length(), paint, (int) Math.floor(TEXT_WIDTH))
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setTextDirection(TextDirectionHeuristics.LTR)
            .setBreakStrategy(LineBreaker.BREAK_STRATEGY_SIMPLE).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .setIncludePad(false).build();
        float lineHeight = TEXT_SIZE * (candidate.getLineCount() >= 5 ? 1.5f : 1.35f);
        if (candidate.getLineCount() * lineHeight + 2 * PADDING > getHeight()) return false;
        for (int i = 0; i < candidate.getLineCount(); i++) {
            if (candidate.getLineWidth(i) > TEXT_WIDTH) return false;
            // 固定字号和行高，不能通过缩字、裁切或省略正文来凑进画布。
            if (candidate.getLineDescent(i) - candidate.getLineAscent(i) > lineHeight) return false;
        }
        prepared = candidate; preparedLineHeight = lineHeight; return true;
    }
    public org.json.JSONObject metrics() throws org.json.JSONException {
        return new org.json.JSONObject().put("canvas_width_px", getWidth()).put("canvas_height_px", getHeight())
            .put("text_size_px", prepared.getPaint().getTextSize()).put("line_count", prepared.getLineCount())
            .put("text_height_px", prepared.getLineCount() * preparedLineHeight)
            .put("style_version", STYLE_VERSION).put("ppd", PPD).put("font_size_deg", 0.6)
            .put("letter_spacing_em", LETTER_SPACING).put("font_weight", 500).put("color", "#FFFFFF")
            .put("max_text_width_deg", 9.55).put("max_text_width_px", TEXT_WIDTH).put("layout_width_px", prepared.getWidth())
            .put("padding_deg", 0.5).put("padding_px", PADDING).put("alignment", "left")
            .put("line_height_ratio", prepared.getLineCount() >= 5 ? 1.5 : 1.35).put("line_height_px", preparedLineHeight)
            .put("mask_opacity", MASK_OPACITY).put("mask_alpha_8bit", mask.getAlpha())
            .put("card_width_px", TEXT_WIDTH + 2 * PADDING).put("card_height_px", prepared.getLineCount() * preparedLineHeight + 2 * PADDING);
    }
    public void show(Runnable callback) { visible = prepared; visibleLineHeight = preparedLineHeight; drawn = callback; invalidate(); }
    public void hide(Runnable callback) { visible = null; drawn = callback; invalidate(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (visible != null) {
            float cardWidth = TEXT_WIDTH + 2 * PADDING;
            float cardHeight = visible.getLineCount() * visibleLineHeight + 2 * PADDING;
            float cardLeft = (getWidth() - cardWidth) / 2f, cardTop = (getHeight() - cardHeight) / 2f;
            canvas.drawRoundRect(cardLeft, cardTop, cardLeft + cardWidth, cardTop + cardHeight, PADDING, PADDING, mask);
            // StaticLayout 默认行距以字体 metrics 为基准，并非字号百分比。这里用精确浮点基线间距。
            CharSequence text = visible.getText();
            for (int i = 0; i < visible.getLineCount(); i++) {
                int start = visible.getLineStart(i), end = visible.getLineEnd(i);
                while (end > start && (text.charAt(end - 1) == '\n' || text.charAt(end - 1) == '\r')) end--;
                float ascent = visible.getLineAscent(i), descent = visible.getLineDescent(i);
                float baseline = cardTop + PADDING + i * visibleLineHeight + (visibleLineHeight - (descent - ascent)) / 2f - ascent;
                canvas.drawText(text, start, end, cardLeft + PADDING, baseline, visible.getPaint());
            }
        }
        Runnable callback = drawn; drawn = null;
        if (callback != null) post(callback);
    }
}
