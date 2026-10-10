package com.pansophy.vibhavgpt.direct;

import com.getcapacitor.BridgeActivity;

import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DirectDownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
