package com.cnwenf.codexremote;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.HttpURLConnection;
import java.net.URI;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class NativeImageUploadSupportTest {
    @Test(timeout = 3000)
    public void cancellationStillDisconnectsAsynchronouslyAfterTheUploadExecutorShutsDown() throws Exception {
        CountDownLatch disconnectStarted = new CountDownLatch(1);
        CountDownLatch releaseDisconnect = new CountDownLatch(1);
        HttpURLConnection connection = new HttpURLConnection(URI.create("http://127.0.0.1/api/images").toURL()) {
            @Override public void connect() {}
            @Override public boolean usingProxy() { return false; }
            @Override public void disconnect() {
                disconnectStarted.countDown();
                try { releaseDisconnect.await(2, TimeUnit.SECONDS); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
        };
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.shutdown();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            // A blocked disconnect must not block the plugin/bridge caller.
            caller.submit(() -> NativeImageUploadSupport.disconnectAsync(connection, executor)).get(1, TimeUnit.SECONDS);
            assertTrue(disconnectStarted.await(1, TimeUnit.SECONDS));
        } finally {
            releaseDisconnect.countDown();
            caller.shutdownNow();
        }
    }

    @Test
    public void onlyAllowsExactAuthenticatedImageUploadTargets() {
        assertTrue(NativeImageUploadSupport.isAllowedUploadUrl("https://remote.example.test/api/images"));
        assertTrue(NativeImageUploadSupport.isAllowedUploadUrl("http://127.0.0.1:4321/api/images"));
        assertFalse(NativeImageUploadSupport.isAllowedUploadUrl("https://remote.example.test/api/images?token=leak"));
        assertFalse(NativeImageUploadSupport.isAllowedUploadUrl("https://user:pass@remote.example.test/api/images"));
        assertFalse(NativeImageUploadSupport.isAllowedUploadUrl("https://remote.example.test/api/mobile/status"));
        assertFalse(NativeImageUploadSupport.isAllowedUploadUrl("file:///tmp/image"));
    }

    @Test
    public void onlyAllowsSupportedImageMimeTypes() {
        assertTrue(NativeImageUploadSupport.isAllowedMimeType("image/png"));
        assertTrue(NativeImageUploadSupport.isAllowedMimeType("image/jpeg"));
        assertTrue(NativeImageUploadSupport.isAllowedMimeType("image/gif"));
        assertTrue(NativeImageUploadSupport.isAllowedMimeType("image/webp"));
        assertFalse(NativeImageUploadSupport.isAllowedMimeType("image/svg+xml"));
        assertFalse(NativeImageUploadSupport.isAllowedMimeType("text/plain"));
    }
}
