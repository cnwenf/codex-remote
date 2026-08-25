package com.cnwenf.codexremote;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class UpdateInstallerSupport {
    private static final Pattern SHA256 = Pattern.compile("(?i)^\\s*([a-f0-9]{64})(?:\\s|$)");

    private UpdateInstallerSupport() {}

    static boolean isAllowedDownloadUrl(String value) {
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            String host = uri.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.ROOT);
            return host.equals("github.com")
                || host.endsWith(".github.com")
                || host.equals("githubusercontent.com")
                || host.endsWith(".githubusercontent.com");
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    static String parseSha256(String value) {
        Matcher matcher = SHA256.matcher(value == null ? "" : value);
        if (!matcher.find()) throw new IllegalArgumentException("update-checksum-invalid");
        return matcher.group(1).toLowerCase(Locale.ROOT);
    }
}
