package broadcast

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeMedia struct {
	participants    []Participant
	participantsFn  func(context.Context, string) ([]Participant, error)
	participantsErr error
	created         []string
	deleted         []string
	createErr       error
}

func (f *fakeMedia) Create(_ context.Context, room string) error {
	f.created = append(f.created, room)
	return f.createErr
}
func (f *fakeMedia) Delete(_ context.Context, room string) error {
	f.deleted = append(f.deleted, room)
	return nil
}
func (f *fakeMedia) Participants(ctx context.Context, room string) ([]Participant, error) {
	if f.participantsFn != nil {
		return f.participantsFn(ctx, room)
	}
	if f.participantsErr != nil {
		return nil, f.participantsErr
	}
	return f.participants, nil
}
func (f *fakeMedia) Token(room, id string, host bool) string {
	return (&LiveKit{Key: "test", Secret: "secret"}).Token(room, id, host)
}
func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	h.ServeHTTP(w, r)
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(w.Body.String())
	}
	return w.Code, result
}
func createTest(t *testing.T) (*Server, *fakeMedia, string, string) {
	t.Helper()
	m := &fakeMedia{}
	s := New(m, "http://localhost", "ws://localhost/livekit", "")
	code, b := call(t, s.Handler(), "POST", "/api/rooms", "")
	if code != 201 {
		t.Fatal(code, b)
	}
	return s, m, b["roomId"].(string), strings.Split(b["hostUrl"].(string), "#key=")[1]
}
func TestRoomPermissionsAndEnd(t *testing.T) {
	s, m, id, secret := createTest(t)
	h := s.Handler()
	path := "/api/rooms/" + id
	if c, _ := call(t, h, "POST", path+"/start", `{"hostSecret":"bad","transport":"server","viewerLimit":"10"}`); c != 403 {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); c != 200 {
		t.Fatal(c)
	}
	_, info := call(t, h, "GET", path, "")
	if len(info) != 6 || info["generation"] != float64(1) || info["transport"] != "server" || info["viewerLimit"] != "10" {
		t.Fatal("public endpoint leaked fields", info)
	}
	if c, _ := call(t, h, "POST", path+"/end", `{"hostSecret":"`+secret+`"}`); c != 200 || len(m.deleted) != 1 {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/join", `{}`); c != 410 {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); c != 410 {
		t.Fatal(c)
	}
}

func TestCreateRoomDoesNotRequireLiveKitAndDefaultsToTen(t *testing.T) {
	s, media, id, _ := createTest(t)
	if media.created != nil {
		t.Fatalf("created LiveKit eagerly: %v", media.created)
	}
	_, info := call(t, s.Handler(), "GET", "/api/rooms/"+id, "")
	if info["viewerLimit"] != "10" || info["generation"] != float64(0) {
		t.Fatal(info)
	}
}

func TestViewerTokenRouteGoneAndJoinDoesNotCreateMedia(t *testing.T) {
	s, media, id, _ := createTest(t)
	path := "/api/rooms/" + id
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("POST", path+"/viewer-token", strings.NewReader(`{}`)))
	if w.Code != 405 {
		t.Fatalf("viewer-token returned %d, want 405", w.Code)
	}
	code, joined := call(t, s.Handler(), "POST", path+"/join", `{}`)
	if code != 200 || joined["session"] == "" || joined["ticket"] == "" || len(media.created) != 0 {
		t.Fatal(code, joined, media.created)
	}
}

func TestHostTokenRouteIsGone(t *testing.T) {
	s, media, id, secret := createTest(t)
	path := "/api/rooms/" + id
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("POST", path+"/host-token", strings.NewReader(`{"hostSecret":"`+secret+`"}`)))
	if w.Code != 405 {
		t.Fatalf("host-token returned %d, want 405", w.Code)
	}
	if len(media.created) != 0 {
		t.Fatalf("host-token created media room: %v", media.created)
	}
}

func TestP2PStartNeverCallsLiveKit(t *testing.T) {
	s, media, id, secret := createTest(t)
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start",
		`{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"999999999999999999999"}`)
	if code != 200 || body["generation"] != float64(1) || len(media.created) != 0 {
		t.Fatal(code, body, media.created)
	}
}

func TestP2PStartIncludesConfiguredSTUNURL(t *testing.T) {
	s, _, id, secret := createTest(t)
	s.STUNURL = "stun:ice.example:3478"
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start",
		`{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"10"}`)
	iceServers, ok := body["iceServers"].([]any)
	matchesSTUNURL := false
	if ok && len(iceServers) == 1 {
		if server, ok := iceServers[0].(map[string]any); ok {
			if urls, ok := server["urls"].([]any); ok && len(urls) == 1 {
				matchesSTUNURL = urls[0] == s.STUNURL
			}
		}
	}
	if code != 200 || !matchesSTUNURL {
		t.Fatal(code, body)
	}
}

func TestServerStartIsTransactional(t *testing.T) {
	s, media, id, secret := createTest(t)
	media.createErr = errors.New("offline")
	code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start",
		`{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`)
	if code != 503 || s.rooms[id].Generation != 0 || s.rooms[id].Transport != "" {
		t.Fatal(code, s.rooms[id])
	}
}

func TestActiveStartDoesNotReplaceGenerationOrMedia(t *testing.T) {
	for _, initial := range []Transport{TransportServer, TransportP2P} {
		t.Run(string(initial), func(t *testing.T) {
			s, media, id, secret := createTest(t)
			path := "/api/rooms/" + id
			if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"`+string(initial)+`","viewerLimit":"10"}`); code != 200 {
				t.Fatal(code)
			}
			room := s.rooms[id]
			generation, transport, limit, mediaRoom := room.Generation, room.Transport, room.ViewerLimit.String(), room.MediaRoom
			created, deleted := len(media.created), len(media.deleted)
			restartTransport := TransportP2P
			if initial == TransportP2P {
				restartTransport = TransportServer
			}
			if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"`+string(restartTransport)+`","viewerLimit":"999"}`); code != 409 {
				t.Fatal(code)
			}
			if room.Generation != generation || room.Transport != transport || room.ViewerLimit.String() != limit || room.MediaRoom != mediaRoom || len(media.created) != created || len(media.deleted) != deleted {
				t.Fatalf("active start changed room=%+v created=%v deleted=%v", room, media.created, media.deleted)
			}
		})
	}
}

func TestStopRejectsStaleGeneration(t *testing.T) {
	s, _, id, secret := createTest(t)
	path := "/api/rooms/" + id
	if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/stop", `{"hostSecret":"`+secret+`","generation":0}`); code != 409 {
		t.Fatal(code)
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/stop", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
		t.Fatal(code)
	}
}

func TestStopResetsEmptySinceForOneHourExpiry(t *testing.T) {
	for _, transport := range []Transport{TransportServer, TransportP2P} {
		t.Run(string(transport), func(t *testing.T) {
			s, _, id, secret := createTest(t)
			path := "/api/rooms/" + id
			if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"`+string(transport)+`","viewerLimit":"10"}`); code != 200 {
				t.Fatal(code)
			}
			room := s.rooms[id]
			stale := time.Now().Add(-2 * time.Hour)
			room.EmptySince = stale
			if code, _ := call(t, s.Handler(), "POST", path+"/stop", `{"hostSecret":"`+secret+`","generation":1}`); code != 200 {
				t.Fatal(code)
			}
			if !room.EmptySince.After(stale) {
				t.Fatalf("stop retained stale empty time %v", room.EmptySince)
			}
			if err := s.syncRoom(context.Background(), room, room.EmptySince.Add(59*time.Minute)); err != nil || room.State == "ended" {
				t.Fatal(err, room.State)
			}
			if err := s.syncRoom(context.Background(), room, room.EmptySince.Add(time.Hour+time.Second)); err != nil || room.State != "ended" {
				t.Fatal(err, room.State)
			}
		})
	}
}

func TestServerStartUsesGenerationInMediaRoomName(t *testing.T) {
	s, media, id, secret := createTest(t)
	path := "/api/rooms/" + id
	if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	if want := "broadcast-" + id + "-1"; len(media.created) != 1 || media.created[0] != want {
		t.Fatalf("created = %v, want %q", media.created, want)
	}
}

func TestStartRejectsLimitBelowReservedSessions(t *testing.T) {
	s, _, id, secret := createTest(t)
	path := "/api/rooms/" + id
	for range 2 {
		if code, _ := call(t, s.Handler(), "POST", path+"/join", `{}`); code != 200 {
			t.Fatal(code)
		}
	}
	if code, _ := call(t, s.Handler(), "POST", path+"/start", `{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"1"}`); code != 409 {
		t.Fatal(code)
	}
}

func TestEndDeletesOnlyExistingMediaRoom(t *testing.T) {
	s, media, id, secret := createTest(t)
	path := "/api/rooms/" + id
	if code, _ := call(t, s.Handler(), "POST", path+"/end", `{"hostSecret":"`+secret+`"}`); code != 200 || len(media.deleted) != 0 {
		t.Fatal(code, media.deleted)
	}
}

func TestTenViewerReservationsAndReconnect(t *testing.T) {
	s, _, id, _ := createTest(t)
	h := s.Handler()
	path := "/api/rooms/" + id + "/join"
	session := ""
	for i := 0; i < 10; i++ {
		c, b := call(t, h, "POST", path, `{}`)
		if c != 200 {
			t.Fatal(c, b)
		}
		session = b["session"].(string)
	}
	if c, _ := call(t, h, "POST", path, `{}`); c != 409 {
		t.Fatal(c)
	}
	if c, b := call(t, h, "POST", path, `{"session":"`+session+`"}`); c != 200 || b["session"] != session {
		t.Fatal(c, b)
	}
	s.rooms[id].Seats[session] = time.Now().Add(-time.Second)
	if c, _ := call(t, h, "POST", path, `{}`); c != 200 {
		t.Fatal(c)
	}
}
func TestJWTSignatureAndLeastPrivilege(t *testing.T) {
	l := &LiveKit{Key: "key", Secret: "secret"}
	for _, host := range []bool{false, true} {
		token := l.Token("room", "person", host)
		parts := strings.Split(token, ".")
		mac := hmac.New(sha256.New, []byte("secret"))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		if !hmac.Equal(sig, mac.Sum(nil)) {
			t.Fatal("bad signature")
		}
		b, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims map[string]any
		_ = json.Unmarshal(b, &claims)
		v := claims["video"].(map[string]any)
		if v["room"] != "room" || v["canPublish"] != host || v["canSubscribe"] == host || v["canPublishData"] != false || v["roomAdmin"] != nil {
			t.Fatal(v)
		}
		if host && len(v["canPublishSources"].([]any)) != 2 {
			t.Fatal(v)
		}
		if claims["exp"].(float64)-float64(time.Now().Unix()) > 60 {
			t.Fatal("long lived token")
		}
	}
}
func TestEmptyRoomExpiresAfterOneHour(t *testing.T) {
	s, m, id, secret := createTest(t)
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	room := s.rooms[id]
	now := room.Created
	_ = s.syncRoom(context.Background(), room, now.Add(59*time.Minute))
	if room.State == "ended" {
		t.Fatal("empty room ended before one hour")
	}
	_ = s.syncRoom(context.Background(), room, now.Add(time.Hour+time.Second))
	if room.State != "ended" {
		t.Fatal("empty room survived longer than one hour")
	}

	s, m, id, secret = createTest(t)
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	room = s.rooms[id]
	now = room.Created
	m.participants = []Participant{{Identity: "host"}}
	_ = s.syncRoom(context.Background(), room, now.Add(time.Minute))
	m.participants = nil
	_ = s.syncRoom(context.Background(), room, now.Add(time.Minute+46*time.Second))
	if room.State == "ended" {
		t.Fatal("host departure ended a reusable room")
	}
	_ = s.syncRoom(context.Background(), room, now.Add(61*time.Minute+45*time.Second))
	if room.State == "ended" {
		t.Fatal("room ended before being empty for one hour")
	}
	_ = s.syncRoom(context.Background(), room, now.Add(61*time.Minute+47*time.Second))
	if room.State != "ended" {
		t.Fatal("room did not expire after one hour without participants")
	}
}

func TestAnyParticipantKeepsRoomAlive(t *testing.T) {
	s, m, id, secret := createTest(t)
	if code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start", `{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`); code != 200 {
		t.Fatal(code)
	}
	room := s.rooms[id]
	now := room.Created
	m.participants = []Participant{{Identity: "viewer-present"}}
	_ = s.syncRoom(context.Background(), room, now.Add(2*time.Hour))
	if room.State == "ended" {
		t.Fatal("room with a participant expired")
	}
}
func TestOriginValidationAndRateLimit(t *testing.T) {
	s := New(&fakeMedia{}, "http://localhost", "", "")
	h := s.Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/rooms", nil)
	r.Header.Set("Origin", "https://evil.example")
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	for i := 0; i < 10; i++ {
		if c, _ := call(t, h, "POST", "/api/rooms", ""); c != 201 {
			t.Fatal(c)
		}
	}
	if c, _ := call(t, h, "POST", "/api/rooms", ""); c != 429 {
		t.Fatal(c)
	}
}
func TestLiveKitRPC(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Error("missing authentication")
		}
		if strings.HasSuffix(r.URL.Path, "CreateRoom") {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["max_participants"] != float64(0) || b["empty_timeout"] != float64(7200) {
				t.Error(b)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"participants":[{"identity":"host","tracks":[{"source":"SCREEN_SHARE"}]}]}`))
	}))
	defer upstream.Close()
	l := &LiveKit{URL: upstream.URL, Key: "key", Secret: "secret", Client: upstream.Client()}
	if err := l.Create(context.Background(), "room"); err != nil {
		t.Fatal(err)
	}
	ps, err := l.Participants(context.Background(), "room")
	if err != nil || len(ps) != 1 || ps[0].Tracks[0].Source != "SCREEN_SHARE" {
		t.Fatal(ps, err)
	}
}
