package com.cnwenf.codexremote;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "CodexRemoteNative")
public class CodexRemoteNativePlugin extends Plugin {
    private static final int MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    private static final int MAX_IMAGE_CHUNK_BYTES = 256 * 1024;
    private static final int MAX_IMAGE_RESPONSE_BYTES = 64 * 1024;
    private EncryptedSecretStore secrets;
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService imageUploadExecutor = Executors.newCachedThreadPool();
    private final AtomicBoolean updateInProgress = new AtomicBoolean(false);
    private File pendingUpdateFile;
    private NativeImageUploadStaging imageUploadStaging;

    @Override
    public void load() {
        secrets = new EncryptedSecretStore(getContext());
        imageUploadStaging = new NativeImageUploadStaging(
            new File(getContext().getCacheDir(), "image-uploads"),
            MAX_IMAGE_BYTES
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (imageUploadStaging != null) imageUploadStaging.cancelAll();
        imageUploadExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void readSecret(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("id-required"); return; }
        try {
            JSObject result = new JSObject();
            String value = secrets.get(id);
            if (value != null) result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("secure-storage-read-failed", error);
        }
    }

    @PluginMethod
    public void writeSecret(PluginCall call) {
        String id = call.getString("id");
        String value = call.getString("value");
        if (id == null || id.isEmpty() || value == null || value.isEmpty()) { call.reject("secret-required"); return; }
        try {
            secrets.put(id, value);
            call.resolve();
        } catch (Exception error) {
            call.reject("secure-storage-write-failed", error);
        }
    }

    @PluginMethod
    public void removeSecret(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("id-required"); return; }
        secrets.remove(id);
        call.resolve();
    }

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        String id = call.getString("connectionId");
        String name = call.getString("name");
        String baseUrl = call.getString("baseUrl");
        String token = call.getString("token");
        if (id == null || name == null || baseUrl == null || token == null) { call.reject("monitor-options-required"); return; }
        try {
            secrets.put(id, token);
            Intent intent = CodexRemoteMonitorService.startIntent(getContext(), id, name, baseUrl);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("monitor-start-failed", error);
        }
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        CodexRemoteMonitorService.clearSavedMonitor(getContext());
        getContext().stopService(new Intent(getContext(), CodexRemoteMonitorService.class));
        call.resolve();
    }

    @PluginMethod
    public void getLaunchTarget(PluginCall call) {
        Uri data = getActivity().getIntent().getData();
        JSObject result = CodexRemoteMonitorService.deepLinkTarget(data);
        getActivity().getIntent().setData(null);
        call.resolve(result == null ? new JSObject() : result);
    }

    @PluginMethod
    public void scanConnection(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build();
        GmsBarcodeScanning.getClient(getActivity(), options).startScan()
            .addOnSuccessListener(barcode -> {
                String value = barcode.getRawValue();
                if (value == null || value.isEmpty()) { call.reject("pairing-payload-empty"); return; }
                JSObject result = new JSObject();
                result.put("value", value);
                call.resolve(result);
            })
            .addOnCanceledListener(() -> call.reject("pairing-scan-cancelled"))
            .addOnFailureListener(error -> call.reject("pairing-scan-failed", error));
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String value = call.getString("url");
        if (value == null || value.isEmpty()) { call.reject("external-url-required"); return; }
        Uri uri = Uri.parse(value);
        if (!ExternalUrlSupport.isAllowedWebUrl(value)) {
            call.reject("external-url-insecure"); return;
        }
        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
            if (browser.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("external-url-open-failed"); return;
            }
            getActivity().startActivity(browser);
            call.resolve();
        } catch (Exception error) {
            call.reject("external-url-open-failed", error);
        }
    }

    @PluginMethod
    public void startImageUpload(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("uploadId", imageUploadStaging.start());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("图片上传准备失败，请重试");
        }
    }

    @PluginMethod
    public void appendImageUpload(PluginCall call) {
        String uploadId = call.getString("uploadId");
        String data = call.getString("data");
        if (uploadId == null || data == null || data.length() > 350_000) {
            call.reject("图片上传数据无效");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length > MAX_IMAGE_CHUNK_BYTES) {
                imageUploadStaging.cancel(uploadId);
                call.reject("图片上传数据无效");
                return;
            }
            imageUploadStaging.append(uploadId, bytes);
            call.resolve();
        } catch (IllegalArgumentException error) {
            imageUploadStaging.cancel(uploadId);
            call.reject("图片不能超过 10 MB");
        } catch (Exception error) {
            imageUploadStaging.cancel(uploadId);
            call.reject("图片上传准备失败，请重试");
        }
    }

    @PluginMethod
    public void finishImageUpload(PluginCall call) {
        String uploadId = call.getString("uploadId");
        String url = call.getString("url");
        String token = call.getString("token");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType");
        if (
            uploadId == null || token == null || token.isEmpty() || containsNewline(token) ||
            fileName == null || fileName.length() > 1024 || containsNewline(fileName) ||
            !NativeImageUploadSupport.isAllowedUploadUrl(url) ||
            !NativeImageUploadSupport.isAllowedMimeType(mimeType)
        ) {
            if (uploadId != null) imageUploadStaging.cancel(uploadId);
            call.reject("图片上传参数无效");
            return;
        }
        final File staged;
        try {
            staged = imageUploadStaging.claim(uploadId);
        } catch (Exception error) {
            call.reject("图片上传已失效，请重试");
            return;
        }
        try {
            imageUploadExecutor.execute(() -> {
                try {
                    call.resolve(uploadImage(staged, url, token, fileName, mimeType));
                } catch (Exception error) {
                    call.reject("图片上传失败，请检查连接后重试");
                } finally {
                    staged.delete();
                }
            });
        } catch (Exception error) {
            staged.delete();
            call.reject("图片上传失败，请重试");
        }
    }

    @PluginMethod
    public void cancelImageUpload(PluginCall call) {
        String uploadId = call.getString("uploadId");
        if (uploadId != null) imageUploadStaging.cancel(uploadId);
        call.resolve();
    }

    @PluginMethod
    public void downloadAndInstallUpdate(PluginCall call) {
        String apkUrl = call.getString("url");
        String checksumUrl = call.getString("checksumUrl");
        String version = call.getString("version", "update");
        if (!UpdateInstallerSupport.isAllowedDownloadUrl(apkUrl)
            || !UpdateInstallerSupport.isAllowedDownloadUrl(checksumUrl)) {
            call.reject("update-url-invalid");
            return;
        }
        if (!updateInProgress.compareAndSet(false, true)) {
            call.reject("update-already-running");
            return;
        }
        updateExecutor.execute(() -> {
            File temporary = null;
            try {
                String expectedSha256 = UpdateInstallerSupport.parseSha256(downloadText(checksumUrl, 4096));
                File updateDirectory = new File(getContext().getCacheDir(), "updates");
                if (!updateDirectory.exists() && !updateDirectory.mkdirs()) {
                    throw new IllegalStateException("update-directory-unavailable");
                }
                temporary = File.createTempFile("codex-remote-", ".apk.part", updateDirectory);
                downloadFile(apkUrl, temporary);
                String actualSha256 = sha256(temporary);
                if (!expectedSha256.equals(actualSha256)) throw new SecurityException("update-checksum-mismatch");

                File ready = new File(updateDirectory, "codex-remote-" + safeVersion(version) + ".apk");
                if (ready.exists() && !ready.delete()) throw new IllegalStateException("update-old-file-busy");
                if (!temporary.renameTo(ready)) throw new IllegalStateException("update-file-finalize-failed");
                temporary = null;
                emitUpdateProgress("installing", 100, null);
                getActivity().runOnUiThread(() -> launchInstallerOrPermission(call, ready));
            } catch (Exception error) {
                if (temporary != null) temporary.delete();
                updateInProgress.set(false);
                emitUpdateProgress("error", 0, updateMessage(error));
                call.reject("update-download-failed", error);
            }
        });
    }

    private void launchInstallerOrPermission(PluginCall call, File ready) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
                pendingUpdateFile = ready;
                Intent permission = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                startActivityForResult(call, permission, "installPermissionResult");
                return;
            }
            openSystemInstaller(call, ready);
        } catch (Exception error) {
            failInstaller(call, error);
        }
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        File ready = pendingUpdateFile;
        pendingUpdateFile = null;
        if (call == null || ready == null) {
            updateInProgress.set(false);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            failInstaller(call, new SecurityException("update-install-permission-denied"));
            return;
        }
        try {
            openSystemInstaller(call, ready);
        } catch (Exception error) {
            failInstaller(call, error);
        }
    }

    private void openSystemInstaller(PluginCall call, File ready) {
        Uri contentUri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            ready
        );
        Intent installer = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(contentUri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        installer.setClipData(ClipData.newRawUri("Codex Remote update", contentUri));
        PackageManager packageManager = getContext().getPackageManager();
        for (ResolveInfo handler : packageManager.queryIntentActivities(installer, PackageManager.MATCH_DEFAULT_ONLY)) {
            getContext().grantUriPermission(
                handler.activityInfo.packageName,
                contentUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        }
        getActivity().startActivity(installer);
        updateInProgress.set(false);
        call.resolve();
    }

    private void failInstaller(PluginCall call, Exception error) {
        updateInProgress.set(false);
        emitUpdateProgress("error", 0, error instanceof SecurityException
            ? "请允许 Codex Remote 安装更新"
            : "无法打开系统安装器");
        call.reject("update-installer-open-failed", error);
    }

    private String downloadText(String value, int maximumBytes) throws Exception {
        HttpURLConnection connection = openConnection(value);
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (output.size() + read > maximumBytes) throw new SecurityException("update-checksum-too-large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } finally {
            connection.disconnect();
        }
    }

    private void downloadFile(String value, File destination) throws Exception {
        HttpURLConnection connection = openConnection(value);
        long total = connection.getContentLengthLong();
        long received = 0;
        int lastProgress = -1;
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                received += read;
                int progress = total > 0 ? (int) Math.min(99, received * 100 / total) : 0;
                if (progress != lastProgress) {
                    lastProgress = progress;
                    emitUpdateProgress("downloading", progress, null);
                }
            }
            output.getFD().sync();
        } finally {
            connection.disconnect();
        }
    }

    private JSObject uploadImage(File source, String value, String token, String fileName, String mimeType) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(value).openConnection();
        try {
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(source.length());
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", mimeType.toLowerCase(Locale.ROOT));
            connection.setRequestProperty("X-File-Name", fileName);
            connection.setRequestProperty("User-Agent", "Codex-Remote-Android");
            try (InputStream input = new BufferedInputStream(new FileInputStream(source));
                 OutputStream output = connection.getOutputStream()) {
                byte[] buffer = new byte[32 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                output.flush();
            }
            int status = connection.getResponseCode();
            InputStream responseStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = readBoundedText(responseStream, MAX_IMAGE_RESPONSE_BYTES);
            Object data = body;
            try {
                if (!body.isEmpty()) data = new JSObject(body);
            } catch (Exception ignored) {
                // The shared response validator will reject a malformed success response.
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("data", data);
            return result;
        } finally {
            connection.disconnect();
        }
    }

    private static String readBoundedText(InputStream input, int maximumBytes) throws Exception {
        if (input == null) return "";
        try (InputStream stream = new BufferedInputStream(input);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                if (output.size() + read > maximumBytes) throw new IllegalStateException("image-upload-response-too-large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static boolean containsNewline(String value) {
        return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0;
    }

    private HttpURLConnection openConnection(String value) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(value).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/octet-stream");
        connection.setRequestProperty("User-Agent", "Codex-Remote-Android");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("update-http-" + status);
        }
        if (!UpdateInstallerSupport.isAllowedDownloadUrl(connection.getURL().toString())) {
            connection.disconnect();
            throw new SecurityException("update-redirect-invalid");
        }
        return connection;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private void emitUpdateProgress(String state, int progress, String message) {
        JSObject event = new JSObject();
        event.put("state", state);
        event.put("progress", progress);
        if (message != null) event.put("message", message);
        notifyListeners("updateDownloadProgress", event);
    }

    private static String safeVersion(String version) {
        return version == null ? "update" : version.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static String updateMessage(Exception error) {
        if (error instanceof SecurityException) return "安装包校验失败";
        String message = error.getMessage();
        if (message != null && message.startsWith("update-http-")) return "下载服务器暂时不可用";
        return "下载失败，请重试";
    }
}
