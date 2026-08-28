package com.cnwenf.codexremote;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeImageUploadSupportTest {
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
