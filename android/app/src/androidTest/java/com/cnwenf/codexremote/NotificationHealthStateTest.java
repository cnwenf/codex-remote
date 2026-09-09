package com.cnwenf.codexremote;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real preferences and bridge projection; no network or UI fixture is substituted. */
@RunWith(AndroidJUnit4.class)
public class NotificationHealthStateTest {
    @Test public void failureHistorySurvivesRetryAndResetsOnlyOnSuccessOrConnectionChange() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var prefs = context.getSharedPreferences("codex_remote_monitor", Context.MODE_PRIVATE);
        var original = prefs.getAll();
        try {
            CodexRemoteMonitorService.clearSavedMonitor(context);
            CodexRemoteMonitorService.startIntent(context, "health-qa", "QA", "http://127.0.0.1:1");
            var initial = CodexRemoteMonitorService.notificationStatus(context);
            assertEquals("health-qa", initial.optString("connectionId"));
            assertEquals("QA", initial.optString("connectionName"));
            CodexRemoteMonitorService.recordHealth(context, null);
            long success = CodexRemoteMonitorService.notificationStatus(context).optLong("lastSuccessAt");
            assertTrue(success > 0);
            CodexRemoteMonitorService.recordHealth(context, "timeout");
            assertEquals(1, CodexRemoteMonitorService.notificationStatus(context).optInt("consecutiveFailures"));
            CodexRemoteMonitorService.startIntent(context, "health-qa", "QA", "http://127.0.0.1:1");
            assertEquals(1, CodexRemoteMonitorService.notificationStatus(context).optInt("consecutiveFailures"));
            CodexRemoteMonitorService.recordHealth(context, "timeout");
            var failed = CodexRemoteMonitorService.notificationStatus(context);
            assertEquals(2, failed.optInt("consecutiveFailures"));
            assertEquals(success, failed.optLong("lastSuccessAt"));
            CodexRemoteMonitorService.recordHealth(context, null);
            assertEquals(0, CodexRemoteMonitorService.notificationStatus(context).optInt("consecutiveFailures"));
            assertTrue(CodexRemoteMonitorService.notificationStatus(context).optString("error").isEmpty());
            CodexRemoteMonitorService.startIntent(context, "health-qa", "QA", "http://127.0.0.1:2");
            assertEquals(0, CodexRemoteMonitorService.notificationStatus(context).optLong("lastSuccessAt"));
            CodexRemoteMonitorService.recordHealth(context, null);
            CodexRemoteMonitorService.recordHealth(context, "timeout");
            CodexRemoteMonitorService.startIntent(context, "other-qa", "Other QA", "http://127.0.0.1:2");
            var other = CodexRemoteMonitorService.notificationStatus(context);
            assertEquals("other-qa", other.optString("connectionId"));
            assertEquals(0, other.optInt("consecutiveFailures"));
            assertEquals(0, other.optLong("lastSuccessAt"));
        } finally {
            var editor = prefs.edit().clear();
            original.forEach((key, value) -> {
                if (value instanceof String) editor.putString(key, (String) value);
                else if (value instanceof Long) editor.putLong(key, (Long) value);
                else if (value instanceof Integer) editor.putInt(key, (Integer) value);
                else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
            });
            editor.commit();
        }
    }
}
