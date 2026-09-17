package broadcast

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Room struct {
	ID                       string               `json:"roomId"`
	State                    string               `json:"state"`
	Viewers                  int                  `json:"viewers"`
	Secret                   [32]byte             `json:"-"`
	Name                     string               `json:"-"`
	Created, LastHost, Ended time.Time            `json:"-"`
	HostSeen                 bool                 `json:"-"`
	Deleted                  bool                 `json:"-"`
	Seats                    map[string]time.Time `json:"-"`
}
type bucket struct {
	Start time.Time
	Count int
}
type Server struct {
	mu                          sync.Mutex
	rooms                       map[string]*Room
	limits                      map[string]bucket
	media                       Media
	PublicURL, MediaURL, WebDir string
	TrustProxy                  bool
}

func New(media Media, publicURL, mediaURL, webDir string) *Server {
	return &Server{rooms: make(map[string]*Room), limits: make(map[string]bucket), media: media, PublicURL: strings.TrimRight(publicURL, "/"), MediaURL: mediaURL, WebDir: webDir}
}
func randomID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func problem(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("extra JSON")
	}
	return nil
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /api/rooms", s.create)
	mux.HandleFunc("GET /api/rooms/{id}", s.status)
	mux.HandleFunc("POST /api/rooms/{id}/host-token", s.host)
	mux.HandleFunc("POST /api/rooms/{id}/viewer-token", s.viewer)
	mux.HandleFunc("POST /api/rooms/{id}/end", s.end)
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) { problem(w, 404, "Маршрут не найден") })
	mux.HandleFunc("GET /", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if origin := r.Header.Get("Origin"); origin != "" && origin != s.PublicURL {
				problem(w, 403, "Недопустимый источник запроса")
				return
			}
			if r.Method == "POST" {
				ip, _, _ := net.SplitHostPort(r.RemoteAddr)
				if s.TrustProxy && r.Header.Get("X-Real-IP") != "" {
					ip = r.Header.Get("X-Real-IP")
				}
				category, limit := "token", 120
				if r.URL.Path == "/api/rooms" {
					category, limit = "create", 10
				}
				s.mu.Lock()
				key := category + ":" + ip
				b := s.limits[key]
				if time.Since(b.Start) > time.Minute {
					b = bucket{Start: time.Now()}
				}
				b.Count++
				s.limits[key] = b
				s.mu.Unlock()
				if b.Count > limit {
					w.Header().Set("Retry-After", "60")
					problem(w, 429, "Слишком много запросов. Повторите через минуту.")
					return
				}
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.rooms) >= 200 {
		problem(w, 503, "Сервер занят. Попробуйте позже.")
		return
	}
	id, secret := randomID(), randomID()
	room := &Room{ID: id, State: "waiting", Secret: sha256.Sum256([]byte(secret)), Name: "broadcast-" + id, Created: time.Now(), Seats: make(map[string]time.Time)}
	if err := s.media.Create(r.Context(), room.Name); err != nil {
		log.Print(err)
		problem(w, 503, "Медиасервер недоступен. Попробуйте ещё раз.")
		return
	}
	s.rooms[id] = room
	writeJSON(w, 201, map[string]string{"roomId": id, "viewerUrl": s.PublicURL + "/watch/" + id, "hostUrl": s.PublicURL + "/studio/" + id + "#key=" + secret})
}
func (s *Server) lookup(w http.ResponseWriter, r *http.Request, active bool) *Room {
	room := s.rooms[r.PathValue("id")]
	if room == nil {
		problem(w, 404, "Комната не найдена или срок её действия истёк")
		return nil
	}
	if active && room.State == "ended" {
		problem(w, 410, "Эфир завершён")
		return nil
	}
	return room
}
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, room *Room) bool {
	var input struct {
		HostSecret string `json:"hostSecret"`
	}
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return false
	}
	hash := sha256.Sum256([]byte(input.HostSecret))
	if subtle.ConstantTimeCompare(hash[:], room.Secret[:]) != 1 {
		problem(w, 403, "Нужна ссылка ведущего с ключом доступа")
		return false
	}
	return true
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, false)
	if room != nil {
		writeJSON(w, 200, room)
	}
}
func (s *Server) host(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, true)
	if room == nil || !s.authorize(w, r, room) {
		return
	}
	// A fixed identity enforces one publisher per room on the SFU.
	writeJSON(w, 200, map[string]string{"token": s.media.Token(room.Name, "host", true), "url": s.MediaURL})
}
func (s *Server) viewer(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, true)
	if room == nil {
		return
	}
	var input struct {
		Session string `json:"session"`
	}
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return
	}
	if err := s.syncRoom(r.Context(), room, time.Now()); err != nil {
		problem(w, 503, "Не удалось проверить свободные места")
		return
	}
	if room.State == "ended" {
		problem(w, 410, "Эфир завершён")
		return
	}
	// Session credentials are generated by this server, never chosen by a client.
	identity := input.Session
	if _, ok := room.Seats[identity]; !ok {
		identity = ""
	}
	if identity == "" {
		if len(room.Seats) >= 10 {
			problem(w, 409, "В комнате уже 10 зрителей. Попробуйте позже.")
			return
		}
		identity = "viewer-" + randomID()
	}
	room.Seats[identity] = time.Now().Add(90 * time.Second)
	writeJSON(w, 200, map[string]string{"token": s.media.Token(room.Name, identity, false), "url": s.MediaURL, "session": identity})
}
func (s *Server) end(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, false)
	if room == nil || !s.authorize(w, r, room) {
		return
	}
	s.markEnded(room, time.Now())
	if err := s.media.Delete(r.Context(), room.Name); err != nil {
		log.Print(err)
		problem(w, 503, "Завершение запрошено. Сервер повторит отключение участников.")
		return
	}
	room.Deleted = true
	writeJSON(w, 200, map[string]string{"state": "ended"})
}
func (s *Server) markEnded(room *Room, now time.Time) {
	if room.State != "ended" {
		room.State = "ended"
		room.Ended = now
	}
}
func (s *Server) syncRoom(ctx context.Context, room *Room, now time.Time) error {
	if room.State == "ended" {
		return nil
	}
	participants, err := s.media.Participants(ctx, room.Name)
	if err != nil {
		return err
	}
	room.Viewers = 0
	host, video := false, false
	for _, p := range participants {
		if p.Identity == "host" {
			host = true
			room.HostSeen = true
			room.LastHost = now
			for _, t := range p.Tracks {
				if t.Source == "SCREEN_SHARE" {
					video = true
				}
			}
		} else {
			room.Viewers++
			room.Seats[p.Identity] = now.Add(90 * time.Second)
		}
	}
	for id, expiry := range room.Seats {
		if now.After(expiry) {
			delete(room.Seats, id)
		}
	}
	if host && video {
		room.State = "live"
	} else {
		room.State = "waiting"
	}
	if (!host && room.HostSeen && now.Sub(room.LastHost) > 45*time.Second) || (!room.HostSeen && now.Sub(room.Created) > 30*time.Minute) {
		s.markEnded(room, now)
	}
	return nil
}
func (s *Server) RunCleanup(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.mu.Lock()
			for id, room := range s.rooms {
				if err := s.syncRoom(ctx, room, now); err != nil {
					log.Print(err)
				}
				if room.State == "ended" {
					if !room.Deleted {
						if err := s.media.Delete(ctx, room.Name); err == nil {
							room.Deleted = true
						} else {
							log.Print(err)
						}
					}
					if room.Deleted && now.Sub(room.Ended) > 10*time.Minute {
						delete(s.rooms, id)
					}
				}
			}
			for key, b := range s.limits {
				if now.Sub(b.Start) > 2*time.Minute {
					delete(s.limits, key)
				}
			}
			s.mu.Unlock()
		}
	}
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/studio/") && !strings.HasPrefix(r.URL.Path, "/watch/") {
		http.FileServer(http.Dir(s.WebDir)).ServeHTTP(w, r)
		return
	}
	index := filepath.Join(s.WebDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.Error(w, "Build the web client first", 503)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}
