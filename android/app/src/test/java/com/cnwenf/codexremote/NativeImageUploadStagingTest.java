package com.cnwenf.codexremote;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeImageUploadStagingTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void stagesBoundedChunksAndClaimsTheCompleteFile() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String id = staging.start();

        staging.append(id, new byte[] { 1, 2, 3 });
        staging.append(id, new byte[] { 4, 5 });
        File completed = staging.claim(id);

        assertArrayEquals(new byte[] { 1, 2, 3, 4, 5 }, Files.readAllBytes(completed.toPath()));
        assertThrows(IllegalStateException.class, () -> staging.append(id, new byte[] { 6 }));
        assertThrows(IllegalStateException.class, () -> staging.claim(id));
    }

    @Test
    public void cancellationStillOwnsTheFileAfterNetworkUploadClaimsIt() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String id = staging.start();
        staging.append(id, new byte[] { 1, 2, 3 });
        File uploading = staging.claim(id);

        staging.cancel(id);

        assertFalse(uploading.exists());
    }

    @Test
    public void cancelsTheClaimedNetworkOperationExactlyOnce() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String id = staging.start();
        staging.claim(id);
        AtomicInteger cancelled = new AtomicInteger();
        staging.onCancel(id, cancelled::incrementAndGet);

        staging.cancel(id);
        staging.cancel(id);

        assertTrue(cancelled.get() == 1);
        assertFalse(staging.isActive(id));
    }

    @Test
    public void cancelsANetworkOperationAttachedAfterTimeout() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String id = staging.start();
        staging.claim(id);
        staging.cancel(id);
        AtomicInteger cancelled = new AtomicInteger();

        staging.onCancel(id, cancelled::incrementAndGet);

        assertTrue(cancelled.get() == 1);
    }

    @Test
    public void completionReleasesTheFileWithoutCancellingTheSuccessfulRequest() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String id = staging.start();
        File file = staging.claim(id);
        AtomicInteger cancelled = new AtomicInteger();
        staging.onCancel(id, cancelled::incrementAndGet);

        staging.complete(id);
        staging.cancel(id);

        assertFalse(file.exists());
        assertFalse(staging.isActive(id));
        assertTrue(cancelled.get() == 0);
    }

    @Test
    public void destructionCancelsPendingAndClaimedUploads() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 8);
        String pending = staging.start();
        String uploading = staging.start();
        File file = staging.claim(uploading);
        AtomicInteger cancelled = new AtomicInteger();
        staging.onCancel(uploading, cancelled::incrementAndGet);

        staging.cancelAll();

        assertFalse(staging.isActive(pending));
        assertFalse(staging.isActive(uploading));
        assertFalse(file.exists());
        assertTrue(cancelled.get() == 1);
        assertThrows(IllegalStateException.class, staging::start);
    }

    @Test
    public void rejectsOversizedUploadsAndDeletesCancelledFiles() throws Exception {
        NativeImageUploadStaging staging = new NativeImageUploadStaging(temporary.getRoot(), 4);
        String oversized = staging.start();
        staging.append(oversized, new byte[] { 1, 2, 3 });
        assertThrows(IllegalArgumentException.class, () -> staging.append(oversized, new byte[] { 4, 5 }));
        staging.cancel(oversized);

        String cancelled = staging.start();
        staging.append(cancelled, new byte[] { 1 });
        assertTrue(temporary.getRoot().listFiles().length > 0);
        staging.cancel(cancelled);
        assertFalse(temporary.getRoot().listFiles().length > 0);
    }
}
