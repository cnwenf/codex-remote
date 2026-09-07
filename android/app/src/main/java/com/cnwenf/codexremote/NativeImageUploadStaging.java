package com.cnwenf.codexremote;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

final class NativeImageUploadStaging {
    private final File directory;
    private final long maximumBytes;
    private final Map<String, Upload> uploads = new HashMap<>();
    private boolean closed;

    private static final class Upload {
        final File file;
        boolean claimed;
        Runnable cancel;

        Upload(File file) { this.file = file; }
    }

    NativeImageUploadStaging(File directory, long maximumBytes) {
        this.directory = directory;
        this.maximumBytes = maximumBytes;
    }

    synchronized String start() throws IOException {
        if (closed) throw new IllegalStateException("image-upload-staging-closed");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("image-upload-directory-unavailable");
        }
        String id = UUID.randomUUID().toString();
        File file = new File(directory, "image-upload-" + id + ".part");
        if (!file.createNewFile()) throw new IOException("image-upload-file-unavailable");
        uploads.put(id, new Upload(file));
        return id;
    }

    synchronized void append(String id, byte[] bytes) throws IOException {
        Upload upload = uploads.get(id);
        if (upload == null || upload.claimed) throw new IllegalStateException("image-upload-not-found");
        File file = upload.file;
        if (file.length() + bytes.length > maximumBytes) {
            throw new IllegalArgumentException("image-upload-too-large");
        }
        try (FileOutputStream output = new FileOutputStream(file, true)) {
            output.write(bytes);
        }
    }

    synchronized File claim(String id) {
        Upload upload = uploads.get(id);
        if (upload == null || upload.claimed) throw new IllegalStateException("image-upload-not-found");
        upload.claimed = true;
        return upload.file;
    }

    synchronized boolean isActive(String id) {
        return uploads.containsKey(id);
    }

    void onCancel(String id, Runnable cancel) {
        synchronized (this) {
            Upload upload = uploads.get(id);
            if (upload != null) {
                upload.cancel = cancel;
                return;
            }
        }
        // Cancellation may win while the network worker is starting.
        cancel.run();
    }

    synchronized void complete(String id) {
        Upload upload = uploads.remove(id);
        if (upload != null) upload.file.delete();
    }

    void cancel(String id) {
        Upload upload;
        synchronized (this) { upload = uploads.remove(id); }
        if (upload == null) return;
        upload.file.delete();
        // Do not hold the staging lock while disconnecting network I/O.
        if (upload.cancel != null) upload.cancel.run();
    }

    void cancelAll() {
        String[] ids;
        synchronized (this) {
            closed = true;
            ids = uploads.keySet().toArray(new String[0]);
        }
        for (String id : ids) cancel(id);
    }
}
