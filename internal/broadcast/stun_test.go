package broadcast

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/stun/v3"
)

type stunPacketRead struct {
	data   []byte
	source *net.UDPAddr
	err    error
}

type fakeSTUNPacketConn struct {
	reads     chan stunPacketRead
	writes    chan []byte
	writeErrs chan error
	closed    chan struct{}
	closeOnce sync.Once
}

func newFakeSTUNPacketConn() *fakeSTUNPacketConn {
	return &fakeSTUNPacketConn{
		reads:     make(chan stunPacketRead, 4),
		writes:    make(chan []byte, 4),
		writeErrs: make(chan error, 4),
		closed:    make(chan struct{}),
	}
}

func (c *fakeSTUNPacketConn) ReadFromUDP(buffer []byte) (int, *net.UDPAddr, error) {
	select {
	case <-c.closed:
		return 0, nil, net.ErrClosed
	case result := <-c.reads:
		return copy(buffer, result.data), result.source, result.err
	}
}

func (c *fakeSTUNPacketConn) WriteToUDP(packet []byte, _ *net.UDPAddr) (int, error) {
	select {
	case err := <-c.writeErrs:
		if err != nil {
			return 0, err
		}
	default:
	}
	copyPacket := append([]byte(nil), packet...)
	c.writes <- copyPacket
	return len(packet), nil
}

func (c *fakeSTUNPacketConn) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 3478}
}

func (c *fakeSTUNPacketConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

type temporarySTUNError struct{ message string }

func (e temporarySTUNError) Error() string { return e.message }
func (temporarySTUNError) Timeout() bool   { return false }
func (temporarySTUNError) Temporary() bool { return true }

func mustSTUNURI(t *testing.T, raw string) *stun.URI {
	t.Helper()
	uri, err := stun.ParseURI(raw)
	if err != nil {
		t.Fatal(err)
	}
	return uri
}

func listenTestSTUN(t *testing.T) (*STUNServer, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	server, err := ListenSTUN(ctx, "127.0.0.1:0")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		_ = server.Close()
	})
	return server, cancel
}

func TestValidateSTUNURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want bool
	}{
		{name: "IPv4 hostname", raw: "stun:localhost:3478", want: true},
		{name: "IPv6 literal", raw: "stun:[::1]:3478", want: true},
		{name: "TURN", raw: "turn:localhost:3478"},
		{name: "secure STUN", raw: "stuns:localhost:5349"},
		{name: "missing host", raw: "stun::3478"},
		{name: "missing port", raw: "stun:localhost"},
		{name: "zero port", raw: "stun:localhost:0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidateSTUNURL(tt.raw) == nil; got != tt.want {
				t.Fatalf("ValidateSTUNURL(%q) success = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
}

func TestSTUNBindingReturnsObservedAddress(t *testing.T) {
	server, _ := listenTestSTUN(t)
	client, err := stun.DialURI(mustSTUNURI(t, "stun:"+server.Addr().String()), &stun.DialConfig{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	var response *stun.Message
	if err := client.Do(request, func(event stun.Event) {
		if event.Error != nil {
			t.Error(event.Error)
			return
		}
		response = event.Message
	}); err != nil {
		t.Fatal(err)
	}
	if response == nil {
		t.Fatal("missing response")
	}
	if response.Type != stun.BindingSuccess {
		t.Fatalf("response type = %v, want %v", response.Type, stun.BindingSuccess)
	}
	if response.TransactionID != request.TransactionID {
		t.Fatalf("transaction ID = %x, want %x", response.TransactionID, request.TransactionID)
	}
	if err := stun.Fingerprint.Check(response); err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	var mapped stun.XORMappedAddress
	if err := mapped.GetFrom(response); err != nil {
		t.Fatal(err)
	}
	if !mapped.IP.IsLoopback() || mapped.Port == 0 {
		t.Fatalf("mapped = %v", mapped)
	}
}

func TestSTUNRejectsOccupiedAddress(t *testing.T) {
	occupied, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	if server, err := ListenSTUN(context.Background(), occupied.LocalAddr().String()); err == nil {
		_ = server.Close()
		t.Fatal("ListenSTUN succeeded on an occupied address")
	}
}

func TestSTUNCancellationClosesListener(t *testing.T) {
	server, cancel := listenTestSTUN(t)
	addr := server.Addr().String()
	cancel()

	deadline := time.Now().Add(time.Second)
	for {
		listener, err := net.ListenPacket("udp", addr)
		if err == nil {
			_ = listener.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("listener %s remained open after cancellation: %v", addr, err)
		}
		time.Sleep(time.Millisecond)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("Close after cancellation = %v", err)
	}
}

func TestSTUNNonBindingPacketReceivesNoResponse(t *testing.T) {
	server, _ := listenTestSTUN(t)
	conn, err := net.DialUDP("udp", nil, server.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	request := stun.MustBuild(stun.TransactionID, stun.BindingSuccess)
	if _, err := conn.Write(request.Raw); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Read(make([]byte, 512)); err == nil {
		t.Fatal("non-Binding packet received a response")
	} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatalf("read error = %v, want timeout", err)
	}
}

func TestSTUNMalformedPacketDoesNotStopReadLoop(t *testing.T) {
	server, _ := listenTestSTUN(t)
	conn, err := net.DialUDP("udp", nil, server.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{0, 1, 2}); err != nil {
		t.Fatal(err)
	}
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if _, err := conn.Write(request.Raw); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 512)
	n, err := conn.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	response := new(stun.Message)
	response.Raw = append(response.Raw, buffer[:n]...)
	if err := response.Decode(); err != nil {
		t.Fatal(err)
	}
	if response.Type != stun.BindingSuccess || response.TransactionID != request.TransactionID {
		t.Fatalf("response = %v transaction %x", response.Type, response.TransactionID)
	}
}

func TestSTUNServeRetriesTransientReadError(t *testing.T) {
	conn := newFakeSTUNPacketConn()
	retries := make(chan time.Duration, 1)
	server := newSTUNServer(context.Background(), conn, func(_ context.Context, delay time.Duration) bool {
		retries <- delay
		return true
	})
	t.Cleanup(func() { _ = server.Close() })
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	source := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 5000}
	conn.reads <- stunPacketRead{err: temporarySTUNError{message: "temporary read failure"}}
	conn.reads <- stunPacketRead{data: request.Raw, source: source}
	select {
	case delay := <-retries:
		if delay <= 0 || delay > stunMaxRetryDelay {
			t.Fatalf("retry delay = %v", delay)
		}
	case <-time.After(time.Second):
		t.Fatal("transient read failure was not retried")
	}
	select {
	case response := <-conn.writes:
		message := new(stun.Message)
		message.Raw = response
		if err := message.Decode(); err != nil {
			t.Fatal(err)
		}
		if message.Type != stun.BindingSuccess || message.TransactionID != request.TransactionID {
			t.Fatalf("response = %v transaction %x", message.Type, message.TransactionID)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not recover from transient read failure")
	}
}

func TestSTUNServeContinuesAfterWriteError(t *testing.T) {
	conn := newFakeSTUNPacketConn()
	server := newSTUNServer(context.Background(), conn, func(context.Context, time.Duration) bool { return true })
	t.Cleanup(func() { _ = server.Close() })
	first := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	second := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	source := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 5000}
	conn.writeErrs <- errors.New("temporary write failure")
	conn.reads <- stunPacketRead{data: first.Raw, source: source}
	conn.reads <- stunPacketRead{data: second.Raw, source: source}
	select {
	case response := <-conn.writes:
		message := new(stun.Message)
		message.Raw = response
		if err := message.Decode(); err != nil {
			t.Fatal(err)
		}
		if message.TransactionID != second.TransactionID {
			t.Fatalf("transaction = %x, want second request %x", message.TransactionID, second.TransactionID)
		}
	case <-time.After(time.Second):
		t.Fatal("server stopped after one write failure")
	}
}

func TestSTUNServeExposesFatalReadError(t *testing.T) {
	conn := newFakeSTUNPacketConn()
	server := newSTUNServer(context.Background(), conn, func(context.Context, time.Duration) bool { return true })
	fatal := errors.New("fatal read failure")
	conn.reads <- stunPacketRead{err: fatal}
	select {
	case <-server.Done():
		if !errors.Is(server.Err(), fatal) {
			t.Fatalf("server error = %v, want %v", server.Err(), fatal)
		}
	case <-time.After(time.Second):
		t.Fatal("fatal read failure was not surfaced")
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSTUNTokenBucketRefillsAndCapsAtBurst(t *testing.T) {
	now := time.Unix(100, 0)
	bucket := newSTUNTokenBucket(func() time.Time { return now })
	for i := 0; i < stunBurst; i++ {
		if !bucket.allow() {
			t.Fatalf("request %d within initial burst was rejected", i+1)
		}
	}
	if bucket.allow() {
		t.Fatal("request beyond initial burst was accepted")
	}
	now = now.Add(5 * time.Millisecond)
	if bucket.allow() {
		t.Fatal("half a token was accepted")
	}
	now = now.Add(5 * time.Millisecond)
	if !bucket.allow() {
		t.Fatal("one token was not refilled after 10ms")
	}
	now = now.Add(time.Hour)
	for i := 0; i < stunBurst; i++ {
		if !bucket.allow() {
			t.Fatalf("request %d after refill was rejected", i+1)
		}
	}
	if bucket.allow() {
		t.Fatal("refill exceeded burst capacity")
	}
}

func TestSTUNRateLimitRemainsResponsive(t *testing.T) {
	server, _ := listenTestSTUN(t)
	conn, err := net.DialUDP("udp", nil, server.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	for i := 0; i < 1000; i++ {
		request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
		if _, err := conn.Write(request.Raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	responses := 0
	buffer := make([]byte, 512)
	for {
		if _, err := conn.Read(buffer); err != nil {
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				break
			}
			t.Fatal(err)
		}
		responses++
	}
	if responses == 0 || responses > 350 {
		t.Fatalf("responses under burst pressure = %d, want 1..350", responses)
	}
	time.Sleep(20 * time.Millisecond)
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if _, err := conn.Write(request.Raw); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	n, err := conn.Read(buffer)
	if err != nil {
		t.Fatal("server did not remain responsive after rate limiting:", err)
	}
	response := new(stun.Message)
	response.Raw = append(response.Raw, buffer[:n]...)
	if err := response.Decode(); err != nil {
		t.Fatal(err)
	}
	if response.TransactionID != request.TransactionID {
		t.Fatalf("transaction = %x, want %x", response.TransactionID, request.TransactionID)
	}
}
