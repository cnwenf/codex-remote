package com.cnwenf.codexremote;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CodexRemoteNative")
public class CodexRemoteNativePlugin extends Plugin {
    private EncryptedSecretStore secrets;

    @Override
    public void load() {
        secrets = new EncryptedSecretStore(getContext());
    }

    @PluginMethod
    public void readSecret(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("id-required"); return; }
        try {
            JSObject result = new JSObject();
            String value = secrets.get(id);
            if (value != null) result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("secure-storage-read-failed", error);
        }
    }

    @PluginMethod
    public void writeSecret(PluginCall call) {
        String id = call.getString("id");
        String value = call.getString("value");
        if (id == null || id.isEmpty() || value == null || value.isEmpty()) { call.reject("secret-required"); return; }
        try {
            secrets.put(id, value);
            call.resolve();
        } catch (Exception error) {
            call.reject("secure-storage-write-failed", error);
        }
    }

    @PluginMethod
    public void removeSecret(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("id-required"); return; }
        secrets.remove(id);
        call.resolve();
    }

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        String id = call.getString("connectionId");
        String name = call.getString("name");
        String baseUrl = call.getString("baseUrl");
        String token = call.getString("token");
        if (id == null || name == null || baseUrl == null || token == null) { call.reject("monitor-options-required"); return; }
        try {
            secrets.put(id, token);
            Intent intent = CodexRemoteMonitorService.startIntent(getContext(), id, name, baseUrl);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("monitor-start-failed", error);
        }
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        CodexRemoteMonitorService.clearSavedMonitor(getContext());
        getContext().stopService(new Intent(getContext(), CodexRemoteMonitorService.class));
        call.resolve();
    }

    @PluginMethod
    public void getLaunchTarget(PluginCall call) {
        Uri data = getActivity().getIntent().getData();
        JSObject result = CodexRemoteMonitorService.deepLinkTarget(data);
        getActivity().getIntent().setData(null);
        call.resolve(result == null ? new JSObject() : result);
    }
}
