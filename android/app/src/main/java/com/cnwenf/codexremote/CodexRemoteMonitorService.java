package com.cnwenf.codexremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Build;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class CodexRemoteMonitorService extends Service {
    private static final String PREFS = "codex_remote_monitor";
    static final String CHANNEL_RUNNING = "codex_remote_running";
    static final String CHANNEL_COMPLETED = "codex_remote_completed";
    static final String GROUP_RUNNING = "codex_remote_running_threads";
    static final int ONGOING_ID = 1001;
    static final long POLL_MS = 15_000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private NotificationTracker tracker = new NotificationTracker();
    private final Set<String> notifiedRunning = new HashSet<>();
    private static volatile boolean active;
    private int generation;
    private long monitoringStartedAt;
    private String connectionId;
    private String connectionName;
    private String baseUrl;

    static Intent startIntent(Context context, String id, String name, String baseUrl) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        if (!id.equals(prefs.getString("connectionId", null))) {
            editor.remove("states").remove("seenCompletions").remove("completionBaseline").remove("trackerConnectionId").remove("turns");
        }
        editor
            .putString("connectionId", id)
            .putString("name", name)
            .putString("baseUrl", baseUrl)
            .putString("health", "starting")
            .putLong("lastAttemptAt", System.currentTimeMillis())
            .apply();
        return new Intent(context, CodexRemoteMonitorService.class)
            .putExtra("connectionId", id)
            .putExtra("name", name)
            .putExtra("baseUrl", baseUrl);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        active = true;
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        generation++;
        String previousConnection = connectionId;
        if (intent != null) {
            connectionId = intent.getStringExtra("connectionId");
            connectionName = intent.getStringExtra("name");
            baseUrl = intent.getStringExtra("baseUrl");
        }
        if (connectionId == null || baseUrl == null) {
            connectionId = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("connectionId", null);
            connectionName = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("name", null);
            baseUrl = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("baseUrl", null);
        }
        if (connectionId == null || baseUrl == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!connectionId.equals(previousConnection)) {
            monitoringStartedAt = SystemClock.elapsedRealtime();
            for (String oldId : notifiedRunning) getSystemService(NotificationManager.class).cancel(runningNotificationId(oldId));
            notifiedRunning.clear();
            restorePreviousStates();
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("health", "starting")
            .putLong("lastAttemptAt", System.currentTimeMillis()).apply();
        startForeground(ONGOING_ID, ongoing("正在检查运行中的对话", "Codex Remote 后台监控已开启", null));
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_STICKY;
    }

    static void clearSavedMonitor(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static void recordHealth(Context context, @Nullable String error) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString("health", error == null ? "healthy" : "error")
            .putString("error", error)
            .putLong("lastAttemptAt", System.currentTimeMillis()).apply();
    }

    static JSObject notificationStatus(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("enabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("runningEnabled", channelEnabled(manager, CHANNEL_RUNNING));
        result.put("completedEnabled", channelEnabled(manager, CHANNEL_COMPLETED));
        String health = prefs.getString("health", "starting");
        if (prefs.getString("connectionId", null) == null) health = "idle";
        else if (!active || System.currentTimeMillis() - prefs.getLong("lastAttemptAt", 0) > 45_000) health = "stopped";
        result.put("state", health);
        result.put("error", prefs.getString("error", ""));
        return result;
    }

    private static boolean channelEnabled(NotificationManager manager, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationChannel channel = manager.getNotificationChannel(id);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            final int requestedGeneration = generation;
            final String requestedId = connectionId;
            final String requestedUrl = baseUrl;
            executor.execute(() -> {
                JSONObject snapshot = null;
                String error = null;
                try { snapshot = fetchStatus(requestedId, requestedUrl); }
                catch (Exception cause) { error = "unauthorized".equals(cause.getMessage()) ? "unauthorized" : "unavailable"; }
                final JSONObject result = snapshot;
                final String failure = error;
                handler.post(() -> {
                    // A late response for a previously selected Mac must not update notifications or health.
                    if (!active || requestedGeneration != generation) return;
                    String problem = failure;
                    try {
                        if (result != null) {
                            JSONObject bridge = result.optJSONObject("bridge");
                            if (bridge != null && !bridge.optBoolean("available", true)) problem = "bridge-unavailable";
                            else update(result);
                        }
                    } catch (Exception cause) { problem = "invalid-status"; }
                    recordHealth(CodexRemoteMonitorService.this, problem);
                    if (problem != null) getSystemService(NotificationManager.class).notify(ONGOING_ID,
                        ongoing("后台监控异常", "无法获取任务状态，正在自动重试", null));
                    handler.postDelayed(this, POLL_MS);
                });
            });
        }
    };

    private JSONObject fetchStatus(String id, String url) throws Exception {
        String token = new EncryptedSecretStore(this).get(id);
        if (token == null) throw new IllegalStateException("unauthorized");
        HttpURLConnection connection = (HttpURLConnection) new URL(url + "/api/mobile/status").openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(8_000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setInstanceFollowRedirects(false);
        try {
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new IOException("unauthorized");
            if (status != 200) throw new IOException("unavailable");
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder body = new StringBuilder();
                char[] chunk = new char[4096];
                int count;
                while ((count = reader.read(chunk)) != -1) {
                    if (body.length() + count > 256_000) throw new IOException("status-too-large");
                    body.append(chunk, 0, count);
                }
                return new JSONObject(body.toString());
            }
        } finally {
            connection.disconnect();
        }
    }

    private void update(JSONObject snapshot) throws Exception {
        JSONArray threads = snapshot.getJSONArray("threads");
        JSONArray completions = snapshot.optJSONArray("completions");
        if (threads.length() > 100 || (completions != null && completions.length() > 100)) throw new IOException("status-too-large");
        List<String> titles = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        Set<String> currentRunning = new HashSet<>();
        Map<String, String> current = new HashMap<>();
        Map<String, String> turnIds = new HashMap<>();
        Map<String, JSONObject> byId = new HashMap<>();
        Map<String, String> previous = tracker.states();
        List<String> eventIds = new ArrayList<>();
        Map<String, JSONObject> events = new HashMap<>();
        Set<String> initialEligible = new HashSet<>();
        // Use server time and local elapsed duration, not wall-clock agreement between devices.
        long baseline = snapshot.optLong("generatedAt", 0) - (SystemClock.elapsedRealtime() - monitoringStartedAt);
        if (completions != null) {
            for (int index = 0; index < completions.length(); index++) {
                JSONObject event = completions.getJSONObject(index);
                String threadId = event.getString("threadId");
                String turnId = event.getString("turnId");
                String status = event.getString("status");
                if (threadId.length() > 512 || turnId.length() > 512 || (!status.equals("idle") && !status.equals("error"))) throw new IOException("invalid-completion");
                String id = NotificationTracker.completionKey(threadId, turnId);
                eventIds.add(id);
                events.put(id, event);
                if (("running".equals(previous.get(threadId)) && turnId.equals(tracker.turnId(threadId))) ||
                    (snapshot.optLong("generatedAt", 0) > 0 && event.optLong("completedAt", 0) >= baseline)) initialEligible.add(id);
            }
        }
        for (int index = 0; index < threads.length(); index++) {
            JSONObject thread = threads.getJSONObject(index);
            String id = thread.getString("id");
            String title = thread.optString("title", "Untitled task");
            String status = thread.optString("status", "unknown");
            current.put(id, status);
            String turnId = thread.optString("turnId", "");
            if (!turnId.isEmpty()) turnIds.put(id, turnId);
            byId.put(id, thread);
            if ("running".equals(status)) {
                ids.add(id);
                titles.add(title);
                currentRunning.add(id);
                notifyRunning(id, title);
            }
        }
        List<String> transitions = tracker.transitions(current, turnIds);
        for (String id : transitions) {
            String turnId = tracker.turnId(id);
            if (turnId != null) initialEligible.add(NotificationTracker.completionKey(id, turnId));
        }
        Set<String> completedThreads = new HashSet<>();
        if (completions != null) {
            for (String id : tracker.completions(eventIds, initialEligible)) {
                JSONObject event = events.get(id);
                String threadId = event.getString("threadId");
                completedThreads.add(threadId);
                notifyCompleted(threadId, event.optString("title", "Untitled task"), "error".equals(event.optString("status")));
            }
        }
        // Also covers list-only terminal evidence and gateway restarts that lost their event buffer.
        for (String id : transitions) {
            String turnId = tracker.turnId(id);
            if (turnId == null && completedThreads.contains(id)) continue;
            if (turnId != null && !tracker.acknowledge(NotificationTracker.completionKey(id, turnId))) continue;
            JSONObject thread = byId.get(id);
            notifyCompleted(id, thread.optString("title", "Untitled task"), "error".equals(current.get(id)));
        }
        persistPreviousStates();
        NotificationManager manager = getSystemService(NotificationManager.class);
        for (String oldId : new HashSet<>(notifiedRunning)) {
            if (!currentRunning.contains(oldId)) manager.cancel(runningNotificationId(oldId));
        }
        notifiedRunning.clear();
        notifiedRunning.addAll(currentRunning);
        String title = titles.isEmpty() ? "没有运行中的对话" : titles.size() + " 个对话运行中";
        String body = titles.isEmpty() ? (connectionName == null ? "Codex Remote" : connectionName) : joinTitles(titles);
        String firstId = ids.isEmpty() ? null : ids.get(0);
        manager.notify(ONGOING_ID, ongoing(title, body, firstId));
    }

    private Notification ongoing(String title, String body, @Nullable String threadId) {
        return new NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_codex_remote)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setGroup(GROUP_RUNNING)
            .setGroupSummary(true)
            .setContentIntent(openIntent(threadId, ONGOING_ID))
            .build();
    }

    private void notifyRunning(String threadId, String title) {
        int notificationId = runningNotificationId(threadId);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_codex_remote)
            .setContentTitle(title)
            .setContentText(connectionName == null ? "对话运行中" : connectionName + " · 对话运行中")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setGroup(GROUP_RUNNING)
            .setContentIntent(openIntent(threadId, notificationId))
            .build();
        getSystemService(NotificationManager.class).notify(notificationId, notification);
    }

    static int runningNotificationId(String threadId) {
        return 10_000 + Math.floorMod(threadId.hashCode(), 9_000);
    }

    private void notifyCompleted(String threadId, String title, boolean failed) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_COMPLETED)
            .setSmallIcon(R.drawable.ic_stat_codex_remote)
            .setContentTitle(failed ? "对话执行失败" : "对话已完成")
            .setContentText(title)
            .setAutoCancel(true)
            .setContentIntent(openIntent(threadId, threadId.hashCode()))
            .build();
        getSystemService(NotificationManager.class).notify(20_000 + Math.abs(threadId.hashCode() % 10_000), notification);
    }

    private PendingIntent openIntent(@Nullable String threadId, int requestCode) {
        String path = "codex-remote://connection/" + Uri.encode(connectionId);
        if (threadId != null) path += "/thread/" + Uri.encode(threadId);
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(path), this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static JSObject deepLinkTarget(@Nullable Uri data) {
        if (data == null || !"codex-remote".equals(data.getScheme()) || !"connection".equals(data.getHost())) return null;
        List<String> segments = data.getPathSegments();
        if (segments.size() != 3 || !"thread".equals(segments.get(1))) return null;
        JSObject result = new JSObject();
        result.put("connectionId", segments.get(0));
        result.put("threadId", segments.get(2));
        return result;
    }

    private String joinTitles(List<String> titles) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < titles.size() && index < 3; index++) {
            if (index > 0) result.append("、");
            result.append(titles.get(index));
        }
        if (titles.size() > 3) result.append(" 等 ").append(titles.size()).append(" 个");
        return result.toString();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_RUNNING, "运行中的对话", NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_COMPLETED, "对话完成", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private void restorePreviousStates() {
        tracker = new NotificationTracker();
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!connectionId.equals(prefs.getString("trackerConnectionId", prefs.getString("connectionId", null)))) return;
        String encoded = prefs.getString("states", null);
        if (encoded == null) return;
        try {
            Map<String, String> previous = new HashMap<>();
            JSONObject states = new JSONObject(encoded);
            Iterator<String> ids = states.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                previous.put(id, states.optString(id, "unknown"));
            }
            JSONArray seen = new JSONArray(prefs.getString("seenCompletions", "[]"));
            List<String> seenIds = new ArrayList<>();
            for (int index = 0; index < seen.length(); index++) seenIds.add(seen.getString(index));
            Map<String, String> turnIds = new HashMap<>();
            JSONObject turns = new JSONObject(prefs.getString("turns", "{}"));
            Iterator<String> turnKeys = turns.keys();
            while (turnKeys.hasNext()) { String id = turnKeys.next(); turnIds.put(id, turns.getString(id)); }
            tracker = new NotificationTracker(previous, seenIds, prefs.getBoolean("completionBaseline", false), turnIds);
        } catch (Exception ignored) {}
    }

    private void persistPreviousStates() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("trackerConnectionId", connectionId)
            .putString("states", new JSONObject(tracker.states()).toString())
            .putString("seenCompletions", new JSONArray(tracker.seenIds()).toString())
            .putString("turns", new JSONObject(tracker.turns()).toString())
            .putBoolean("completionBaseline", tracker.initialized())
            .apply();
    }

    @Override
    public void onDestroy() {
        active = false;
        generation++;
        handler.removeCallbacks(poll);
        executor.shutdownNow();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
