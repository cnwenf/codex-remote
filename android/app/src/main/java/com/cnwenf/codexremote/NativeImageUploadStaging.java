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
    private final Map<String, File> pending = new HashMap<>();

    NativeImageUploadStaging(File directory, long maximumBytes) {
        this.directory = directory;
        this.maximumBytes = maximumBytes;
    }

    synchronized String start() throws IOException {
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IOException("image-upload-directory-unavailable");
        }
        String id = UUID.randomUUID().toString();
        File file = new File(directory, "image-upload-" + id + ".part");
        if (!file.createNewFile()) throw new IOException("image-upload-file-unavailable");
        pending.put(id, file);
        return id;
    }

    synchronized void append(String id, byte[] bytes) throws IOException {
        File file = pending.get(id);
        if (file == null) throw new IllegalStateException("image-upload-not-found");
        if (file.length() + bytes.length > maximumBytes) {
            throw new IllegalArgumentException("image-upload-too-large");
        }
        try (FileOutputStream output = new FileOutputStream(file, true)) {
            output.write(bytes);
        }
    }

    synchronized File claim(String id) {
        File file = pending.remove(id);
        if (file == null) throw new IllegalStateException("image-upload-not-found");
        return file;
    }

    synchronized void cancel(String id) {
        File file = pending.remove(id);
        if (file != null) file.delete();
    }

    synchronized void cancelAll() {
        for (File file : pending.values()) file.delete();
        pending.clear();
    }
}
