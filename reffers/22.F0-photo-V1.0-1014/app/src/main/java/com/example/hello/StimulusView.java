package com.example.hello;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.AttributeSet;
import android.view.View;

/** Native-pixel text, centered per eye. Every wrapped line is displayed at once. */
public final class StimulusView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
    private String[] lines = new String[0];
    private String message;
    private boolean calibration;
    private Runnable frameCallback;
    public StimulusView(Context context, AttributeSet attrs) {
        super(context, attrs); setBackgroundColor(Color.BLACK);
    }
    public void showFrame(String text, Runnable callback) {
        lines = text == null ? new String[0] : TextLayout.wrap(text, 14);
        message = null; calibration = false; frameCallback = callback; invalidate();
    }
    public void showMessage(String text, boolean showCross) {
        lines = new String[0]; message = text; calibration = showCross;
        frameCallback = null; invalidate();
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        paint.setColor(Color.WHITE); paint.setTypeface(Typeface.DEFAULT); paint.setFakeBoldText(false);
        paint.setTextSize(PhotoSession.FONT_SIZE_PX);
        Paint.FontMetrics fm = paint.getFontMetrics();
        float cx = getWidth() / 2f, cy = getHeight() / 2f;
        if (message != null) {
            String[] rows = message.split("\n", -1);
            if (calibration) {
                paint.setStrokeWidth(2f);
                canvas.drawLine(cx - 10f, cy, cx + 10f, cy, paint);
                canvas.drawLine(cx, cy - 10f, cx, cy + 10f, paint);
            }
            float y = calibration ? cy + 30f : cy - (rows.length - 1) * 12.15f - (fm.ascent + fm.descent) / 2f;
            for (String row : rows) {
                canvas.drawText(row, (getWidth() - paint.measureText(row)) / 2f, y, paint);
                y += calibration ? 21f : 24.3f;
            }
        } else if (lines.length > 0) {
            float spacing = PhotoSession.FONT_SIZE_PX * PhotoSession.LETTER_SPACING_EM;
            float lineHeight = PhotoSession.FONT_SIZE_PX * 1.5f;
            float y = cy - (fm.ascent + fm.descent) / 2f - (lines.length - 1) * lineHeight / 2f;
            for (String line : lines) {
                float width = Math.max(0, line.codePointCount(0, line.length()) - 1) * spacing;
                for (int i = 0; i < line.length();) {
                    int end = i + Character.charCount(line.codePointAt(i));
                    width += paint.measureText(line, i, end); i = end;
                }
                float x = cx - width / 2f;
                for (int i = 0; i < line.length();) {
                    int end = i + Character.charCount(line.codePointAt(i));
                    canvas.drawText(line, i, end, x, y, paint);
                    x += paint.measureText(line, i, end) + spacing; i = end;
                }
                y += lineHeight;
            }
        }
        Runnable callback = frameCallback; frameCallback = null;
        if (callback != null) callback.run();
    }
}
