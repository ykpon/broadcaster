package broadcast

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/pion/stun/v3"
)

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

func TestSTUNPerIPBurstIsLimitedTo200(t *testing.T) {
	server, _ := listenTestSTUN(t)
	conn, err := net.DialUDP("udp", nil, server.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	for i := 0; i < 201; i++ {
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
	if responses != 200 {
		t.Fatalf("responses = %d, want 200", responses)
	}
}
