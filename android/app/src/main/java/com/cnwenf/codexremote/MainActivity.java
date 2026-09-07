package com.cnwenf.codexremote;

import android.os.Bundle;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CodexRemoteNativePlugin.class);
        super.onCreate(savedInstanceState);
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return super.onShowFileChooser(view, callback, new ImageFileChooserParams(params));
            }
        });
    }
}
