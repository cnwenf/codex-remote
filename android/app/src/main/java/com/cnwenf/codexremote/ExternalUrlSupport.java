package com.cnwenf.codexremote;

import java.net.URI;

final class ExternalUrlSupport {
    private ExternalUrlSupport() {}

    static boolean isAllowedWebUrl(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            return uri.getHost() != null
                && ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme));
        } catch (RuntimeException ignored) {
            return false;
        }
    }
}
