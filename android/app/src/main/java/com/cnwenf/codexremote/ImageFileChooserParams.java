package com.cnwenf.codexremote;

import android.content.Intent;
import android.webkit.WebChromeClient.FileChooserParams;

/** Keeps Capacitor's chooser handling while providing a readable image document URI. */
final class ImageFileChooserParams extends FileChooserParams {
    private final FileChooserParams delegate;

    ImageFileChooserParams(FileChooserParams delegate) { this.delegate = delegate; }

    @Override public int getMode() { return delegate.getMode(); }
    @Override public String[] getAcceptTypes() { return delegate.getAcceptTypes(); }
    @Override public boolean isCaptureEnabled() { return delegate.isCaptureEnabled(); }
    @Override public CharSequence getTitle() { return delegate.getTitle(); }
    @Override public String getFilenameHint() { return delegate.getFilenameHint(); }
    @Override public Intent createIntent() {
        Intent intent = delegate.createIntent();
        String type = intent.getType();
        boolean images = type != null && type.startsWith("image/");
        if ("*/*".equals(type) && getAcceptTypes().length > 0) {
            images = java.util.Arrays.stream(getAcceptTypes()).allMatch(value -> value.startsWith("image/"));
        }
        if (isCaptureEnabled() || !images || !Intent.ACTION_GET_CONTENT.equals(intent.getAction())) return intent;
        // Android 13+ intercepts GET_CONTENT with Photo Picker proxy URIs.
        // Some WebViews reject those during FileReader's file-change checks.
        // DocumentsUI returns openable URIs without broad media permissions.
        return new Intent(intent).setAction(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
    }
}
