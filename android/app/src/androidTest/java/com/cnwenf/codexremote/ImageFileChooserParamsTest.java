package com.cnwenf.codexremote;

import android.content.Intent;
import android.webkit.WebChromeClient.FileChooserParams;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class ImageFileChooserParamsTest {
    @Test public void imageSelectionUsesOpenableDocumentsAndPreservesOptions() {
        Intent original = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/png", "image/jpeg"});
        ImageFileChooserParams params = new ImageFileChooserParams(params(original, false));
        Intent result = params.createIntent();
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, result.getAction());
        assertTrue(result.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("image/*", result.getType());
        assertTrue(result.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
        assertArrayEquals(new String[] {"image/png", "image/jpeg"}, result.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
        assertEquals(Intent.ACTION_GET_CONTENT, original.getAction());
        assertEquals(FileChooserParams.MODE_OPEN_MULTIPLE, params.getMode());
        assertArrayEquals(new String[] {"image/png", "image/jpeg"}, params.getAcceptTypes());
        assertEquals("Images", params.getTitle());
        assertEquals("test.png", params.getFilenameHint());
    }

    @Test public void captureAndNonImageIntentsKeepOriginalBehavior() {
        Intent capture = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*");
        assertSame(capture, new ImageFileChooserParams(params(capture, true)).createIntent());
        Intent document = new Intent(Intent.ACTION_GET_CONTENT).setType("application/pdf");
        assertSame(document, new ImageFileChooserParams(params(document, false)).createIntent());
        Intent other = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*");
        assertSame(other, new ImageFileChooserParams(params(other, false)).createIntent());
    }

    @Test public void imageMimeListWithWildcardIntentUsesDocuments() {
        Intent original = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*");
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, new ImageFileChooserParams(params(original, false)).createIntent().getAction());
    }

    private FileChooserParams params(Intent intent, boolean capture) {
        return new FileChooserParams() {
            @Override public int getMode() { return MODE_OPEN_MULTIPLE; }
            @Override public String[] getAcceptTypes() { return new String[] {"image/png", "image/jpeg"}; }
            @Override public boolean isCaptureEnabled() { return capture; }
            @Override public CharSequence getTitle() { return "Images"; }
            @Override public String getFilenameHint() { return "test.png"; }
            @Override public Intent createIntent() { return intent; }
        };
    }
}
