package com.cnwenf.codexremote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpdateInstallerSupportTest {
    @Test
    public void onlyAllowsHttpsGitHubReleaseHosts() {
        assertTrue(UpdateInstallerSupport.isAllowedDownloadUrl("https://github.com/cnwenf/codex-remote/releases/download/v1/app.apk"));
        assertTrue(UpdateInstallerSupport.isAllowedDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/app.apk"));
        assertTrue(UpdateInstallerSupport.isAllowedDownloadUrl("https://raw.githubusercontent.com/cnwenf/codex-remote/android-download/v1/app.apk"));
        assertTrue(UpdateInstallerSupport.isAllowedDownloadUrl("https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@android-download/v1/app.apk"));
        assertFalse(UpdateInstallerSupport.isAllowedDownloadUrl("http://github.com/cnwenf/codex-remote/app.apk"));
        assertFalse(UpdateInstallerSupport.isAllowedDownloadUrl("https://github.com.attacker.test/app.apk"));
    }

    @Test
    public void parsesThePublishedSha256Line() {
        assertEquals(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            UpdateInstallerSupport.parseSha256("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  app.apk\n")
        );
    }
}
