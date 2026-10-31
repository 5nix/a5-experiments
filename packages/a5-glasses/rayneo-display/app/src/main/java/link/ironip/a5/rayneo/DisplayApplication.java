package link.ironip.a5.rayneo;
import android.app.Application;
import com.ffalcon.mercury.android.sdk.MercurySDK;
public final class DisplayApplication extends Application {
    @Override public void onCreate() { super.onCreate(); MercurySDK.INSTANCE.init(this); }
}
