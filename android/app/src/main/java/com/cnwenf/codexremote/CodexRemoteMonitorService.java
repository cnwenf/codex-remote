package com.cnwenf.codexremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
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
    private final Map<String, String> previous = new HashMap<>();
    private final Set<String> notifiedRunning = new HashSet<>();
    private String connectionId;
    private String connectionName;
    private String baseUrl;

    static Intent startIntent(Context context, String id, String name, String baseUrl) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("connectionId", id)
            .putString("name", name)
            .putString("baseUrl", baseUrl)
            .apply();
        return new Intent(context, CodexRemoteMonitorService.class)
            .putExtra("connectionId", id)
            .putExtra("name", name)
            .putExtra("baseUrl", baseUrl);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        restorePreviousStates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
        startForeground(ONGOING_ID, ongoing("正在检查运行中的对话", "Codex Remote 后台监控已开启", null));
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_STICKY;
    }

    static void clearSavedMonitor(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            executor.execute(() -> {
                try { update(fetchStatus()); } catch (Exception ignored) {}
                handler.postDelayed(this, POLL_MS);
            });
        }
    };

    private JSONArray fetchStatus() throws Exception {
        String token = new EncryptedSecretStore(this).get(connectionId);
        if (token == null) throw new IllegalStateException("missing-token");
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + "/api/mobile/status").openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(8_000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        if (connection.getResponseCode() != 200) throw new IllegalStateException("status-http-" + connection.getResponseCode());
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null && body.length() < 256_000) body.append(line);
            return new JSONObject(body.toString()).getJSONArray("threads");
        } finally {
            connection.disconnect();
        }
    }

    private void update(JSONArray threads) throws Exception {
        List<String> titles = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        Set<String> currentRunning = new HashSet<>();
        Map<String, String> current = new HashMap<>();
        for (int index = 0; index < threads.length(); index++) {
            JSONObject thread = threads.getJSONObject(index);
            String id = thread.getString("id");
            String title = thread.optString("title", "Untitled task");
            String status = thread.optString("status", "unknown");
            current.put(id, status);
            if ("running".equals(status)) {
                ids.add(id);
                titles.add(title);
                currentRunning.add(id);
                notifyRunning(id, title);
            }
            if ("running".equals(previous.get(id)) && ("idle".equals(status) || "error".equals(status))) {
                notifyCompleted(id, title, "error".equals(status));
            }
        }
        previous.clear();
        previous.putAll(current);
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
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_RUNNING, "运行中的对话", NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_COMPLETED, "对话完成", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private void restorePreviousStates() {
        String encoded = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("states", null);
        if (encoded == null) return;
        try {
            JSONObject states = new JSONObject(encoded);
            Iterator<String> ids = states.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                previous.put(id, states.optString(id, "unknown"));
            }
        } catch (Exception ignored) {}
    }

    private void persistPreviousStates() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("states", new JSONObject(previous).toString())
            .apply();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(poll);
        executor.shutdownNow();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
