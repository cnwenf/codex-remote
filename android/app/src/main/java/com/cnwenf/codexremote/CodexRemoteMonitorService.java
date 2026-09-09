package com.cnwenf.codexremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
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
import java.io.InterruptedIOException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.SSLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class CodexRemoteMonitorService extends Service {
    private static final String PREFS = "codex_remote_monitor";
    static final String CHANNEL_RUNNING = "codex_remote_running";
    static final String CHANNEL_COMPLETED = "codex_remote_completed";
    static final String GROUP_RUNNING = "codex_remote_running_threads";
    static final int ONGOING_ID = 1001;
    static final long POLL_MS = 15_000;
    static final long REQUEST_TIMEOUT_MS = 15_000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    // Transport cancellation releases old requests; the service watchdog owns the health deadline.
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build();
    private Call inFlight;
    private NotificationTracker tracker = new NotificationTracker();
    private final Set<String> notifiedRunning = new HashSet<>();
    private static volatile boolean active;
    private int generation;
    private long monitoringStartedAt;
    private String connectionId;
    private String connectionName;
    private String baseUrl;
    private Bitmap notificationLogo;

    static synchronized Intent startIntent(Context context, String id, String name, String baseUrl) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        if (!id.equals(prefs.getString("connectionId", null))) {
            editor.remove("states").remove("seenCompletions").remove("completionBaseline").remove("trackerConnectionId").remove("turns");
        }
        if (!id.equals(prefs.getString("connectionId", null)) || !baseUrl.equals(prefs.getString("baseUrl", null))) {
            editor.remove("lastSuccessAt").remove("consecutiveFailures").remove("error");
        }
        editor
            .putString("connectionId", id)
            .putString("name", name)
            .putString("baseUrl", baseUrl)
            .putString("health", "starting")
            .putLong("lastAttemptAt", System.currentTimeMillis())
            .apply();
        return new Intent(context, CodexRemoteMonitorService.class);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        active = true;
        createChannels();
        int size = Math.min(256, Math.round(64 * getResources().getDisplayMetrics().density));
        notificationLogo = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Drawable icon = getApplicationInfo().loadIcon(getPackageManager());
        icon.setBounds(0, 0, size, size);
        icon.draw(new Canvas(notificationLogo));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        synchronized (CodexRemoteMonitorService.class) {
            return startCurrentConnection();
        }
    }

    private int startCurrentConnection() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        generation++;
        handler.removeCallbacks(pollTimeout);
        if (inFlight != null) { inFlight.cancel(); inFlight = null; }
        String previousConnection = connectionId;
        // A queued Android start command may be older than the user's latest selection.
        // Saved configuration is the single target for initial starts, retries and service restarts.
        connectionId = prefs.getString("connectionId", null);
        connectionName = prefs.getString("name", null);
        baseUrl = prefs.getString("baseUrl", null);
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
        prefs.edit().putString("health", "starting")
            .putLong("lastAttemptAt", System.currentTimeMillis()).apply();
        startForeground(ONGOING_ID, ongoing("任务通知", "正在检查运行中的对话", null));
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_STICKY;
    }

    static synchronized void clearSavedMonitor(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static synchronized void recordHealth(Context context, @Nullable String error) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit()
            .putString("health", error == null ? "healthy" : "error")
            .putString("error", error)
            .putInt("consecutiveFailures", error == null ? 0 : Math.min(1000, prefs.getInt("consecutiveFailures", 0) + 1))
            .putLong("lastAttemptAt", System.currentTimeMillis());
        if (error == null) editor.putLong("lastSuccessAt", System.currentTimeMillis());
        editor.apply();
    }

    static synchronized JSObject notificationStatus(Context context) {
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
        result.put("connectionId", prefs.getString("connectionId", ""));
        result.put("connectionName", prefs.getString("name", ""));
        result.put("lastSuccessAt", prefs.getLong("lastSuccessAt", 0));
        result.put("consecutiveFailures", prefs.getInt("consecutiveFailures", 0));
        return result;
    }

    private static boolean matchesSavedConnection(SharedPreferences prefs, String id, String url) {
        return id != null && id.equals(prefs.getString("connectionId", null)) &&
            url != null && url.equals(prefs.getString("baseUrl", null));
    }

    private static boolean channelEnabled(NotificationManager manager, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationChannel channel = manager.getNotificationChannel(id);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            final int requestedGeneration = generation;
            handler.postDelayed(pollTimeout, REQUEST_TIMEOUT_MS);
            try {
                String token = new EncryptedSecretStore(CodexRemoteMonitorService.this).get(connectionId);
                if (token == null) { finishPoll(requestedGeneration, null, "unauthorized"); return; }
                inFlight = http.newCall(new Request.Builder().url(baseUrl + "/api/mobile/status")
                    .header("Authorization", "Bearer " + token).build());
                inFlight.enqueue(new Callback() {
                    @Override public void onFailure(Call call, IOException cause) {
                        finishPoll(requestedGeneration, null, errorCode(cause));
                    }
                    @Override public void onResponse(Call call, Response response) {
                        JSONObject result = null;
                        String failure = null;
                        try (response) {
                            int status = response.code();
                            if (status != 200) failure = status == 401 || status == 403 ? "unauthorized" : "http-" + status;
                            else result = readStatus(response);
                        } catch (Exception cause) { failure = errorCode(cause); }
                        finishPoll(requestedGeneration, failure == null ? result : null, failure);
                    }
                });
            } catch (Exception cause) { finishPoll(requestedGeneration, null, "start-failed"); }
        }
    };

    private final Runnable pollTimeout = () -> {
        // Do not wait for a stalled transport to deliver its callback before allowing recovery.
        generation++;
        if (inFlight != null) { inFlight.cancel(); inFlight = null; }
        finishPoll(generation, null, "timeout");
    };

    private void finishPoll(int requestedGeneration, @Nullable JSONObject result, @Nullable String failure) {
        handler.post(() -> {
            synchronized (CodexRemoteMonitorService.class) {
                // Saving a new target happens before Android delivers its start command.
                // Check ownership and write the result atomically with that saved-target change.
                if (!active || requestedGeneration != generation ||
                    !matchesSavedConnection(getSharedPreferences(PREFS, MODE_PRIVATE), connectionId, baseUrl)) return;
                handler.removeCallbacks(pollTimeout);
                inFlight = null;
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
                    ongoing("任务通知", "暂未获取到任务状态，将自动重新检查", null));
                handler.postDelayed(poll, POLL_MS);
            }
        });
    }

    private static String errorCode(Exception cause) {
        if (cause instanceof InterruptedIOException) return "timeout";
        if (cause instanceof UnknownHostException) return "dns";
        if (cause instanceof SSLException) return "tls";
        if (cause instanceof JSONException) return "invalid-status";
        return "unavailable"; // Never expose exception messages containing private addresses or credentials.
    }

    private static JSONObject readStatus(Response response) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body().byteStream(), StandardCharsets.UTF_8))) {
            StringBuilder body = new StringBuilder();
            char[] chunk = new char[4096];
            int count;
            while ((count = reader.read(chunk)) != -1) {
                if (body.length() + count > 256_000) throw new JSONException("status-too-large");
                body.append(chunk, 0, count);
            }
            return new JSONObject(body.toString());
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
        return notificationBuilder(CHANNEL_RUNNING)
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
        Notification notification = notificationBuilder(CHANNEL_RUNNING)
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
        Notification notification = notificationBuilder(CHANNEL_COMPLETED)
            .setContentTitle(failed ? "对话执行失败" : "对话已完成")
            .setContentText(title)
            .setAutoCancel(true)
            .setContentIntent(openIntent(threadId, threadId.hashCode()))
            .build();
        getSystemService(NotificationManager.class).notify(20_000 + Math.abs(threadId.hashCode() % 10_000), notification);
    }

    private NotificationCompat.Builder notificationBuilder(String channelId) {
        return new NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_codex_remote)
            .setLargeIcon(notificationLogo)
            .setColor(Color.BLACK);
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
        handler.removeCallbacks(pollTimeout);
        if (inFlight != null) { inFlight.cancel(); inFlight = null; }
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
