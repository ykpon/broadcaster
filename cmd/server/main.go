package main

import (
	"broadcaster/internal/broadcast"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type config struct {
	appURL, mediaURL, webDir   string
	listenAddr, stunListenAddr string
	stunURL                    string
	liveKitKey, liveKitSecret  string
	trustProxy                 bool
	media                      broadcast.Media
	cleanup                    func(context.Context) error
	listenHTTP                 func(string, string) (net.Listener, error)
	listenSTUN                 func(context.Context, string) (*broadcast.STUNServer, error)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func isLocalAppURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func configFromEnv() config {
	key := env("LIVEKIT_API_KEY", "devkey")
	secret := env("LIVEKIT_API_SECRET", "devsecret-local-only-change-me-123456")
	media := &broadcast.LiveKit{
		URL:    env("LIVEKIT_INTERNAL_URL", "http://localhost:7880"),
		Key:    key,
		Secret: secret,
		Client: &http.Client{Timeout: 5 * time.Second},
	}
	return config{
		appURL:         env("APP_URL", "http://localhost:8080"),
		mediaURL:       env("LIVEKIT_URL", "ws://localhost:7880"),
		webDir:         env("WEB_DIR", "web/dist"),
		listenAddr:     env("LISTEN_ADDR", ":8080"),
		stunListenAddr: env("STUN_LISTEN_ADDR", ":3478"),
		stunURL:        env("STUN_URL", "stun:localhost:3478"),
		liveKitKey:     key,
		liveKitSecret:  secret,
		trustProxy:     env("TRUST_PROXY", "false") == "true",
		media:          media,
		cleanup:        media.Cleanup,
		listenHTTP:     net.Listen,
		listenSTUN:     broadcast.ListenSTUN,
	}
}

func run(ctx context.Context, cfg config) error {
	if err := broadcast.ValidateSTUNURL(cfg.stunURL); err != nil {
		return fmt.Errorf("invalid STUN_URL: %w", err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	stunServer, err := cfg.listenSTUN(runCtx, cfg.stunListenAddr)
	if err != nil {
		cancel()
		return err
	}
	defer func() {
		cancel()
		_ = stunServer.Close()
	}()

	// Rooms are intentionally ephemeral. A dedicated LiveKit instance is expected.
	if err := cfg.cleanup(runCtx); err != nil && runCtx.Err() == nil {
		log.Printf("LiveKit startup cleanup: %v", err)
	}
	if runCtx.Err() != nil {
		return nil
	}

	api := broadcast.New(cfg.media, cfg.appURL, cfg.mediaURL, cfg.webDir)
	api.STUNURL = cfg.stunURL
	api.TrustProxy = cfg.trustProxy
	listener, err := cfg.listenHTTP("tcp", cfg.listenAddr)
	if err != nil {
		return fmt.Errorf("listen for HTTP: %w", err)
	}
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		api.RunCleanup(runCtx)
	}()

	server := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveDone := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-runCtx.Done():
			shutdown, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer shutdownCancel()
			_ = server.Shutdown(shutdown)
		case <-serveDone:
		}
	}()
	log.Printf("Broadcast listening on %s; STUN listening on %s", listener.Addr(), stunServer.Addr())
	err = server.Serve(listener)
	close(serveDone)
	<-shutdownDone
	cancel()
	<-cleanupDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		resp, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil {
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	cfg := configFromEnv()
	if !isLocalAppURL(cfg.appURL) && (cfg.liveKitKey == "devkey" || len(cfg.liveKitSecret) < 32) {
		log.Fatal("Set a unique LIVEKIT_API_KEY and LIVEKIT_API_SECRET (32+ chars) for non-local deployments")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, cfg); err != nil {
		log.Fatal(err)
	}
}
