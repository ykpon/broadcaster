package broadcast

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeMedia struct {
	participants []Participant
	deleted      bool
}

func (f *fakeMedia) Create(context.Context, string) error { return nil }
func (f *fakeMedia) Delete(context.Context, string) error { f.deleted = true; return nil }
func (f *fakeMedia) Participants(context.Context, string) ([]Participant, error) {
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
	if c, _ := call(t, h, "POST", path+"/host-token", `{"hostSecret":"bad"}`); c != 403 {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/host-token", `{"hostSecret":"`+secret+`"}`); c != 200 {
		t.Fatal(c)
	}
	_, info := call(t, h, "GET", path, "")
	if len(info) != 3 {
		t.Fatal("public endpoint leaked fields", info)
	}
	if c, _ := call(t, h, "POST", path+"/end", `{"hostSecret":"`+secret+`"}`); c != 200 || !m.deleted {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/viewer-token", `{}`); c != 410 {
		t.Fatal(c)
	}
	if c, _ := call(t, h, "POST", path+"/host-token", `{"hostSecret":"`+secret+`"}`); c != 410 {
		t.Fatal(c)
	}
}
func TestTenViewerReservationsAndReconnect(t *testing.T) {
	s, _, id, _ := createTest(t)
	h := s.Handler()
	path := "/api/rooms/" + id + "/viewer-token"
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
	s, m, id, _ := createTest(t)
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

	s, m, id, _ = createTest(t)
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
	s, m, id, _ := createTest(t)
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
			if b["max_participants"] != float64(11) || b["empty_timeout"] != float64(7200) {
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
