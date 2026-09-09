package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;
import android.content.Context;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit opt-in smoke test; uses the already selected connection without exporting its credentials. */
@RunWith(AndroidJUnit4.class)
public class SavedMonitorConnectionTest {
    @Test public void monitorsTheAlreadySelectedGateway() throws Exception {
        assumeTrue("Opt in with -e liveMonitor true on a configured QA device",
            "true".equals(InstrumentationRegistry.getArguments().getString("liveMonitor")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var saved = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String selected = saved.getString("codex-remote.selected.v1", null);
        assertNotNull("Select the local QA connection in the app first", selected);
        JSONArray connections = new JSONArray(saved.getString("codex-remote.connections.v1", "[]"));
        JSONObject connection = null;
        for (int i = 0; i < connections.length(); i++) {
            JSONObject item = connections.getJSONObject(i);
            if (selected.equals(item.optString("id"))) connection = item;
        }
        assertNotNull("The selected connection must already be saved", connection);
        ContextCompat.startForegroundService(context, CodexRemoteMonitorService.startIntent(context,
            selected, connection.getString("name"), connection.getString("baseUrl")));
        awaitHealthy(context, 0);
        long first = context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE).getLong("lastAttemptAt", 0);
        awaitHealthy(context, first);
        // Leave the app monitoring the user's selected connection, never a fixture endpoint.
    }

    private static void awaitHealthy(Context context, long previousAttempt) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 35_000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            var status = CodexRemoteMonitorService.notificationStatus(context);
            long attempt = context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE).getLong("lastAttemptAt", 0);
            if ("healthy".equals(status.optString("state")) && attempt > previousAttempt) {
                assertTrue(status.optString("error").isEmpty());
                return;
            }
            Thread.sleep(100);
        }
        fail("Live monitor did not become healthy: " + CodexRemoteMonitorService.notificationStatus(context));
    }
}
