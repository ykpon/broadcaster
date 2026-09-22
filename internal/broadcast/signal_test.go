package broadcast

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestSignalTicketIsSingleUseBoundAndExpires(t *testing.T) {
	s, _, id, _ := createTest(t)
	now := time.Unix(100, 0)
	s.now = func() time.Time { return now }
	ticket := s.issueTicket(id, signalAuth{Role: "viewer", Session: "viewer-a"})
	if _, ok := s.consumeTicket("other-room", ticket); ok {
		t.Fatal("wrong room accepted")
	}
	got, ok := s.consumeTicket(id, ticket)
	if !ok || got.Session != "viewer-a" {
		t.Fatal(got, ok)
	}
	if _, ok := s.consumeTicket(id, ticket); ok {
		t.Fatal("ticket reused")
	}
	expired := s.issueTicket(id, signalAuth{Role: "viewer", Session: "viewer-b"})
	now = now.Add(60 * time.Second)
	if _, ok := s.consumeTicket(id, expired); ok {
		t.Fatal("expired ticket accepted")
	}
}

func signalServer(t *testing.T, s *Server) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func dialSignal(t *testing.T, ts *httptest.Server, id string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/api/rooms/"+id+"/signal", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func sendSignal(t *testing.T, c *websocket.Conn, message clientSignal) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, message); err != nil {
		t.Fatal(err)
	}
}

func readSignal(t *testing.T, c *websocket.Conn, kind string) serverSignal {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var message serverSignal
	if err := wsjson.Read(ctx, c, &message); err != nil {
		t.Fatal(kind, err)
	}
	if message.Type != kind {
		t.Fatalf("want %s, got %+v", kind, message)
	}
	return message
}

func authSignal(t *testing.T, ts *httptest.Server, id, ticket string) *websocket.Conn {
	t.Helper()
	c := dialSignal(t, ts, id)
	sendSignal(t, c, clientSignal{Type: "authenticate", Ticket: ticket})
	readSignal(t, c, "authenticated")
	return c
}

func joinSignal(t *testing.T, s *Server, ts *httptest.Server, id string) (*websocket.Conn, string) {
	t.Helper()
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/join", `{}`)
	if code != 200 {
		t.Fatal(code, body)
	}
	return authSignal(t, ts, id, body["ticket"].(string)), body["session"].(string)
}

func startSignal(t *testing.T, s *Server, ts *httptest.Server, id, secret string, transport Transport) (*websocket.Conn, uint64) {
	t.Helper()
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"`+string(transport)+`","viewerLimit":"10"}`)
	if code != 200 {
		t.Fatal(code, body)
	}
	return authSignal(t, ts, id, body["ticket"].(string)), uint64(body["generation"].(float64))
}

func expectPolicy(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatal("expected policy close", err)
	}
}

func TestWebSocketRequiresFirstMessageTicketAndSameOrigin(t *testing.T) {
	s, _, id, _ := createTest(t)
	ts := signalServer(t, s)
	c := dialSignal(t, ts, id)
	sendSignal(t, c, clientSignal{Type: "offer", SDP: "bad"})
	expectPolicy(t, c)
	c = dialSignal(t, ts, id)
	sendSignal(t, c, clientSignal{Type: "authenticate", Ticket: "bad"})
	expectPolicy(t, c)
	_, resp, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/api/rooms/"+id+"/signal", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}}})
	if err == nil || resp.StatusCode != 403 {
		t.Fatal(resp, err)
	}
}

func TestSignalRoutingAndGenerationIsolation(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	v, viewerID := joinSignal(t, s, ts, id)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	sendSignal(t, v, clientSignal{Type: "peer-ready", Generation: gen})
	if got := readSignal(t, h, "peer-ready"); got.Viewer != viewerID {
		t.Fatal(got)
	}
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen - 1, Viewer: viewerID, SDP: "stale"})
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: viewerID, SDP: "offer-sdp"})
	if got := readSignal(t, v, "offer"); got.Generation != 1 || got.SDP != "offer-sdp" {
		t.Fatal(got)
	}
	sendSignal(t, v, clientSignal{Type: "answer", Generation: gen, SDP: "answer-sdp"})
	if got := readSignal(t, h, "answer"); got.Viewer != viewerID || got.SDP != "answer-sdp" {
		t.Fatal(got)
	}
	sendSignal(t, v, clientSignal{Type: "ice-candidate", Generation: gen, Candidate: &ICECandidate{Candidate: "candidate"}})
	if got := readSignal(t, h, "ice-candidate"); got.Viewer != viewerID || got.Candidate.Candidate != "candidate" {
		t.Fatal(got)
	}
	sendSignal(t, h, clientSignal{Type: "broadcast-ready", Generation: gen - 1})
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: viewerID, SDP: "barrier"})
	readSignal(t, v, "offer")
	_, info := call(t, s.Handler(), "GET", "/api/rooms/"+id, "")
	if info["state"] != "waiting" {
		t.Fatal("stale readiness changed state", info)
	}
	sendSignal(t, h, clientSignal{Type: "broadcast-ready", Generation: gen})
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: viewerID, SDP: "barrier"})
	readSignal(t, v, "offer")
	_, info = call(t, s.Handler(), "GET", "/api/rooms/"+id, "")
	if info["state"] != "live" {
		t.Fatal(info)
	}
}

func TestSignalRejectsViewerOfferAndOtherViewerTarget(t *testing.T) {
	for _, kind := range []string{"offer", "answer", "broadcast-ready"} {
		t.Run(kind, func(t *testing.T) {
			s, _, id, secret := createTest(t)
			ts := signalServer(t, s)
			v, _ := joinSignal(t, s, ts, id)
			_, gen := startSignal(t, s, ts, id, secret, TransportP2P)
			readSignal(t, v, "broadcast-started")
			sendSignal(t, v, clientSignal{Type: kind, Generation: gen, Viewer: "someone-else", SDP: "bad"})
			expectPolicy(t, v)
		})
	}
}

func TestSignalRoomsDoNotShareEventsOrTargets(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	_, second := call(t, s.Handler(), "POST", "/api/rooms", "")
	id2 := second["roomId"].(string)
	secret2 := strings.Split(second["hostUrl"].(string), "#key=")[1]
	v1, _ := joinSignal(t, s, ts, id)
	v2, session2 := joinSignal(t, s, ts, id2)
	h1, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v1, "broadcast-started")
	sendSignal(t, h1, clientSignal{Type: "offer", Generation: gen, Viewer: session2, SDP: "cross-room"})
	h2, gen2 := startSignal(t, s, ts, id2, secret2, TransportP2P)
	readSignal(t, v2, "broadcast-started")
	sendSignal(t, h2, clientSignal{Type: "offer", Generation: gen2, Viewer: session2, SDP: "own-room"})
	if got := readSignal(t, v2, "offer"); got.SDP != "own-room" {
		t.Fatal(got)
	}
}

func TestSignalLifecycleWaitingViewersAndPersonalTokens(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	v1, session1 := joinSignal(t, s, ts, id)
	v2, session2 := joinSignal(t, s, ts, id)
	_, _ = startSignal(t, s, ts, id, secret, TransportServer)
	for _, entry := range []struct {
		c       *websocket.Conn
		session string
	}{{v1, session1}, {v2, session2}} {
		got := readSignal(t, entry.c, "broadcast-started")
		if got.LiveKit == nil || got.Transport != TransportServer || got.ViewerLimit != "10" {
			t.Fatal(got)
		}
		payload, err := base64.RawURLEncoding.DecodeString(strings.Split(got.LiveKit.Token, ".")[1])
		if err != nil {
			t.Fatal(err)
		}
		var claims map[string]any
		if err := json.Unmarshal(payload, &claims); err != nil {
			t.Fatal(err)
		}
		if claims["sub"] != entry.session || claims["video"].(map[string]any)["canPublish"] != false {
			t.Fatal(claims)
		}
	}
	path := "/api/rooms/" + id
	if code, _ := call(t, s.Handler(), "POST", path+"/stop", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
		t.Fatal(code)
	}
	readSignal(t, v1, "broadcast-stopped")
	readSignal(t, v2, "broadcast-stopped")
	_, _ = startSignal(t, s, ts, id, secret, TransportP2P)
	if got := readSignal(t, v1, "broadcast-started"); got.Generation != 2 {
		t.Fatal(got)
	}
	readSignal(t, v2, "broadcast-started")
	if code, _ := call(t, s.Handler(), "POST", path+"/end", `{"hostSecret":"`+secret+`"}`); code != 200 {
		t.Fatal(code)
	}
	readSignal(t, v1, "room-ended")
	readSignal(t, v2, "room-ended")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := v1.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatal(err)
	}
}

func TestSignalCandidateLimit(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	v, _ := joinSignal(t, s, ts, id)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	for range 256 {
		sendSignal(t, v, clientSignal{Type: "ice-candidate", Generation: gen, Candidate: &ICECandidate{Candidate: "candidate"}})
		readSignal(t, h, "ice-candidate")
	}
	sendSignal(t, v, clientSignal{Type: "ice-candidate", Generation: gen, Candidate: &ICECandidate{Candidate: "candidate"}})
	expectPolicy(t, v)
}

// A controllable scheduler executes the actual generation/peer guards without
// making reconnect tests sleep for twenty seconds.
type testSignalTimer struct {
	mu      sync.Mutex
	stopped bool
	fire    func()
}

func (timer *testSignalTimer) Stop() bool {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	previous := timer.stopped
	timer.stopped = true
	return !previous
}

func TestSignalHostReconnectGraceAndViewerReservation(t *testing.T) {
	s, _, id, secret := createTest(t)
	timers := make(chan *testSignalTimer, 4)
	s.afterFunc = func(d time.Duration, f func()) signalTimer {
		if d != 20*time.Second {
			t.Errorf("grace = %v", d)
		}
		timer := &testSignalTimer{fire: f}
		timers <- timer
		return timer
	}
	ts := signalServer(t, s)
	v, session := joinSignal(t, s, ts, id)
	h, _ := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	sendSignal(t, v, clientSignal{Type: "peer-ready", Generation: 1})
	readSignal(t, h, "peer-ready")
	_ = h.CloseNow()
	var timer *testSignalTimer
	select {
	case timer = <-timers:
	case <-time.After(time.Second):
		t.Fatal("no grace timer")
	}
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/signal-ticket", `{"hostSecret":"`+secret+`","generation":1}`)
	if code != 200 {
		t.Fatal(code, body)
	}
	h = authSignal(t, ts, id, body["ticket"].(string))
	if got := readSignal(t, h, "peer-ready"); got.Viewer != session {
		t.Fatal(got)
	}
	timer.fire() // An already queued callback must also be harmless after reconnect.
	sendSignal(t, h, clientSignal{Type: "offer", Generation: 1, Viewer: session, SDP: "reconnected"})
	readSignal(t, v, "offer")
	_ = h.CloseNow()
	select {
	case timer = <-timers:
	case <-time.After(time.Second):
		t.Fatal("no second grace timer")
	}
	timer.fire()
	readSignal(t, v, "broadcast-stopped")
	_, info := call(t, s.Handler(), "GET", "/api/rooms/"+id, "")
	if info["state"] != "waiting" || info["generation"] != float64(1) {
		t.Fatal(info)
	}
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	timer.fire() // An old-generation expiry cannot stop the new generation.
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: session, SDP: "new-generation"})
	readSignal(t, v, "offer")
	_ = v.CloseNow()
	if got := readSignal(t, h, "peer-left"); got.Viewer != session || got.Generation != gen {
		t.Fatal(got)
	}
	s.mu.Lock()
	expiry := s.rooms[id].Seats[session]
	s.mu.Unlock()
	if remaining := time.Until(expiry); remaining < 85*time.Second || remaining > 90*time.Second {
		t.Fatal(remaining)
	}
}

func TestSignalControlPeersPreventExpiry(t *testing.T) {
	s, _, id, _ := createTest(t)
	ts := signalServer(t, s)
	_, session := joinSignal(t, s, ts, id)
	s.mu.Lock()
	room := s.rooms[id]
	if err := s.syncRoom(context.Background(), room, time.Now().Add(2*time.Hour)); err != nil {
		t.Error(err)
	}
	_, reserved := room.Seats[session]
	state := room.State
	s.mu.Unlock()
	if state == "ended" || !reserved {
		t.Fatal(state, reserved)
	}
}

func TestSignalHostCandidateLimitIncludesMissingTargets(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	for range 257 {
		sendSignal(t, h, clientSignal{Type: "ice-candidate", Generation: gen, Viewer: "departed-viewer", Candidate: &ICECandidate{Candidate: "candidate"}})
	}
	expectPolicy(t, h)
}

func TestSignalEmptyP2PGenerationExpiresWithoutControlPeers(t *testing.T) {
	s, _, id, secret := createTest(t)
	code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"10"}`)
	if code != 200 {
		t.Fatal(code)
	}
	room := s.rooms[id]
	if err := s.syncRoom(context.Background(), room, room.Created.Add(time.Hour+time.Second)); err != nil {
		t.Fatal(err)
	}
	if room.State != "ended" {
		t.Fatal("empty generation survived one hour", room.State)
	}
}

func TestSignalRollingMessageLimit(t *testing.T) {
	s, _, id, secret := createTest(t)
	var elapsed atomic.Int64
	base := time.Now()
	s.now = func() time.Time { return base.Add(time.Duration(elapsed.Load()) * time.Second) }
	ts := signalServer(t, s)
	v, session := joinSignal(t, s, ts, id)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	sendOffers := func(n int) {
		for range n {
			sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: session, SDP: "offer"})
			readSignal(t, v, "offer")
		}
	}
	sendOffers(300)
	elapsed.Store(59)
	sendOffers(200)
	elapsed.Store(61)
	sendOffers(312) // The 200 messages at second 59 still count in this minute.
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: session, SDP: "over-limit"})
	expectPolicy(t, h)
}

func TestSignalTicketGenerationBindingAndViewerSurvivesSwitch(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	path := "/api/rooms/" + id
	_, viewer := call(t, s.Handler(), "POST", path+"/join", `{}`)
	_, started := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"10"}`)
	call(t, s.Handler(), "POST", path+"/stop", `{"hostSecret":"`+secret+`","generation":1}`)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	stale := dialSignal(t, ts, id)
	sendSignal(t, stale, clientSignal{Type: "authenticate", Ticket: started["ticket"].(string)})
	expectPolicy(t, stale)
	v := authSignal(t, ts, id, viewer["ticket"].(string))
	if got := readSignal(t, v, "broadcast-started"); got.Generation != 2 {
		t.Fatal(got)
	}
	sendSignal(t, v, clientSignal{Type: "answer", Generation: 1, SDP: "stale"})
	sendSignal(t, v, clientSignal{Type: "answer", Generation: gen, SDP: "current"})
	if got := readSignal(t, h, "answer"); got.SDP != "current" {
		t.Fatal(got)
	}
}

func TestSignalReadLimit(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	v, session := joinSignal(t, s, ts, id)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	sendSignal(t, h, clientSignal{Type: "offer", Generation: gen, Viewer: session, SDP: strings.Repeat("x", 256<<10)})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := h.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatal(err)
	}
}

func TestSignalServerReadinessRequiresControlHost(t *testing.T) {
	s, media, id, secret := createTest(t)
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	if err := json.Unmarshal([]byte(`[{"identity":"host","tracks":[{"source":"SCREEN_SHARE"}]}]`), &media.participants); err != nil {
		t.Fatal(err)
	}
	room := s.rooms[id]
	if err := s.syncRoom(context.Background(), room, time.Now()); err != nil {
		t.Fatal(err)
	}
	if room.State != "waiting" {
		t.Fatal("media polling bypassed control readiness", room.State)
	}
}

func TestSignalServerHostGraceDeletesMediaAndStopsOnce(t *testing.T) {
	s, media, id, secret := createTest(t)
	timers := make(chan *testSignalTimer, 1)
	s.afterFunc = func(_ time.Duration, f func()) signalTimer {
		timer := &testSignalTimer{fire: f}
		timers <- timer
		return timer
	}
	ts := signalServer(t, s)
	v, _ := joinSignal(t, s, ts, id)
	h, _ := startSignal(t, s, ts, id, secret, TransportServer)
	readSignal(t, v, "broadcast-started")
	_ = h.CloseNow()
	var timer *testSignalTimer
	select {
	case timer = <-timers:
	case <-time.After(time.Second):
		t.Fatal("no host grace timer")
	}
	timer.fire()
	readSignal(t, v, "broadcast-stopped")
	timer.fire()
	if len(media.deleted) != 1 || media.deleted[0] != "broadcast-"+id+"-1" {
		t.Fatal(media.deleted)
	}
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/stop", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
		t.Fatal(code)
	}
	_, _ = startSignal(t, s, ts, id, secret, TransportP2P)
	if got := readSignal(t, v, "broadcast-started"); got.Generation != 2 {
		t.Fatal(got)
	}
}

func TestSignalCandidateBudgetResetsOnNewGeneration(t *testing.T) {
	s, _, id, secret := createTest(t)
	ts := signalServer(t, s)
	v, _ := joinSignal(t, s, ts, id)
	h, gen := startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	for range 256 {
		sendSignal(t, v, clientSignal{Type: "ice-candidate", Generation: gen, Candidate: &ICECandidate{Candidate: "candidate"}})
		readSignal(t, h, "ice-candidate")
	}
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/stop", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
		t.Fatal(code)
	}
	readSignal(t, v, "broadcast-stopped")
	h, gen = startSignal(t, s, ts, id, secret, TransportP2P)
	readSignal(t, v, "broadcast-started")
	sendSignal(t, v, clientSignal{Type: "ice-candidate", Generation: gen, Candidate: &ICECandidate{Candidate: "new-candidate"}})
	if got := readSignal(t, h, "ice-candidate"); got.Candidate.Candidate != "new-candidate" || got.Generation != 2 {
		t.Fatal(got)
	}
}

func TestJoinUsesConfiguredLimitAndResumesSession(t *testing.T) {
	s, _, id, secret := createTest(t)
	path := "/api/rooms/" + id
	session := ""
	for range 10 {
		code, body := call(t, s.Handler(), "POST", path+"/join", `{}`)
		if code != 200 {
			t.Fatal(code, body)
		}
		session = body["session"].(string)
		if body["ticket"] == "" {
			t.Fatal("no ticket")
		}
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/join", `{}`); code != 409 {
		t.Fatal(code)
	}
	if code, body := call(t, s.Handler(), "POST", path+"/join", `{"session":"`+session+`"}`); code != 200 || body["session"] != session {
		t.Fatal(code, body)
	}
	if code, body := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"999999999999999999999"}`); code != 200 || body["ticket"] == "" {
		t.Fatal(code, body)
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/join", `{}`); code != 200 {
		t.Fatal(code)
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/signal-ticket", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
		t.Fatal(code)
	}
	if s.rooms[id].Generation != 1 {
		t.Fatal("ticket restarted generation")
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/signal-ticket", `{"hostSecret":"`+secret+`","generation":0}`); code != 409 {
		t.Fatal(code)
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/signal-ticket", `{"session":"bad"}`); code != 403 {
		t.Fatal(code)
	}
}
