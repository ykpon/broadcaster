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
	"strconv"
	"strings"
	"sync"
	"time"
)

type Room struct {
	ID                         string                    `json:"roomId"`
	State                      string                    `json:"state"`
	Viewers                    int                       `json:"viewers"`
	Generation                 uint64                    `json:"generation"`
	Transport                  Transport                 `json:"transport,omitempty"`
	ViewerLimit                ViewerLimit               `json:"-"`
	Secret                     [32]byte                  `json:"-"`
	MediaRoom                  string                    `json:"-"`
	Active                     bool                      `json:"-"`
	Created, EmptySince, Ended time.Time                 `json:"-"`
	Deleted                    bool                      `json:"-"`
	Seats                      map[string]time.Time      `json:"-"`
	Tickets                    map[[32]byte]ticketRecord `json:"-"`
	Peers                      map[string]*signalPeer    `json:"-"`
	HostGrace                  *hostGrace                `json:"-"`
	PrepareOwner               string                    `json:"-"`
	Controlled                 bool                      `json:"-"`
}
type bucket struct {
	Start time.Time
	Count int
}
type Server struct {
	mu                          sync.Mutex
	rooms                       map[string]*Room
	limits                      map[string]bucket
	controlPeers                map[*signalPeer]struct{}
	controlWG                   sync.WaitGroup
	shutdownOnce                sync.Once
	shutdownDone                chan struct{}
	shuttingDown                bool
	media                       Media
	PublicURL, MediaURL, WebDir string
	STUNURL                     string
	TrustProxy                  bool
	now                         func() time.Time
	afterFunc                   func(time.Duration, func()) signalTimer
}

func New(media Media, publicURL, mediaURL, webDir string) *Server {
	return &Server{rooms: make(map[string]*Room), limits: make(map[string]bucket), controlPeers: make(map[*signalPeer]struct{}), shutdownDone: make(chan struct{}), media: media, PublicURL: strings.TrimRight(publicURL, "/"), MediaURL: mediaURL, WebDir: webDir, STUNURL: "stun:localhost:3478", now: time.Now, afterFunc: func(d time.Duration, f func()) signalTimer { return time.AfterFunc(d, f) }}
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
	mux.HandleFunc("POST /api/rooms/{id}/start", s.start)
	mux.HandleFunc("POST /api/rooms/{id}/stop", s.stop)
	mux.HandleFunc("POST /api/rooms/{id}/join", s.join)
	mux.HandleFunc("POST /api/rooms/{id}/signal-ticket", s.signalTicket)
	mux.HandleFunc("GET /api/rooms/{id}/signal", s.signal)
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
	now := time.Now()
	limit, _ := ParseViewerLimit("10")
	room := &Room{ID: id, State: "waiting", Secret: sha256.Sum256([]byte(secret)), ViewerLimit: limit, Created: now, EmptySince: now, Seats: make(map[string]time.Time), Tickets: make(map[[32]byte]ticketRecord), Peers: make(map[string]*signalPeer)}
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
		writeJSON(w, 200, s.roomInfo(room))
	}
}

func (s *Server) roomInfo(room *Room) RoomInfo {
	return RoomInfo{RoomID: room.ID, State: room.State, Viewers: room.Viewers, Generation: room.Generation, Transport: room.Transport, ViewerLimit: room.ViewerLimit.String()}
}

type startInput struct {
	HostSecret  string    `json:"hostSecret"`
	Transport   Transport `json:"transport"`
	ViewerLimit string    `json:"viewerLimit"`
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var input startInput
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return
	}
	limit, err := ParseViewerLimit(input.ViewerLimit)
	if err != nil || (input.Transport != TransportP2P && input.Transport != TransportServer) {
		problem(w, 400, "Некорректная конфигурация эфира")
		return
	}
	response, code, message := s.startRoom(r.Context(), r.PathValue("id"), input.HostSecret, input.Transport, limit)
	if code != 200 {
		problem(w, code, message)
		return
	}
	writeJSON(w, 200, response)
}

func (s *Server) startRoom(ctx context.Context, id, secret string, transport Transport, limit ViewerLimit) (StartResponse, int, string) {
	s.mu.Lock()
	room := s.rooms[id]
	if room == nil {
		s.mu.Unlock()
		return StartResponse{}, 404, "Комната не найдена или срок её действия истёк"
	}
	if room.State == "ended" {
		s.mu.Unlock()
		return StartResponse{}, 410, "Эфир завершён"
	}
	if room.Active || room.PrepareOwner != "" {
		s.mu.Unlock()
		return StartResponse{}, 409, "Эфир уже запущен"
	}
	hash := sha256.Sum256([]byte(secret))
	if subtle.ConstantTimeCompare(hash[:], room.Secret[:]) != 1 {
		s.mu.Unlock()
		return StartResponse{}, 403, "Нужна ссылка ведущего с ключом доступа"
	}
	occupied, generation := len(room.Seats), room.Generation
	if !limit.Allows(occupied) {
		s.mu.Unlock()
		return StartResponse{}, 409, "Лимит зрителей меньше занятых мест"
	}
	nextGeneration := generation + 1
	prepareOwner := randomID()
	room.PrepareOwner = prepareOwner
	mediaRoom := ""
	if transport == TransportServer {
		mediaRoom = "broadcast-" + id + "-" + strconv.FormatUint(nextGeneration, 10)
	}
	s.mu.Unlock()

	if mediaRoom != "" {
		if err := s.media.Create(ctx, mediaRoom); err != nil {
			s.mu.Lock()
			if room := s.rooms[id]; room != nil && room.PrepareOwner == prepareOwner {
				room.PrepareOwner = ""
			}
			s.mu.Unlock()
			log.Print(err)
			return StartResponse{}, 503, "Медиасервер недоступен. Попробуйте ещё раз."
		}
	}

	s.mu.Lock()
	room = s.rooms[id]
	if room == nil || room.State == "ended" || room.Active || room.PrepareOwner != prepareOwner || room.Generation != generation || len(room.Seats) != occupied || !limit.Allows(len(room.Seats)) {
		if room != nil && room.PrepareOwner == prepareOwner {
			room.PrepareOwner = ""
		}
		s.mu.Unlock()
		if mediaRoom != "" {
			if err := s.media.Delete(ctx, mediaRoom); err != nil {
				log.Print(err)
			}
		}
		return StartResponse{}, 409, "Конфигурация комнаты изменилась. Повторите запрос."
	}
	oldMediaRoom := room.MediaRoom
	room.PrepareOwner = ""
	room.Generation = nextGeneration
	room.Transport = transport
	room.ViewerLimit = limit
	room.MediaRoom = mediaRoom
	room.Active = true
	room.State = "waiting"
	room.Deleted = false
	response := StartResponse{Generation: room.Generation, Transport: room.Transport}
	response.Ticket = s.issueTicketLocked(room, signalAuth{Role: "host", Generation: room.Generation})
	s.armHostGrace(room)
	if transport == TransportP2P {
		response.IceServers = []IceServer{{URLs: []string{s.STUNURL}}}
	} else {
		response.LiveKit = &LiveKitConnection{URL: s.MediaURL, Token: s.media.Token(room.MediaRoom, "host", true)}
	}
	s.notifyStarted(room)
	s.mu.Unlock()

	if oldMediaRoom != "" && oldMediaRoom != mediaRoom {
		if err := s.media.Delete(ctx, oldMediaRoom); err != nil {
			log.Print(err)
		}
	}
	return response, 200, ""
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	var input struct {
		HostSecret string `json:"hostSecret"`
		Generation uint64 `json:"generation"`
	}
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return
	}
	s.mu.Lock()
	room := s.lookup(w, r, true)
	if room == nil {
		s.mu.Unlock()
		return
	}
	hash := sha256.Sum256([]byte(input.HostSecret))
	if subtle.ConstantTimeCompare(hash[:], room.Secret[:]) != 1 {
		s.mu.Unlock()
		problem(w, 403, "Нужна ссылка ведущего с ключом доступа")
		return
	}
	if input.Generation != room.Generation {
		s.mu.Unlock()
		problem(w, 409, "Запуск уже изменился")
		return
	}
	mediaRoom := s.stopGeneration(room)
	s.mu.Unlock()
	if err := s.deleteStoppedMedia(r.Context(), r.PathValue("id"), mediaRoom); err != nil {
		log.Print(err)
		problem(w, 503, "Не удалось остановить медиасервер")
		return
	}
	writeJSON(w, 200, map[string]any{"state": "waiting", "generation": input.Generation})
}

func (s *Server) end(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	room := s.lookup(w, r, false)
	if room == nil || !s.authorize(w, r, room) {
		s.mu.Unlock()
		return
	}
	s.markEnded(room, time.Now())
	room.Active = false
	mediaRoom := room.MediaRoom
	if mediaRoom == "" {
		room.Deleted = true
		s.mu.Unlock()
		writeJSON(w, 200, map[string]string{"state": "ended"})
		return
	}
	s.mu.Unlock()
	if err := s.media.Delete(r.Context(), mediaRoom); err != nil {
		log.Print(err)
		problem(w, 503, "Завершение запрошено. Сервер повторит отключение участников.")
		return
	}
	s.mu.Lock()
	if room := s.rooms[r.PathValue("id")]; room != nil && room.MediaRoom == mediaRoom {
		room.MediaRoom = ""
		room.Deleted = true
	}
	s.mu.Unlock()
	writeJSON(w, 200, map[string]string{"state": "ended"})
}
func (s *Server) markEnded(room *Room, now time.Time) {
	if room.State != "ended" {
		room.State = "ended"
		room.Ended = now
		room.Active = false
		s.closeRoomPeers(room)
	}
}
func (s *Server) syncRoom(ctx context.Context, room *Room, now time.Time) error {
	if room.State == "ended" {
		return nil
	}
	if room.Transport != TransportServer || room.MediaRoom == "" || room.Controlled {
		s.expireSeats(room, now)
		if len(room.Peers) > 0 {
			room.EmptySince = time.Time{}
		} else {
			if room.EmptySince.IsZero() {
				room.EmptySince = now
			}
			if now.Sub(room.EmptySince) > time.Hour {
				s.markEnded(room, now)
			}
		}
		return nil
	}
	participants, err := s.media.Participants(ctx, room.MediaRoom)
	if err != nil {
		return err
	}
	room.Viewers = 0
	for _, p := range participants {
		if p.Identity == "host" {
			continue
		}
		room.Viewers++
		room.Seats[p.Identity] = now.Add(90 * time.Second)
	}
	s.expireSeats(room, now)
	if len(participants) > 0 {
		room.EmptySince = time.Time{}
	} else if room.EmptySince.IsZero() {
		room.EmptySince = now
	}
	if !room.EmptySince.IsZero() && now.Sub(room.EmptySince) > time.Hour {
		s.markEnded(room, now)
	}
	return nil
}

func (s *Server) expireSeats(room *Room, now time.Time) {
	for id, expiry := range room.Seats {
		if room.Peers[id] == nil && !now.Before(expiry) {
			delete(room.Seats, id)
		}
	}
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
						if room.MediaRoom == "" {
							room.Deleted = true
						} else if err := s.media.Delete(ctx, room.MediaRoom); err == nil {
							room.MediaRoom = ""
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
