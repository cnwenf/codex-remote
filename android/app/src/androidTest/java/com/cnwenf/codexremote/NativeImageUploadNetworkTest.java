package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import android.graphics.Bitmap;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Random;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in diagnostic: exercises the production uploader against the saved QA gateway. */
@RunWith(AndroidJUnit4.class)
public class NativeImageUploadNetworkTest {
    @Test public void uploadsAndDownloadsImagesThroughTheSavedGateway() throws Exception {
        assumeTrue("Opt in on a configured QA device with -e liveImage true",
            "true".equals(InstrumentationRegistry.getArguments().getString("liveImage")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var saved = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String selected = saved.getString("codex-remote.selected.v1", null);
        assertNotNull("Select a QA gateway first", selected);
        JSONArray connections = new JSONArray(saved.getString("codex-remote.connections.v1", "[]"));
        JSONObject connection = null;
        for (int i = 0; i < connections.length(); i++) {
            JSONObject item = connections.getJSONObject(i);
            if (selected.equals(item.optString("id"))) connection = item;
        }
        assertNotNull("The QA gateway must be saved", connection);
        String token = new EncryptedSecretStore(context).get(selected);
        assertNotNull("The QA credential must be saved", token);
        String baseUrl = InstrumentationRegistry.getArguments()
            .getString("liveImageBaseUrl", connection.getString("baseUrl")).replaceAll("/+$", "");
        for (int edge : new int[] { 32, 480 }) {
            byte[] image = png(edge);
            CodexRemoteNativePlugin plugin = new CodexRemoteNativePlugin();
            NativeImageUploadStaging staging = new NativeImageUploadStaging(
                new File(context.getCacheDir(), "image-upload-network-qa"), 1_000_000);
            Field stagingField = CodexRemoteNativePlugin.class.getDeclaredField("imageUploadStaging");
            stagingField.setAccessible(true);
            stagingField.set(plugin, staging);
            String id = staging.start();
            staging.append(id, image);
            File source = staging.claim(id);
            Method upload = CodexRemoteNativePlugin.class.getDeclaredMethod("uploadImage",
                String.class, File.class, String.class, String.class, String.class, String.class);
            upload.setAccessible(true);
            long started = android.os.SystemClock.elapsedRealtime();
            try {
                JSObject result;
                try {
                    result = (JSObject) upload.invoke(plugin, id, source, baseUrl + "/api/images",
                        token, "network-qa.png", "image/png");
                } catch (InvocationTargetException error) {
                    // Only report exception type and duration; never export URLs or credentials.
                    throw new AssertionError("Native upload failed: " + error.getCause().getClass().getSimpleName()
                        + ", bytes=" + image.length + ", elapsedMs="
                        + (android.os.SystemClock.elapsedRealtime() - started));
                }
                assertEquals(201, result.getInt("status"));
                JSONObject uploaded = result.getJSONObject("data");
                assertEquals(image.length, uploaded.getInt("size"));
                HttpURLConnection download = (HttpURLConnection) new URL(
                    baseUrl + "/api/images/" + uploaded.getString("id")).openConnection();
                download.setConnectTimeout(15_000);
                download.setReadTimeout(30_000);
                download.setRequestProperty("Authorization", "Bearer " + token);
                try {
                    assertEquals(200, download.getResponseCode());
                    assertArrayEquals(image, download.getInputStream().readAllBytes());
                } finally { download.disconnect(); }
                System.out.println("Native image round trip: bytes=" + image.length + ", elapsedMs="
                    + (android.os.SystemClock.elapsedRealtime() - started));
            } finally {
                staging.complete(id);
                plugin.handleOnDestroy();
            }
        }
    }

    private static byte[] png(int edge) {
        Bitmap bitmap = Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888);
        int[] pixels = new int[edge * edge];
        Random random = new Random(42);
        for (int i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | random.nextInt(0x1000000);
        bitmap.setPixels(pixels, 0, edge, 0, 0, edge, edge);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes));
        bitmap.recycle();
        return bytes.toByteArray();
    }
}
