package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"broadcaster/internal/broadcast"
)

type startupMedia struct{}

func (startupMedia) Create(context.Context, string) error { return nil }
func (startupMedia) Delete(context.Context, string) error { return nil }
func (startupMedia) Participants(context.Context, string) ([]broadcast.Participant, error) {
	return nil, nil
}
func (startupMedia) Token(string, string, bool) string { return "token" }

func TestIsLocalAppURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"http://localhost", true},
		{"http://localhost:8080", true},
		{"http://127.0.0.1:8080", true},
		{"http://[::1]:8080", true},
		{"https://stream.example.com", false},
		{"not-a-url", false},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			if got := isLocalAppURL(tt.url); got != tt.want {
				t.Fatalf("isLocalAppURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

func testConfig() config {
	return config{
		appURL:         "http://localhost",
		mediaURL:       "ws://localhost:7880",
		webDir:         tTempWebDir,
		listenAddr:     "127.0.0.1:0",
		stunListenAddr: "127.0.0.1:0",
		stunURL:        "stun:localhost:3478",
		media:          startupMedia{},
		cleanup:        func(context.Context) error { return nil },
		listenHTTP:     net.Listen,
		listenSTUN:     broadcast.ListenSTUN,
	}
}

const tTempWebDir = "testdata-does-not-need-to-exist"

func TestConfigFromEnvUsesSTUNDefaults(t *testing.T) {
	t.Setenv("STUN_LISTEN_ADDR", "")
	t.Setenv("STUN_URL", "")
	cfg := configFromEnv()
	if cfg.stunListenAddr != ":3478" {
		t.Fatalf("STUN listen address = %q, want %q", cfg.stunListenAddr, ":3478")
	}
	if cfg.stunURL != "stun:localhost:3478" {
		t.Fatalf("STUN URL = %q, want %q", cfg.stunURL, "stun:localhost:3478")
	}
}

func TestRunStartsHTTPWhenLiveKitCleanupFails(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.cleanup = func(context.Context) error { return errors.New("LiveKit unavailable") }
	cfg.listenHTTP = func(string, string) (net.Listener, error) { return listener, nil }

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- run(ctx, cfg) }()
	waitForHealth(t, listener.Addr().String())
	cancel()
	if err := <-result; err != nil {
		t.Fatalf("run = %v", err)
	}
}

func TestRunRejectsInvalidSTUNURLBeforeListening(t *testing.T) {
	cfg := testConfig()
	cfg.stunURL = "turn:localhost:3478"
	stunStarted, httpStarted := false, false
	cfg.listenSTUN = func(context.Context, string) (*broadcast.STUNServer, error) {
		stunStarted = true
		return nil, errors.New("unexpected STUN listen")
	}
	cfg.listenHTTP = func(string, string) (net.Listener, error) {
		httpStarted = true
		return nil, errors.New("unexpected HTTP listen")
	}
	if err := run(context.Background(), cfg); err == nil {
		t.Fatal("run succeeded with an invalid STUN URL")
	}
	if stunStarted || httpStarted {
		t.Fatalf("listeners started: STUN=%v HTTP=%v", stunStarted, httpStarted)
	}
}

func TestRunRejectsOccupiedSTUNAddressBeforeHTTP(t *testing.T) {
	occupied, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	cfg := testConfig()
	cfg.stunListenAddr = occupied.LocalAddr().String()
	httpStarted := false
	cfg.listenHTTP = func(string, string) (net.Listener, error) {
		httpStarted = true
		return nil, errors.New("unexpected HTTP listen")
	}
	if err := run(context.Background(), cfg); err == nil {
		t.Fatal("run succeeded with an occupied STUN address")
	}
	if httpStarted {
		t.Fatal("HTTP listener started after STUN listen failed")
	}
}

func TestRunCancellationClosesHTTPAndSTUNListeners(t *testing.T) {
	cfg := testConfig()
	httpAddr := make(chan string, 1)
	stunAddr := make(chan string, 1)
	cfg.listenHTTP = func(network, address string) (net.Listener, error) {
		listener, err := net.Listen(network, address)
		if err == nil {
			httpAddr <- listener.Addr().String()
		}
		return listener, err
	}
	cfg.listenSTUN = func(ctx context.Context, address string) (*broadcast.STUNServer, error) {
		server, err := broadcast.ListenSTUN(ctx, address)
		if err == nil {
			stunAddr <- server.Addr().String()
		}
		return server, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- run(ctx, cfg) }()
	udpAddress := <-stunAddr
	tcpAddress := <-httpAddr
	waitForHealth(t, tcpAddress)
	cancel()
	if err := <-result; err != nil {
		t.Fatalf("run = %v", err)
	}

	udpListener, err := net.ListenPacket("udp", udpAddress)
	if err != nil {
		t.Fatalf("STUN listener remained open: %v", err)
	}
	_ = udpListener.Close()
	tcpListener, err := net.Listen("tcp", tcpAddress)
	if err != nil {
		t.Fatalf("HTTP listener remained open: %v", err)
	}
	_ = tcpListener.Close()
}

func waitForHealth(t *testing.T, address string) {
	t.Helper()
	client := &http.Client{
		Timeout:   100 * time.Millisecond,
		Transport: &http.Transport{DisableKeepAlives: true},
	}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(2 * time.Second)
	for {
		response, err := client.Get("http://" + address + "/healthz")
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("HTTP listener %s did not become healthy: %v", address, err)
		}
		time.Sleep(time.Millisecond)
	}
}
