package com.essenceprotocol.game;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Essence Protocol for Android: the game (and its content editor) runs in a WebView from the files
 * packed into the app, served on a private https address so it works like the web version:
 * saves in local storage, the merge database from its JSON files, fully offline.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String TAG = "EssenceProtocol";
    static final int PICK_FILE = 7;
    WebView web;
    ValueCallback<Uri[]> picking;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11, 14, 24));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        web.addJavascriptInterface(new Bridge(), "EPAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return serve(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "nothing opens " + u);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, final String url) {
                // one line in the log once the title has loaded the merge database (CI checks it)
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        web.evaluateJavascript("(document.getElementById('bakeInfo')||{}).textContent||document.title", new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String t) {
                                Log.i(TAG, "page: " + url + " · " + t);
                            }
                        });
                    }
                }, 15000);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(TAG, "console: " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (picking != null) picking.onReceiveValue(null);
                picking = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Open a world file"), PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    picking = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        immersive();
        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl("https://" + HOST + "/index.html");
    }

    /** The app's own files, for its own address; everything else is left alone (and has no network). */
    WebResourceResponse serve(Uri u) {
        if (!HOST.equals(u.getHost())) return null;
        String path = u.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.endsWith("/")) path += "index.html";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        try {
            InputStream in = getAssets().open("game" + path);
            String mime = mime(path);
            boolean text = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json") || mime.endsWith("xml");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        }
    }

    static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** What the page can ask of the phone: sharing a world (a file or a code) with the share sheet. */
    class Bridge {
        @JavascriptInterface
        public void share(String title, String text) {
            final Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_SUBJECT, title);
            i.putExtra(Intent.EXTRA_TEXT, text);
            final String t = title;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(Intent.createChooser(i, t));
                    } catch (ActivityNotFoundException e) {
                        Log.w(TAG, "no app to share with");
                    }
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILE && picking != null) {
            picking.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            picking = null;
        }
    }

    /** Back closes what is open in the game (a menu, a dialog, a builder panel); at the title the app steps aside. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(function(){try{return window.epBack?!!window.epBack():false}catch(e){return false}})()", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (!"true".equals(v)) moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("try{window.EP_GAME&&EP_GAME.S&&EP_GAME.save()}catch(e){}", null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        immersive();
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @SuppressWarnings("deprecation")
    void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }
}
