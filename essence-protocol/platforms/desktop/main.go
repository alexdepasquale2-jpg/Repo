// Essence Protocol for Windows, Linux and macOS: one file that holds the whole game (and its
// content editor), serves it on this computer and opens it in its own window.
//
//	EssenceProtocol                play: opens the game in an app window
//	EssenceProtocol --lan          host it for phones and tablets on the same Wi-Fi as well
//	EssenceProtocol --no-open      only serve it (a home server); stop with Ctrl+C
//	EssenceProtocol --port 47823   the port (saves belong to it, so keep the default)
//
// The window is Microsoft Edge, Google Chrome, Chromium or Brave in app mode with a profile of its
// own (so saves stay put and the launcher knows when the window closes). Without one of those it
// opens the default browser and stops a little while after the last game tab is closed.
package main

import (
	"bytes"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed all:game
var files embed.FS

const defaultPort = 47823

// Pages get a tiny heartbeat, so a launcher that opened the default browser can tell when the game is gone.
const heartbeat = `<script>(function(){var p=function(){fetch('/__ep/alive',{method:'POST',keepalive:true}).catch(function(){})};p();setInterval(p,15000);addEventListener('pagehide',function(){navigator.sendBeacon&&navigator.sendBeacon('/__ep/bye')})})();</script>`

var (
	mu       sync.Mutex
	lastSeen = time.Now()
	byeAt    time.Time
)

func main() {
	port := flag.Int("port", defaultPort, "port to serve on (saves belong to it)")
	lan := flag.Bool("lan", false, "also serve to other devices on this network")
	noOpen := flag.Bool("no-open", false, "don't open a window; serve until stopped")
	flag.Parse()

	game, err := fs.Sub(files, "game")
	if err != nil {
		fail(err)
	}
	host := "127.0.0.1"
	if *lan {
		host = "0.0.0.0"
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, *port))
	if err != nil {
		// Already running? Then just open another window on it.
		if ours(*port) {
			if !*noOpen {
				open(fmt.Sprintf("http://127.0.0.1:%d/", *port), false)
			}
			return
		}
		fmt.Fprintf(os.Stderr, "port %d is taken; using another one (saves made on port %d won't show up there)\n", *port, *port)
		ln, err = net.Listen("tcp", host+":0")
		if err != nil {
			fail(err)
		}
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := fmt.Sprintf("http://127.0.0.1:%d/", addr.Port)
	if *lan {
		url += "__ep/host" // lists the addresses other devices use (Windows builds have no console)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/__ep/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("essence-protocol")) })
	mux.HandleFunc("/__ep/alive", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastSeen = time.Now()
		byeAt = time.Time{}
		mu.Unlock()
	})
	mux.HandleFunc("/__ep/bye", func(w http.ResponseWriter, r *http.Request) { mu.Lock(); byeAt = time.Now(); mu.Unlock() })
	mux.HandleFunc("/__ep/host", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		var links strings.Builder
		for _, ip := range lanIPs() {
			u := fmt.Sprintf("http://%s:%d/", ip, addr.Port)
			fmt.Fprintf(&links, `<p><a href="%s">%s</a></p>`, u, u)
		}
		if !*lan {
			links.Reset()
			links.WriteString("<p>Start it with --lan to play from other devices on this network.</p>")
		}
		fmt.Fprintf(w, `<!doctype html><meta name="viewport" content="width=device-width"><title>Essence Protocol host</title><body style="font:16px system-ui;background:#0b0e18;color:#e8eeff;padding:24px"><h1>Essence Protocol is hosting</h1><p>On a phone or tablet on the same Wi-Fi, open:</p>%s<p><a href="/">Play here</a></p>`, links.String())
	})
	mux.Handle("/", serve(game))
	go func() { fail(http.Serve(ln, mux)) }()

	fmt.Printf("Essence Protocol is at http://127.0.0.1:%d/\n", addr.Port)
	if *lan {
		for _, ip := range lanIPs() {
			fmt.Printf("  on this network: http://%s:%d/\n", ip, addr.Port)
		}
	}
	if *noOpen || *lan {
		if *lan && !*noOpen {
			go open(url, false)
		}
		fmt.Println("Serving until you stop it (Ctrl+C).")
		select {}
	}
	if open(url, true) {
		return // the app window closed
	}
	// The default browser has it: stop a while after its last page is gone.
	for {
		time.Sleep(5 * time.Second)
		mu.Lock()
		gone := (!byeAt.IsZero() && time.Since(byeAt) > 20*time.Second) || time.Since(lastSeen) > 4*time.Minute
		mu.Unlock()
		if gone {
			return
		}
	}
}

// serve sends the embedded files, with the heartbeat added to pages and nothing cached by HTTP
// (the game's service worker does the caching).
func serve(game fs.FS) http.Handler {
	static := http.FileServer(http.FS(game))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" || strings.HasSuffix(p, "/") {
			p += "index.html"
		}
		if strings.HasSuffix(p, ".html") {
			b, err := fs.ReadFile(game, p)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			b = bytes.Replace(b, []byte("</body>"), []byte(heartbeat+"</body>"), 1)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(b)
			return
		}
		if strings.HasSuffix(p, ".webmanifest") || p == "manifest.json" {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		static.ServeHTTP(w, r)
	})
}

func ours(port int) bool {
	c := http.Client{Timeout: 2 * time.Second}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/__ep/ping", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	b := make([]byte, 32)
	n, _ := res.Body.Read(b)
	return string(b[:n]) == "essence-protocol"
}

// open shows the game. With wait, it runs a Chromium-based browser as an app window with its own
// profile and returns true once that window closes; otherwise it asks the system to open the URL.
func open(url string, wait bool) bool {
	if bin := findBrowser(); bin != "" {
		profile := filepath.Join(dataDir(), "window")
		os.MkdirAll(profile, 0o755)
		cmd := exec.Command(bin, "--app="+url, "--user-data-dir="+profile, "--window-size=1180,860",
			"--no-first-run", "--no-default-browser-check", "--disable-features=Translate")
		if err := cmd.Start(); err == nil {
			if !wait {
				return true
			}
			start := time.Now()
			cmd.Wait()
			// A browser that handed the window to a process it already had exits at once; then the
			// heartbeats tell when the game is closed.
			return time.Since(start) > 8*time.Second
		}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("Open %s in a web browser to play.\n", url)
	}
	return false
}

func findBrowser() string {
	var list []string
	switch runtime.GOOS {
	case "windows":
		for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
			base := os.Getenv(env)
			if base == "" {
				continue
			}
			list = append(list,
				filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
				filepath.Join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
				filepath.Join(base, "Chromium", "Application", "chrome.exe"))
		}
	case "darwin":
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"} {
			list = append(list, "/Applications/"+app+".app/Contents/MacOS/"+app)
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"} {
			if p, err := exec.LookPath(name); err == nil {
				list = append(list, p)
			}
		}
	}
	for _, p := range list {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func dataDir() string {
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "EssenceProtocol")
	}
	return filepath.Join(os.TempDir(), "EssenceProtocol")
}

func lanIPs() []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			out = append(out, n.IP.String())
		}
	}
	return out
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "Essence Protocol:", err)
	os.Exit(1)
}
