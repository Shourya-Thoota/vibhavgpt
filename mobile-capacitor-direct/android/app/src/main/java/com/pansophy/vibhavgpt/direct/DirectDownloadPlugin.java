package com.pansophy.vibhavgpt.direct;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;

import java.io.OutputStream;

/**
 * Saves authenticated bytes into the user's Downloads collection without
 * exposing the private API URL to another application. Android 10+ exposes
 * this through MediaStore, so no broad storage permission is needed.
 */
@CapacitorPlugin(name = "DirectDownload")
public class DirectDownloadPlugin extends Plugin {
    @PluginMethod
    public void saveFile(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Direct downloads require Android 10 or newer.");
            return;
        }

        String data = call.getString("data");
        String requestedName = call.getString("filename", "download");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (data == null || data.isEmpty()) {
            call.reject("The file data is empty.");
            return;
        }

        String filename = sanitizeFilename(requestedName);
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("The file data is invalid.");
            return;
        }

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VibhavGPT");
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            call.reject("Android could not create the download.");
            return;
        }

        try (OutputStream output = resolver.openOutputStream(uri)) {
            if (output == null) throw new IllegalStateException("Download stream unavailable");
            output.write(bytes);
            output.flush();

            ContentValues completed = new ContentValues();
            completed.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, completed, null, null);

            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            result.put("filename", filename);
            call.resolve(result);
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            call.reject("Android could not save the download.");
        }
    }

    private static String sanitizeFilename(String requestedName) {
        String value = requestedName == null ? "download" : requestedName;
        value = value.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return value.isEmpty() ? "download" : value;
    }
}
