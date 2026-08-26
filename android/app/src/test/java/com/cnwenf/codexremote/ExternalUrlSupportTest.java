package com.cnwenf.codexremote;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExternalUrlSupportTest {
    @Test
    public void opensOnlyHttpAndHttpsLinksInTheSystemBrowser() {
        assertTrue(ExternalUrlSupport.isAllowedWebUrl("https://example.com/docs"));
        assertTrue(ExternalUrlSupport.isAllowedWebUrl("http://192.168.1.20:8080/status"));
        assertFalse(ExternalUrlSupport.isAllowedWebUrl("javascript:alert(1)"));
        assertFalse(ExternalUrlSupport.isAllowedWebUrl("codex-remote://thread/example"));
        assertFalse(ExternalUrlSupport.isAllowedWebUrl("https:///missing-host"));
    }
}
