package com.cnwenf.codexremote;

import java.net.URI;
import java.net.HttpURLConnection;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

final class NativeImageUploadSupport {
    private static final Set<String> MIME_TYPES = new HashSet<>(Arrays.asList(
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp"
    ));

    private NativeImageUploadSupport() {}

    static void disconnectAsync(HttpURLConnection connection, Executor executor) {
        try {
            executor.execute(connection::disconnect);
        } catch (RejectedExecutionException closed) {
            // Plugin destruction can close the worker pool just before cancellation.
            // Keep cleanup independent and never block the bridge on socket I/O.
            Thread cleanup = new Thread(connection::disconnect, "image-upload-cancel");
            cleanup.setDaemon(true);
            cleanup.start();
        }
    }

    static boolean isAllowedUploadUrl(String value) {
        if (value == null || value.isEmpty()) return false;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && uri.getHost() != null
                && !uri.getHost().isEmpty()
                && uri.getRawUserInfo() == null
                && uri.getRawQuery() == null
                && uri.getRawFragment() == null
                && "/api/images".equals(uri.getRawPath());
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean isAllowedMimeType(String value) {
        return value != null && MIME_TYPES.contains(value.toLowerCase());
    }
}
