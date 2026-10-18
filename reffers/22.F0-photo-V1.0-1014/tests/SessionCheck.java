import com.example.hello.PhotoSession;
import com.example.hello.PhotoSession.Material;
import com.example.hello.PhotoSession.State;
import com.example.hello.TextLayout;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class SessionCheck {
    static int checks;
    static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        List<Material> materials = new ArrayList<>();
        List<String> rows = Files.readAllLines(Path.of(args[0]));
        for (String row : rows.subList(1,rows.size())) {
            String[] cells = row.split(",",2);
            materials.add(new Material(Integer.parseInt(cells[0]), cells[1]));
        }
        check(materials.size()==12, "twelve supplied materials");
        for (int i=0;i<12;i++) {
            String original = materials.get(i).text;
            int count = original.codePointCount(0,original.length());
            check(i%2==0 ? count>=12 && count<=14 : count>=68 && count<=70, "short/long alternating lengths");
            String[] lines = TextLayout.wrap(original,14);
            check(lines.length==(i%2==0?1:5), "one and five lines");
            check(String.join("",lines).equals(original), "original text preserved");
            for(String line:lines) check(line.codePointCount(0,line.length())<=14,"maximum 14 characters");
        }
        Collections.reverse(materials);
        PhotoSession session = new PhotoSession(materials);
        check(!session.next() && !session.previous() && !session.blankDrawn(), "navigation and completion disabled on instructions");
        check(session.start() && session.current().id==1, "space starts lowest id");
        check(!session.start() && !session.previous() && session.current().id==1, "first boundary and no space reset");
        for(int id=2;id<=12;id++) {
            check(session.next() && session.current().id==id && session.state==State.SHOWING,"numeric order through twelve, no early finish");
            check(!session.blankDrawn(), "no completion on stimulus redraw");
            check(session.previous() && session.current().id==id-1,"return to previous material");
            check(session.next() && session.current().id==id,"restore next material");
        }
        for(int id=11;id>=1;id--)check(session.previous() && session.current().id==id,"revisit all twelve in reverse");
        check(!session.previous() && session.current().id==1,"first boundary after full reverse");
        for(int id=2;id<=12;id++)check(session.next() && session.current().id==id,"second forward pass");
        check(session.next() && session.state==State.CLEARING,"2 on last requests blank");
        check(!session.previous() && !session.next() && !session.start(),"no input while clearing");
        check(session.blankDrawn() && session.state==State.FINISHED,"finish after blank is drawn");
        check(!session.blankDrawn() && !session.next() && !session.previous() && !session.start(),"completion exactly once; no restart by keys");
        check(String.join("",TextLayout.wrap("甲😀乙".repeat(10),14)).equals("甲😀乙".repeat(10)),"Unicode characters preserved");
        System.out.println("PASS: "+checks+" checks: supplied text, wrapping, repeated navigation, boundaries and completion.");
    }
}
