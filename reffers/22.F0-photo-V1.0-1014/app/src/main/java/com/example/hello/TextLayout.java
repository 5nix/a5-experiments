package com.example.hello;

import java.util.ArrayList;
import java.util.List;

/** Count Unicode characters, including punctuation and spaces; never split a surrogate pair. */
public final class TextLayout {
    private TextLayout() { }
    public static String[] wrap(String text, int maximum) {
        if (maximum < 1) throw new IllegalArgumentException("maximum must be positive");
        List<String> lines = new ArrayList<>();
        for (String paragraph : text.split("\\n", -1)) {
            if (paragraph.isEmpty()) { lines.add(""); continue; }
            int start = 0;
            while (start < paragraph.length()) {
                int count = Math.min(maximum, paragraph.codePointCount(start, paragraph.length()));
                int end = paragraph.offsetByCodePoints(start, count);
                lines.add(paragraph.substring(start, end));
                start = end;
            }
        }
        return lines.toArray(new String[0]);
    }
}
