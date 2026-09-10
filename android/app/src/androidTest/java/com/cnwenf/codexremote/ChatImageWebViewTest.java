package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.webkit.WebChromeClient;
import java.io.File;
import java.nio.file.Files;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real app WebView, content URI chooser, production compression/socket and native HTTP control. */
@RunWith(AndroidJUnit4.class)
public class ChatImageWebViewTest {
    @Test public void sendsImagesWhileNativeHttpTimesOut() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("chatImage")));
        String script = new String(Files.readAllBytes(new File("/data/local/tmp/android-image-probe.js").toPath()), java.nio.charset.StandardCharsets.UTF_8);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(2500);
            AtomicReference<Uri> selected = new AtomicReference<>();
            scenario.onActivity(activity -> {
                activity.getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
                    @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                        System.out.println("Image chooser callback");
                        callback.onReceiveValue(new Uri[] { selected.get() });
                        return true;
                    }
                });
                activity.getBridge().getWebView().evaluateJavascript(script, null);
            });
            await(scenario, "window.imageProbe?.ready === true", 15);
            int count = 0;
            for (int edge : new int[] {32, 480, 800}) {
                var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                File directory = new File(context.getCacheDir(), "updates");
                directory.mkdirs();
                File file = new File(directory, "chat-image-qa-" + edge + ".png");
                Bitmap bitmap = Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888);
                Random random = new Random(42);
                int[] pixels = new int[edge * edge];
                for (int i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | random.nextInt(0x1000000);
                bitmap.setPixels(pixels, 0, edge, 0, 0, edge, edge);
                try (var output = Files.newOutputStream(file.toPath())) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); }
                bitmap.recycle();
                selected.set(FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file));
                scenario.onActivity(activity -> {
                    WebView view = activity.getBridge().getWebView();
                    float point = 50 * activity.getResources().getDisplayMetrics().density;
                    long now = android.os.SystemClock.uptimeMillis();
                    for (int action : new int[] { android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP }) {
                        android.view.MotionEvent event = android.view.MotionEvent.obtain(now, now + action * 50, action, point, point * 0.6f, 0);
                        view.dispatchTouchEvent(event);
                        event.recycle();
                    }
                });
                await(scenario, "window.imageProbe.uploads.length === " + (++count), 25);
                assertEquals("\"\"", evaluate(scenario, "window.imageProbe.error"));
                file.delete();
            }
            await(scenario, "window.imageProbe.legacy !== 'pending'", 65);
            assertEquals("\"failed\"", evaluate(scenario, "window.imageProbe.legacy"));
            String result = evaluate(scenario, "JSON.stringify(window.imageProbe)");
            System.out.println("Chat image WebView results: " + result);
        }
    }
    private static void await(ActivityScenario<MainActivity> scenario, String expression, int seconds) throws Exception {
        long end = android.os.SystemClock.elapsedRealtime() + seconds * 1000L;
        while (android.os.SystemClock.elapsedRealtime() < end) {
            if ("true".equals(evaluate(scenario, expression))) return;
            Thread.sleep(200);
        }
        fail("WebView condition timed out: " + expression + "; " + evaluate(scenario, "JSON.stringify(window.imageProbe)"));
    }
    private static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result); latch.countDown();
        }));
        assertTrue("WebView callback timed out", latch.await(5, TimeUnit.SECONDS));
        return value.get();
    }
}
