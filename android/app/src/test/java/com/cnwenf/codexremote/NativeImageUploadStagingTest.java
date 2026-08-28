package com.cnwenf.codexremote;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
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
