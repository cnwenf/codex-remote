package com.cnwenf.codexremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class EncryptedSecretStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "codex-remote-token-key-v1";
    private static final String PREFS = "codex_remote_secure_tokens";
    private final Context context;

    EncryptedSecretStore(Context context) {
        this.context = context.getApplicationContext();
    }

    void put(String id, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        ByteBuffer bytes = ByteBuffer.allocate(4 + iv.length + encrypted.length);
        bytes.putInt(iv.length).put(iv).put(encrypted);
        preferences().edit().putString(preferenceKey(id), Base64.encodeToString(bytes.array(), Base64.NO_WRAP)).apply();
    }

    String get(String id) throws Exception {
        String encoded = preferences().getString(preferenceKey(id), null);
        if (encoded == null) return null;
        ByteBuffer bytes = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP));
        int ivLength = bytes.getInt();
        if (ivLength < 12 || ivLength > 16 || bytes.remaining() <= ivLength) throw new IllegalStateException("invalid-secret");
        byte[] iv = new byte[ivLength];
        bytes.get(iv);
        byte[] encrypted = new byte[bytes.remaining()];
        bytes.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    void remove(String id) {
        preferences().edit().remove(preferenceKey(id)).apply();
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry existing = store.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
         .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
         .setKeySize(256)
         .build());
        return generator.generateKey();
    }

    private String preferenceKey(String id) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(digest, Base64.NO_WRAP | Base64.URL_SAFE);
        } catch (Exception error) {
            throw new IllegalStateException("sha256-unavailable", error);
        }
    }
}
