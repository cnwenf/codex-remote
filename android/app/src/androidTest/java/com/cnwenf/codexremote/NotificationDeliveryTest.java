package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import android.app.NotificationManager;
import android.app.Notification;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the actual foreground service against a local, metadata-only HTTP fixture. */
@RunWith(AndroidJUnit4.class)
public class NotificationDeliveryTest {
    @Test public void deliversNotificationsAndRecoversMonitorState() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertTrue("Notification delivery QA requires notification permission", manager.areNotificationsEnabled());
        AtomicReference<String> body = new AtomicReference<>("{\"threads\":[],\"completions\":[]}");
        AtomicReference<Integer> responseCode = new AtomicReference<>(200);
        try (ServerSocket server = new ServerSocket(0)) {
            Thread http = new Thread(() -> {
                while (!server.isClosed()) {
                    try (var client = server.accept()) {
                        var reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
                        String line;
                        while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                        byte[] data = body.get().getBytes(StandardCharsets.UTF_8);
                        client.getOutputStream().write(("HTTP/1.1 " + responseCode.get() + " QA\r\nContent-Type: application/json\r\nContent-Length: " + data.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        client.getOutputStream().write(data);
                    } catch (Exception error) { if (!server.isClosed()) throw new RuntimeException(error); }
                }
            });
            http.setDaemon(true);
            http.start();
            new EncryptedSecretStore(context).put("notification-qa", "fixture-token");
            context.stopService(new Intent(context, CodexRemoteMonitorService.class));
            Thread.sleep(300);
            CodexRemoteMonitorService.clearSavedMonitor(context);
            manager.cancelAll();
            Intent start = CodexRemoteMonitorService.startIntent(context, "notification-qa", "Notification QA", "http://127.0.0.1:" + server.getLocalPort());
            ContextCompat.startForegroundService(context, start);
            // Android can defer a new foreground-service notification for ten seconds.
            long deadline = System.currentTimeMillis() + 20000;
            while (System.currentTimeMillis() < deadline && Arrays.stream(manager.getActiveNotifications()).noneMatch(n -> "没有运行中的对话".contentEquals(n.getNotification().extras.getCharSequence("android.title", "")))) Thread.sleep(50);
            assertTrue(Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> n.getId() == 1001));
            body.set("{\"threads\":[{\"id\":\"qa-fast\",\"title\":\"Short task QA\",\"status\":\"idle\"}],\"completions\":[{\"id\":\"qa-fast:one\",\"threadId\":\"qa-fast\",\"turnId\":\"one\",\"title\":\"Short task QA\",\"status\":\"idle\",\"completedAt\":1}]}");
            ContextCompat.startForegroundService(context, start);
            deadline = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < deadline && Arrays.stream(manager.getActiveNotifications()).noneMatch(n -> "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", "")))) Thread.sleep(50);
            assertTrue("A short turn must produce a real completion notification", Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));
            assertBranding(context, Arrays.stream(manager.getActiveNotifications()).filter(n -> "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))).findFirst().get().getNotification());
            assertBranding(context, Arrays.stream(manager.getActiveNotifications()).filter(n -> n.getId() == 1001).findFirst().get().getNotification());
            body.set("{\"threads\":[{\"id\":\"list-only\",\"title\":\"List-only QA\",\"status\":\"running\",\"turnId\":\"two\"}],\"completions\":[]}");
            ContextCompat.startForegroundService(context, start);
            deadline = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < deadline && Arrays.stream(manager.getActiveNotifications()).noneMatch(n -> "List-only QA".contentEquals(n.getNotification().extras.getCharSequence("android.title", "")))) Thread.sleep(50);
            assertTrue(Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "List-only QA".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));
            assertBranding(context, Arrays.stream(manager.getActiveNotifications()).filter(n -> "List-only QA".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))).findFirst().get().getNotification());
            body.set("{\"threads\":[{\"id\":\"list-only\",\"title\":\"List-only QA\",\"status\":\"idle\",\"turnId\":\"two\"}],\"completions\":[{\"threadId\":\"list-only\",\"turnId\":\"older\",\"status\":\"error\",\"title\":\"Old unrelated turn\",\"completedAt\":1}]}");
            ContextCompat.startForegroundService(context, start);
            deadline = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < deadline && Arrays.stream(manager.getActiveNotifications()).noneMatch(n -> "List-only QA".contentEquals(n.getNotification().extras.getCharSequence("android.text", "")) && "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", "")))) Thread.sleep(50);
            assertTrue("A different turn's event must not suppress the terminal fallback", Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "List-only QA".contentEquals(n.getNotification().extras.getCharSequence("android.text", "")) && "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));

            seedLegacyState(context, manager, server.getLocalPort());
            body.set("{\"generatedAt\":" + System.currentTimeMillis() + ",\"threads\":[{\"id\":\"legacy\",\"title\":\"Migrated running\",\"status\":\"running\",\"turnId\":\"current\"}],\"completions\":[{\"threadId\":\"legacy\",\"turnId\":\"old\",\"status\":\"idle\",\"title\":\"Old history\",\"completedAt\":1}]}");
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertFalse("Migrating a running thread must not announce older completed turns", Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "对话已完成".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));

            seedLegacyState(context, manager, server.getLocalPort());
            body.set("{\"generatedAt\":" + System.currentTimeMillis() + ",\"threads\":[{\"id\":\"legacy\",\"title\":\"Migrated completion\",\"status\":\"idle\",\"turnId\":\"current\"}],\"completions\":[{\"threadId\":\"legacy\",\"turnId\":\"current\",\"status\":\"idle\",\"title\":\"Migrated completion\",\"completedAt\":1}]}");
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "Migrated completion".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))));
            long deliveredAt = Arrays.stream(manager.getActiveNotifications()).filter(n -> "Migrated completion".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))).findFirst().get().getPostTime();
            context.stopService(new Intent(context, CodexRemoteMonitorService.class));
            Thread.sleep(300);
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertEquals("Service restart must not re-post the same completed turn", deliveredAt, Arrays.stream(manager.getActiveNotifications()).filter(n -> "Migrated completion".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))).findFirst().get().getPostTime());

            Thread.sleep(2_000); // Avoid notification-rate throttling from the accelerated polls above.
            seedLegacyState(context, manager, server.getLocalPort());
            body.set("{\"generatedAt\":" + System.currentTimeMillis() + ",\"threads\":[{\"id\":\"legacy\",\"title\":\"Failure fallback\",\"status\":\"error\",\"turnId\":\"current\"}],\"completions\":[{\"threadId\":\"legacy\",\"turnId\":\"current\",\"status\":\"error\",\"title\":\"Failed completion event\",\"completedAt\":1}]}");
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            awaitCondition(() -> Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "Failed completion event".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))));
            var failed = Arrays.stream(manager.getActiveNotifications()).filter(n -> "Failed completion event".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))).findFirst().get();
            assertEquals("An error completion must use the failure title", "对话执行失败", failed.getNotification().extras.getCharSequence("android.title").toString());
            assertFalse("The same turn's state fallback must not replace the completion event", Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "Failure fallback".contentEquals(n.getNotification().extras.getCharSequence("android.text", ""))));
            long failedDeliveredAt = failed.getPostTime();
            long checkedAt = context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE).getLong("lastAttemptAt", 0);
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE).getLong("lastAttemptAt", 0) > checkedAt
                && "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertEquals("Replaying an error completion must not re-post the same turn", failedDeliveredAt, Arrays.stream(manager.getActiveNotifications()).filter(n -> n.getId() == failed.getId()).findFirst().get().getPostTime());

            // The scenarios above accelerate several 15-second polls into a short window.
            // Let Android's notification update rate limit settle before checking error UI.
            Thread.sleep(2_000);
            responseCode.set(401);
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "unauthorized".equals(CodexRemoteMonitorService.notificationStatus(context).optString("error")));
            awaitCondition(() -> Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "后台监控异常".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));
            responseCode.set(200);
            body.set("{\"bridge\":{\"available\":false},\"threads\":[]}");
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "bridge-unavailable".equals(CodexRemoteMonitorService.notificationStatus(context).optString("error")));
            body.set("{\"threads\":[],\"completions\":[]}");
            ContextCompat.startForegroundService(context, start);
            awaitCondition(() -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertTrue(CodexRemoteMonitorService.notificationStatus(context).optString("error").isEmpty());
            if ("true".equals(InstrumentationRegistry.getArguments().getString("showNotifications"))) {
                body.set("{\"threads\":[{\"id\":\"visible-qa\",\"title\":\"Notification QA - Running\",\"status\":\"running\"}],\"completions\":[]}");
                Thread.sleep(2_000);
                ContextCompat.startForegroundService(context, start);
                awaitCondition(() -> Arrays.stream(manager.getActiveNotifications()).anyMatch(n -> "Notification QA - Running".contentEquals(n.getNotification().extras.getCharSequence("android.title", ""))));
                Thread.sleep(45_000); // Optional, bounded window for native shade/lock-screen inspection.
            }
        } finally {
            context.stopService(new Intent(context, CodexRemoteMonitorService.class));
            CodexRemoteMonitorService.clearSavedMonitor(context);
            new EncryptedSecretStore(context).remove("notification-qa");
            manager.cancelAll();
        }
    }

    private static void seedLegacyState(Context context, NotificationManager manager, int port) throws Exception {
        context.stopService(new Intent(context, CodexRemoteMonitorService.class));
        Thread.sleep(300);
        manager.cancelAll();
        context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE).edit().clear()
            .putString("connectionId", "notification-qa").putString("name", "Notification QA")
            .putString("baseUrl", "http://127.0.0.1:" + port).putString("states", "{\"legacy\":\"running\"}").commit();
    }

    private static void awaitCondition(BooleanSupplier condition) throws Exception {
        long deadline = System.currentTimeMillis() + 5000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(50);
        assertTrue("Timed out waiting for native notification state", condition.getAsBoolean());
    }

    private static void assertBranding(Context context, Notification notification) {
        assertNotNull("Notifications must include the full app logo", notification.getLargeIcon());
        Drawable largeDrawable = notification.getLargeIcon().loadDrawable(context);
        Drawable launcherDrawable = context.getApplicationInfo().loadIcon(context.getPackageManager());
        Bitmap large = render(largeDrawable);
        int launcherSize = Math.min(256, Math.round(64 * context.getResources().getDisplayMetrics().density));
        Bitmap canonicalLauncher = Bitmap.createBitmap(launcherSize, launcherSize, Bitmap.Config.ARGB_8888);
        launcherDrawable.setBounds(0, 0, launcherSize, launcherSize);
        launcherDrawable.draw(new Canvas(canonicalLauncher));
        Bitmap launcher = Bitmap.createScaledBitmap(canonicalLauncher, 96, 96, true);
        Bitmap small = render(notification.getSmallIcon().loadDrawable(context));
        Bitmap source = render(context.getDrawable(R.drawable.ic_launcher_source));
        long difference = 0;
        int intersection = 0, union = 0;
        for (int y = 0; y < 96; y++) for (int x = 0; x < 96; x++) {
            int actual = large.getPixel(x, y), expected = launcher.getPixel(x, y);
            difference += Math.abs(Color.red(actual) - Color.red(expected)) + Math.abs(Color.green(actual) - Color.green(expected)) + Math.abs(Color.blue(actual) - Color.blue(expected));
            boolean actualMark = Color.alpha(small.getPixel(x, y)) > 127;
            boolean expectedMark = Color.red(source.getPixel(x, y)) > 127;
            if (actualMark || expectedMark) union++;
            if (actualMark && expectedMark) intersection++;
        }
        double averageDifference = difference / (96.0 * 96 * 3);
        assertTrue("Full notification logo must retain launcher artwork, background and padding; averageDifference=" + averageDifference
            + ", actualIntrinsic=" + largeDrawable.getIntrinsicWidth() + "x" + largeDrawable.getIntrinsicHeight()
            + ", expectedIntrinsic=" + launcherDrawable.getIntrinsicWidth() + "x" + launcherDrawable.getIntrinsicHeight(), averageDifference < 4);
        assertTrue("Small icon must use the same artwork and source padding", intersection / (double) union > 0.93);
    }

    private static Bitmap render(Drawable drawable) {
        Bitmap bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        drawable.setBounds(0, 0, 96, 96);
        drawable.draw(new Canvas(bitmap));
        return bitmap;
    }
}
