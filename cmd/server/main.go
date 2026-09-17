package main

import (
	"broadcaster/internal/broadcast"
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
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
	key, secret := env("LIVEKIT_API_KEY", "devkey"), env("LIVEKIT_API_SECRET", "devsecret-local-only-change-me-123456")
	appURL := env("APP_URL", "http://localhost")
	if appURL != "http://localhost" && (key == "devkey" || len(secret) < 32) {
		log.Fatal("Set a unique LIVEKIT_API_KEY and LIVEKIT_API_SECRET (32+ chars) for non-local deployments")
	}
	media := &broadcast.LiveKit{URL: env("LIVEKIT_INTERNAL_URL", "http://localhost:7880"), Key: key, Secret: secret, Client: &http.Client{Timeout: 5 * time.Second}}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// Rooms are intentionally ephemeral. A dedicated LiveKit instance is expected.
	ready := false
	for i := 0; i < 30; i++ {
		if err := media.Cleanup(ctx); err == nil {
			ready = true
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
	if !ready {
		log.Fatal("LiveKit unavailable after 30 startup attempts")
	}
	api := broadcast.New(media, appURL, env("LIVEKIT_URL", "ws://localhost/livekit"), env("WEB_DIR", "web/dist"))
	api.TrustProxy = env("TRUST_PROXY", "false") == "true"
	go api.RunCleanup(ctx)
	server := &http.Server{Addr: env("LISTEN_ADDR", ":8080"), Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Broadcast listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
