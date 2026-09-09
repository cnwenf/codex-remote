package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real service/HTTP tests: a delayed previous request must not block recovery. */
@RunWith(AndroidJUnit4.class)
public class MonitorRecoveryTest {
    @Test public void slowBodyTimesOutAndRecoversAutomatically() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (Fixture slow = new Fixture("trickle")) {
            prepare(context);
            start(context, slow);
            assertTrue(slow.received.await(5, TimeUnit.SECONDS));
            await("A trickling body must have a total deadline, not only an idle read timeout", 20_000,
                () -> "error".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertEquals("timeout", CodexRemoteMonitorService.notificationStatus(context).optString("error"));
            await("The next automatic poll must recover without restarting the app", 20_000,
                () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertTrue(CodexRemoteMonitorService.notificationStatus(context).optString("error").isEmpty());
        } finally { cleanup(context); }
    }

    @Test public void retryDoesNotWaitForThePreviousResponse() throws Exception {
        verifyRetry(false);
    }

    @Test public void switchingConnectionCancelsThePreviousResponse() throws Exception {
        verifyRetry(true);
    }

    @Test public void aQueuedConnectionSwitchCannotInheritThePreviousRequestsSuccess() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (Fixture previous = new Fixture("blocked-success"); Fixture next = new Fixture(false)) {
            prepare(context);
            start(context, previous);
            assertTrue(previous.received.await(5, TimeUnit.SECONDS));
            // The plugin has requested a new endpoint, but Android has not delivered its start command yet.
            Intent pending = CodexRemoteMonitorService.startIntent(context, "monitor-recovery-qa", "Next QA",
                "http://127.0.0.1:" + next.server.getLocalPort());
            previous.release.countDown();
            assertTrue(previous.responded.await(5, TimeUnit.SECONDS));
            Thread.sleep(500);
            assertEquals("An old success must not be recorded for the newly requested endpoint", 0,
                CodexRemoteMonitorService.notificationStatus(context).optLong("lastSuccessAt"));
            ContextCompat.startForegroundService(context, pending);
            await("The new connection can establish its own successful check", 3_000,
                () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertTrue(CodexRemoteMonitorService.notificationStatus(context).optLong("lastSuccessAt") > 0);
        } finally { cleanup(context); }
    }

    @Test public void retryOfASavedFailedTargetKeepsItsFailureUntilTheResponseSucceeds() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (Fixture saved = new Fixture("blocked-success")) {
            prepare(context);
            CodexRemoteMonitorService.startIntent(context, "monitor-recovery-qa", "Saved QA",
                "http://127.0.0.1:" + saved.server.getLocalPort());
            CodexRemoteMonitorService.recordHealth(context, "start-failed");
            // Same no-extras Intent used by the settings page's retry action.
            ContextCompat.startForegroundService(context, new Intent(context, CodexRemoteMonitorService.class));
            assertTrue(saved.received.await(5, TimeUnit.SECONDS));
            var starting = CodexRemoteMonitorService.notificationStatus(context);
            assertEquals("starting", starting.optString("state"));
            assertEquals("Saved QA", starting.optString("connectionName"));
            assertEquals("start-failed", starting.optString("error"));
            assertEquals(1, starting.optInt("consecutiveFailures"));
            assertEquals(0, starting.optLong("lastSuccessAt"));
            saved.release.countDown();
            await("Only the response can confirm a successful retry", 3_000,
                () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            var healthy = CodexRemoteMonitorService.notificationStatus(context);
            assertTrue(healthy.optLong("lastSuccessAt") > 0);
            assertEquals(0, healthy.optInt("consecutiveFailures"));
            assertTrue(healthy.optString("error").isEmpty());
        } finally { cleanup(context); }
    }

    @Test public void anOlderStartCommandStillUsesTheLatestSavedTarget() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (Fixture previous = new Fixture(false); Fixture latest = new Fixture(false)) {
            prepare(context);
            Intent older = CodexRemoteMonitorService.startIntent(context, "monitor-recovery-qa", "Old QA",
                "http://127.0.0.1:" + previous.server.getLocalPort());
            CodexRemoteMonitorService.startIntent(context, "monitor-recovery-qa", "Latest QA",
                "http://127.0.0.1:" + latest.server.getLocalPort());
            ContextCompat.startForegroundService(context, older);
            assertTrue("An older Android start command must not strand the current target", latest.received.await(3, TimeUnit.SECONDS));
            await("The latest target becomes healthy", 2_000,
                () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            assertEquals(1, previous.received.getCount());
            assertEquals("Latest QA", CodexRemoteMonitorService.notificationStatus(context).optString("connectionName"));
        } finally { cleanup(context); }
    }

    private void verifyRetry(boolean switchConnection) throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (Fixture blocked = new Fixture(true); Fixture healthy = new Fixture(false)) {
            prepare(context);
            start(context, blocked);
            assertTrue("The old request must actually be in flight", blocked.received.await(5, TimeUnit.SECONDS));
            if (switchConnection) start(context, healthy);
            else ContextCompat.startForegroundService(context, new Intent(context, CodexRemoteMonitorService.class));
            await("Retry must reach the new connection without waiting for the old read timeout", 3_000,
                () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
            // Releasing a late failed response must not overwrite the current healthy state.
            blocked.release.countDown();
            Thread.sleep(500);
            assertEquals("healthy", CodexRemoteMonitorService.notificationStatus(context).optString("state"));
            assertTrue(CodexRemoteMonitorService.notificationStatus(context).optString("error").isEmpty());
        } finally { cleanup(context); }
    }

    @Test public void classifiesEndpointFailuresAndClearsThemAfterRetry() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try {
            prepare(context);
            for (String mode : new String[] { "http-401", "http-503", "invalid-status", "oversize", "http-302" }) {
                Thread.sleep(1_000); // These accelerated foreground updates must not throttle the following notification QA.
                try (Fixture fixture = new Fixture(mode)) {
                    start(context, fixture);
                    String expected = mode.equals("http-401") ? "unauthorized" : mode.equals("oversize") ? "invalid-status" : mode;
                    await("The real HTTP failure must remain visible with a safe error code", 5_000,
                        () -> expected.equals(CodexRemoteMonitorService.notificationStatus(context).optString("error")));
                    Thread.sleep(750);
                    ContextCompat.startForegroundService(context, new Intent(context, CodexRemoteMonitorService.class));
                    await("A healthy retry must clear the previous failure", 3_000,
                        () -> "healthy".equals(CodexRemoteMonitorService.notificationStatus(context).optString("state")));
                    assertTrue(CodexRemoteMonitorService.notificationStatus(context).optString("error").isEmpty());
                }
            }
        } finally { cleanup(context); }
    }

    private static void prepare(Context context) throws Exception {
        context.stopService(new Intent(context, CodexRemoteMonitorService.class));
        Thread.sleep(300);
        CodexRemoteMonitorService.clearSavedMonitor(context);
        new EncryptedSecretStore(context).put("monitor-recovery-qa", "fixture-token");
    }

    private static void start(Context context, Fixture fixture) {
        ContextCompat.startForegroundService(context, CodexRemoteMonitorService.startIntent(context,
            "monitor-recovery-qa", "Monitor recovery QA", "http://127.0.0.1:" + fixture.server.getLocalPort()));
    }

    private static void cleanup(Context context) throws Exception {
        context.stopService(new Intent(context, CodexRemoteMonitorService.class));
        Thread.sleep(300);
        CodexRemoteMonitorService.clearSavedMonitor(context);
        new EncryptedSecretStore(context).remove("monitor-recovery-qa");
    }

    private static void await(String message, long timeout, BooleanSupplier condition) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeout;
        while (!condition.getAsBoolean() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50);
        assertTrue(message + "; status=" + CodexRemoteMonitorService.notificationStatus(
            InstrumentationRegistry.getInstrumentation().getTargetContext()), condition.getAsBoolean());
    }

    private static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0);
        final CountDownLatch received = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch responded = new CountDownLatch(1);
        final CopyOnWriteArrayList<Socket> clients = new CopyOnWriteArrayList<>();

        Fixture(boolean blocked) throws Exception { this(blocked ? "blocked" : "healthy"); }

        Fixture(String firstResponse) throws Exception {
            Thread thread = new Thread(() -> {
                int requests = 0;
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        clients.add(socket);
                        String mode = requests++ == 0 ? firstResponse : "healthy";
                        Thread response = new Thread(() -> respond(socket, mode), "monitor-fixture-response");
                        response.setDaemon(true);
                        response.start();
                    } catch (Exception ignored) { return; }
                }
            }, "monitor-recovery-fixture");
            thread.setDaemon(true);
            thread.start();
        }

        private void respond(Socket socket, String mode) {
            try (socket) {
                var reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                received.countDown();
                if (mode.startsWith("blocked")) release.await(30, TimeUnit.SECONDS);
                String content = mode.equals("blocked") || mode.equals("invalid-status") ? "invalid response"
                    : mode.equals("oversize") ? " ".repeat(256_001) : "{\"threads\":[],\"completions\":[]}";
                byte[] body = content.getBytes(StandardCharsets.UTF_8);
                int code = mode.startsWith("http-") ? Integer.parseInt(mode.substring(5)) : 200;
                String redirect = code == 302 ? "Location: /redirect-must-not-be-followed\r\n" : "";
                socket.getOutputStream().write(("HTTP/1.1 " + code + " QA\r\n" + redirect + "Content-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if (mode.equals("trickle")) {
                    for (byte value : body) {
                        socket.getOutputStream().write(value);
                        socket.getOutputStream().flush();
                        Thread.sleep(1_000); // Activity every second defeats an idle-only timeout.
                    }
                } else socket.getOutputStream().write(body);
                socket.getOutputStream().flush();
                responded.countDown();
            } catch (Exception ignored) { /* Cancellation closes the fixture connection. */ }
        }

        @Override public void close() throws Exception {
            release.countDown();
            server.close();
            for (Socket client : clients) client.close();
        }
    }
}
