package com.example.hello;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** In-memory navigation only. No participant, timestamps or result files. */
public final class PhotoSession {
    public static final float FONT_SIZE_PX = 16.2f, LETTER_SPACING_EM = 0.02f;
    public enum State { READY, SHOWING, CLEARING, FINISHED }
    public static final class Material {
        public final int id;
        public final String text;
        public Material(int id, String text) { this.id = id; this.text = text; }
    }
    private final List<Material> materials;
    public State state = State.READY;
    public int index = -1;
    public PhotoSession(List<Material> input) {
        if (input.size() != 12) throw new IllegalArgumentException("材料必须正好12条");
        materials = new ArrayList<>(input);
        materials.sort(Comparator.comparingInt(m -> m.id));
        int previous = 0;
        for (Material m : materials) {
            if (m.id <= previous || m.text == null || m.text.trim().isEmpty())
                throw new IllegalArgumentException("id须为不重复的正整数，text不能为空");
            previous = m.id;
        }
    }
    public Material current() { return index < 0 ? null : materials.get(index); }
    public boolean start() {
        if (state != State.READY) return false;
        index = 0; state = State.SHOWING; return true;
    }
    public boolean previous() {
        if (state != State.SHOWING || index == 0) return false;
        index--; return true;
    }
    public boolean next() {
        if (state != State.SHOWING) return false;
        if (index < materials.size() - 1) index++;
        else state = State.CLEARING;
        return true;
    }
    public boolean blankDrawn() {
        if (state != State.CLEARING) return false;
        state = State.FINISHED; return true;
    }
}
