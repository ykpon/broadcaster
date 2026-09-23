package broadcast

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type signalAuth struct {
	Role, Session string
	Generation    uint64
}

type ticketRecord struct {
	Auth    signalAuth
	Expires time.Time
}

func ticketHash(raw string) [32]byte { return sha256.Sum256([]byte(raw)) }

func (s *Server) issueTicket(id string, auth signalAuth) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[id]
	if room == nil || room.State == "ended" {
		return ""
	}
	return s.issueTicketLocked(room, auth)
}

// Caller holds mu. Raw tickets are never retained in room state.
func (s *Server) issueTicketLocked(room *Room, auth signalAuth) string {
	now := s.now()
	for hash, record := range room.Tickets {
		if !now.Before(record.Expires) {
			delete(room.Tickets, hash)
		}
	}
	if auth.Role == "viewer" {
		auth.Generation = 0
	} else if auth.Role == "host" {
		room.ViewerPrepared = false
	}
	raw := randomID()
	room.Tickets[ticketHash(raw)] = ticketRecord{Auth: auth, Expires: now.Add(time.Minute)}
	return raw
}

func (s *Server) consumeTicket(id, raw string) (signalAuth, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.consumeTicketLocked(s.rooms[id], raw)
}

func (s *Server) consumeTicketLocked(room *Room, raw string) (signalAuth, bool) {
	if room == nil || room.State == "ended" {
		return signalAuth{}, false
	}
	hash := ticketHash(raw)
	record, ok := room.Tickets[hash]
	delete(room.Tickets, hash)
	if !ok || !s.now().Before(record.Expires) {
		return signalAuth{}, false
	}
	if record.Auth.Role == "host" && (!room.Active || record.Auth.Generation != room.Generation) {
		return signalAuth{}, false
	}
	return record.Auth, true
}

func (s *Server) join(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Session string `json:"session"`
	}
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, true)
	if room == nil {
		return
	}
	s.expireSeats(room, s.now())
	session := input.Session
	if _, ok := room.Seats[session]; !ok {
		if !room.ViewerLimit.Allows(len(room.Seats) + 1) {
			problem(w, 409, "В комнате достигнут лимит зрителей")
			return
		}
		session = "viewer-" + randomID()
	}
	room.Seats[session] = s.now().Add(90 * time.Second)
	ticket := s.issueTicketLocked(room, signalAuth{Role: "viewer", Session: session})
	writeJSON(w, 200, JoinResponse{Session: session, Ticket: ticket})
}

func (s *Server) signalTicket(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Session    string `json:"session"`
		HostSecret string `json:"hostSecret"`
		Generation uint64 `json:"generation"`
	}
	if decode(w, r, &input) != nil {
		problem(w, 400, "Некорректный запрос")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.lookup(w, r, true)
	if room == nil {
		return
	}
	auth := signalAuth{Role: "viewer", Session: input.Session}
	if input.HostSecret != "" {
		hash := sha256.Sum256([]byte(input.HostSecret))
		if input.Session != "" || subtle.ConstantTimeCompare(hash[:], room.Secret[:]) != 1 {
			problem(w, 403, "Нужен ключ ведущего")
			return
		}
		if !room.Active || input.Generation != room.Generation {
			problem(w, 409, "Запуск уже изменился")
			return
		}
		auth = signalAuth{Role: "host", Generation: input.Generation}
	} else {
		s.expireSeats(room, s.now())
		if _, ok := room.Seats[input.Session]; !ok || input.Generation != 0 {
			problem(w, 403, "Неизвестная сессия")
			return
		}
		room.Seats[input.Session] = s.now().Add(90 * time.Second)
	}
	writeJSON(w, 200, map[string]string{"ticket": s.issueTicketLocked(room, auth)})
}

type signalTimer interface{ Stop() bool }
type hostGrace struct{ timer signalTimer }

type signalEnvelope struct {
	message   serverSignal
	closeCode websocket.StatusCode
}

type signalPeer struct {
	auth    signalAuth
	conn    *websocket.Conn
	out     chan signalEnvelope
	closing chan websocket.StatusCode
	done    chan struct{}
	// sendMu serializes terminal enqueue with reader cleanup and policy closes.
	// It is never held during socket I/O.
	sendMu   sync.Mutex
	graceful bool
	// The following fields are protected by Server.mu.
	messages            []time.Time
	candidateGeneration uint64
	candidates          int
	readyGeneration     uint64
}

func (p *signalPeer) key() string {
	if p.auth.Role == "host" {
		return "host"
	}
	return p.auth.Session
}

// Enqueue only: no socket I/O is performed while Server.mu is held. A slow
// client is disconnected instead of blocking another room's control plane.
func (p *signalPeer) send(message serverSignal) {
	p.enqueue(signalEnvelope{message: message})
}

func (p *signalPeer) enqueue(envelope signalEnvelope) {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	if p.graceful {
		return
	}
	select {
	case p.out <- envelope:
		// Once the final event is queued, its writer owns closing the socket.
		p.graceful = envelope.closeCode != 0
	default:
		p.closeLocked(websocket.StatusPolicyViolation)
	}
}

func (p *signalPeer) close(code websocket.StatusCode) {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	p.closeLocked(code)
}

func (p *signalPeer) closeLocked(code websocket.StatusCode) {
	if p.graceful {
		return
	}
	select {
	case p.closing <- code:
	default:
	}
}

func (p *signalPeer) closingGracefully() bool {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	return p.graceful
}

func (p *signalPeer) writeLoop(ctx context.Context, cancel context.CancelFunc) {
	defer close(p.done)
	defer cancel()
	defer p.conn.CloseNow()
	for {
		select {
		case <-ctx.Done():
			return
		case code := <-p.closing:
			// A close requested just before the lifecycle commit may already be
			// queued. The final event takes precedence once it has been committed.
			if p.closingGracefully() {
				continue
			}
			_ = p.conn.Close(code, "control connection closed")
			return
		case envelope := <-p.out:
			if envelope.message.Type != "" {
				writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
				err := wsjson.Write(writeCtx, p.conn, envelope.message)
				writeCancel()
				if err != nil {
					return
				}
			}
			if envelope.closeCode != 0 {
				_ = p.conn.Close(envelope.closeCode, "control connection closed")
				return
			}
		}
	}
}

func (s *Server) beginControlHandler() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shuttingDown {
		return false
	}
	s.controlWG.Add(1)
	return true
}

func (s *Server) trackControlPeer(p *signalPeer) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shuttingDown {
		return false
	}
	s.controlPeers[p] = struct{}{}
	return true
}

func (s *Server) untrackControlPeer(p *signalPeer) {
	s.mu.Lock()
	delete(s.controlPeers, p)
	s.mu.Unlock()
}

// Shutdown gracefully closes every accepted control socket and waits for its
// handler to exit. Once ctx expires, remaining sockets are force-closed.
func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() {
		s.mu.Lock()
		s.shuttingDown = true
		peers := make([]*signalPeer, 0, len(s.controlPeers))
		for peer := range s.controlPeers {
			peers = append(peers, peer)
		}
		s.mu.Unlock()
		for _, peer := range peers {
			peer.close(websocket.StatusGoingAway)
		}
		go func() {
			s.controlWG.Wait()
			close(s.shutdownDone)
		}()
	})
	select {
	case <-s.shutdownDone:
		return nil
	case <-ctx.Done():
	}

	s.mu.Lock()
	peers := make([]*signalPeer, 0, len(s.controlPeers))
	for peer := range s.controlPeers {
		peers = append(peers, peer)
	}
	s.mu.Unlock()
	for _, peer := range peers {
		_ = peer.conn.CloseNow()
	}
	<-s.shutdownDone
	return ctx.Err()
}

func (s *Server) signal(w http.ResponseWriter, r *http.Request) {
	if !s.beginControlHandler() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	defer s.controlWG.Done()
	// Handler validates the complete public Origin (including scheme and port).
	// Accept additionally applies its standard same-host origin policy.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	conn.SetReadLimit(256 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	p := &signalPeer{conn: conn, out: make(chan signalEnvelope, 1024), closing: make(chan websocket.StatusCode, 1), done: make(chan struct{})}
	if !s.trackControlPeer(p) {
		cancel()
		_ = conn.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	defer s.untrackControlPeer(p)
	go p.writeLoop(ctx, cancel)
	defer func() { p.close(websocket.StatusNormalClosure); <-p.done; cancel() }()
	firstCtx, firstCancel := context.WithTimeout(ctx, 10*time.Second)
	var first clientSignal
	err = wsjson.Read(firstCtx, conn, &first)
	firstCancel()
	if err != nil || first.Type != "authenticate" || first.Ticket == "" {
		p.close(websocket.StatusPolicyViolation)
		return
	}
	id := r.PathValue("id")
	s.mu.Lock()
	room := s.rooms[id]
	auth, ok := s.consumeTicketLocked(room, first.Ticket)
	if ok && auth.Role == "viewer" {
		s.expireSeats(room, s.now())
		_, ok = room.Seats[auth.Session]
	}
	if !ok || (auth.Role != "viewer" && auth.Role != "host") {
		s.mu.Unlock()
		p.close(websocket.StatusPolicyViolation)
		return
	}
	p.auth = auth
	p.messages = []time.Time{s.now()}
	if previous := room.Peers[p.key()]; previous != nil {
		previous.close(websocket.StatusNormalClosure)
	}
	room.Peers[p.key()] = p
	room.Controlled = true
	room.EmptySince = time.Time{}
	if auth.Role == "host" {
		s.cancelHostGrace(room)
	}
	s.countControlViewers(room)
	p.send(serverSignal{Type: "authenticated", Generation: room.Generation, Viewer: auth.Session})
	if auth.Role == "viewer" && room.Active {
		p.send(s.startedMessage(room, auth.Session))
	} else if auth.Role == "host" && room.Transport == TransportP2P {
		for _, viewer := range room.Peers {
			if viewer.auth.Role == "viewer" && viewer.readyGeneration == room.Generation {
				p.send(serverSignal{Type: "peer-ready", Generation: room.Generation, Viewer: viewer.auth.Session})
			}
		}
	}
	s.mu.Unlock()
	defer s.removePeer(id, p)
	for {
		var message clientSignal
		if err := wsjson.Read(ctx, conn, &message); err != nil {
			return
		}
		if !s.routeSignal(id, p, message) {
			p.close(websocket.StatusPolicyViolation)
			return
		}
	}
}

// routeSignal returns false for a policy violation. Stale generations and
// absent destinations are harmless races and are ignored.
func (s *Server) routeSignal(id string, p *signalPeer, message clientSignal) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[id]
	if room == nil || room.State == "ended" || room.Peers[p.key()] != p {
		return false
	}
	now := s.now()
	cutoff := now.Add(-time.Minute)
	first := 0
	for first < len(p.messages) && !p.messages[first].After(cutoff) {
		first++
	}
	p.messages = append(p.messages[first:], now)
	if len(p.messages) > 512 {
		return false
	}
	if message.Type == "authenticate" {
		return false
	}
	if !room.Active || message.Generation != room.Generation || (p.auth.Role == "host" && p.auth.Generation != room.Generation) {
		return true
	}
	if p.auth.Role == "viewer" && message.Viewer != "" && message.Viewer != p.auth.Session {
		return false
	}
	if message.Type == "broadcast-ready" {
		if p.auth.Role != "host" {
			return false
		}
		room.State = "live"
		return true
	}
	if message.Type == "broadcast-stopped" {
		if p.auth.Role != "host" {
			return false
		}
		mediaRoom := s.stopGeneration(room)
		// The transition is complete under mu; the external RPC cannot block routing.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.deleteStoppedMedia(ctx, id, mediaRoom); err != nil {
				log.Print(err)
			}
		}()
		return true
	}
	if room.Transport != TransportP2P {
		return false
	}
	var target *signalPeer
	viewer := message.Viewer
	if p.auth.Role == "host" {
		if message.Type != "offer" && message.Type != "ice-candidate" && message.Type != "peer-failed" {
			return false
		}
		target = room.Peers[viewer]
		if target != nil && target.auth.Role != "viewer" {
			target = nil
		}
	} else {
		if message.Type != "answer" && message.Type != "ice-candidate" && message.Type != "peer-ready" && message.Type != "peer-failed" {
			return false
		}
		viewer = p.auth.Session
		target = room.Peers["host"]
		if message.Type == "peer-ready" {
			p.readyGeneration = room.Generation
		}
		if message.Type == "peer-failed" {
			p.readyGeneration = 0
		}
	}
	if message.Type == "ice-candidate" {
		if message.Candidate == nil {
			return false
		}
		if p.candidateGeneration != room.Generation {
			p.candidateGeneration, p.candidates = room.Generation, 0
		}
		p.candidates++
		if p.candidates > 256 {
			return false
		}
	}
	if target != nil {
		target.send(serverSignal{Type: message.Type, Generation: room.Generation, Viewer: viewer, SDP: message.SDP, Candidate: message.Candidate})
	}
	return true
}

func (s *Server) removePeer(id string, p *signalPeer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[id]
	if room == nil || room.Peers[p.key()] != p {
		return
	}
	delete(room.Peers, p.key())
	if len(room.Peers) == 0 {
		room.EmptySince = s.now()
	}
	s.countControlViewers(room)
	if p.auth.Role == "viewer" {
		room.Seats[p.auth.Session] = s.now().Add(90 * time.Second)
		if host := room.Peers["host"]; host != nil && room.Active && room.Transport == TransportP2P {
			host.send(serverSignal{Type: "peer-left", Generation: room.Generation, Viewer: p.auth.Session})
		}
	} else if room.Active && room.Generation == p.auth.Generation {
		grace := &hostGrace{}
		room.HostGrace = grace
		grace.timer = s.afterFunc(20*time.Second, func() { s.hostGraceExpired(id, p.auth.Generation, grace) })
	}
}

func (s *Server) hostGraceExpired(id string, generation uint64, grace *hostGrace) {
	s.mu.Lock()
	room := s.rooms[id]
	if room == nil || !room.Active || room.Generation != generation || room.HostGrace != grace || room.Peers["host"] != nil {
		s.mu.Unlock()
		return
	}
	mediaRoom := s.stopGeneration(room)
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.deleteStoppedMedia(ctx, id, mediaRoom); err != nil {
		log.Print(err)
	}
}

// Lifecycle notification helpers below are called with Server.mu held, so
// event ordering follows the committed generation transitions.
func (s *Server) cancelHostGrace(room *Room) {
	if room.HostGrace != nil {
		room.HostGrace.timer.Stop()
		room.HostGrace = nil
	}
}

func (s *Server) countControlViewers(room *Room) {
	room.Viewers = 0
	for _, p := range room.Peers {
		if p.auth.Role == "viewer" {
			room.Viewers++
		}
	}
}

func (s *Server) startedMessage(room *Room, session string) serverSignal {
	message := serverSignal{Type: "broadcast-started", Generation: room.Generation, Transport: room.Transport, ViewerLimit: room.ViewerLimit.String()}
	if room.Transport == TransportP2P {
		message.IceServers = []IceServer{{URLs: []string{s.STUNURL}}}
	} else {
		message.LiveKit = &LiveKitConnection{URL: s.MediaURL, Token: s.media.Token(room.MediaRoom, session, false)}
	}
	return message
}

func (s *Server) notifyStarted(room *Room) {
	for _, p := range room.Peers {
		if p.auth.Role == "viewer" {
			p.send(s.startedMessage(room, p.auth.Session))
		}
	}
}

func (s *Server) notifyStopped(room *Room) {
	for _, p := range room.Peers {
		message := serverSignal{Type: "broadcast-stopped", Generation: room.Generation}
		if p.auth.Role == "host" {
			p.enqueue(signalEnvelope{message: message, closeCode: websocket.StatusNormalClosure})
			delete(room.Peers, "host")
		} else {
			p.send(message)
		}
	}
}

func (s *Server) closeRoomPeers(room *Room) {
	s.cancelHostGrace(room)
	for _, p := range room.Peers {
		p.enqueue(signalEnvelope{message: serverSignal{Type: "room-ended", Generation: room.Generation}, closeCode: websocket.StatusNormalClosure})
	}
	clear(room.Peers)
	clear(room.Tickets)
	room.Viewers = 0
}

func (s *Server) stopGeneration(room *Room) string {
	if room.Active {
		room.Active = false
		room.ViewerPrepared = false
		room.State = "waiting"
		room.EmptySince = s.now()
		s.cancelHostGrace(room)
		s.notifyStopped(room)
	}
	return room.MediaRoom
}

func (s *Server) deleteStoppedMedia(ctx context.Context, id, mediaRoom string) error {
	if mediaRoom == "" {
		return nil
	}
	if err := s.media.Delete(ctx, mediaRoom); err != nil {
		return err
	}
	s.mu.Lock()
	if room := s.rooms[id]; room != nil && room.MediaRoom == mediaRoom {
		room.MediaRoom = ""
	}
	s.mu.Unlock()
	return nil
}
