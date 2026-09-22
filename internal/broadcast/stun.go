package broadcast

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v3"
)

const (
	stunBurst          = 200
	stunRate           = 100
	stunPacketSize     = 2048
	stunLogWindow      = time.Second
	stunMaxSources     = 4096
	stunBucketLifetime = time.Minute
	stunInitialRetry   = 10 * time.Millisecond
	stunMaxRetryDelay  = time.Second
)

type stunBucket struct {
	limiter         *stunTokenBucket
	malformedLogged time.Time
}

type stunTokenBucket struct {
	tokens  float64
	updated time.Time
	now     func() time.Time
}

func newSTUNTokenBucket(now func() time.Time) *stunTokenBucket {
	return &stunTokenBucket{tokens: stunBurst, updated: now(), now: now}
}

func (b *stunTokenBucket) allow() bool {
	now := b.now()
	b.tokens = min(stunBurst, b.tokens+now.Sub(b.updated).Seconds()*stunRate)
	b.updated = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type stunPacketConn interface {
	ReadFromUDP([]byte) (int, *net.UDPAddr, error)
	WriteToUDP([]byte, *net.UDPAddr) (int, error)
	LocalAddr() net.Addr
	Close() error
}

type stunRetryWait func(context.Context, time.Duration) bool

// STUNServer is a bounded UDP STUN Binding service.
type STUNServer struct {
	conn      stunPacketConn
	addr      net.Addr
	ctx       context.Context
	retryWait stunRetryWait
	closing   atomic.Bool
	closeOnce sync.Once
	closeErr  error
	errMu     sync.Mutex
	serveErr  error
	serveDone chan struct{}
	watchDone chan struct{}
}

// ValidateSTUNURL accepts only an explicit, unencrypted STUN UDP endpoint.
func ValidateSTUNURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse STUN URL: %w", err)
	}
	if parsed.Scheme != "stun" {
		return fmt.Errorf("STUN URL must use the stun scheme")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("STUN URL must not include a query or fragment")
	}
	host, rawPort, err := net.SplitHostPort(parsed.Opaque)
	if err != nil {
		return fmt.Errorf("STUN URL must include host and port: %w", err)
	}
	if host == "" {
		return fmt.Errorf("STUN URL host is empty")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("STUN URL port is invalid")
	}
	uri, err := stun.ParseURI(raw)
	if err != nil {
		return fmt.Errorf("parse STUN URL: %w", err)
	}
	if uri.Scheme != stun.SchemeTypeSTUN || uri.Proto != stun.ProtoTypeUDP {
		return fmt.Errorf("STUN URL must use UDP")
	}
	return nil
}

// ListenSTUN starts a STUN Binding server that closes when ctx is cancelled.
func ListenSTUN(ctx context.Context, address string) (*STUNServer, error) {
	udpAddr, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return nil, fmt.Errorf("resolve STUN listen address: %w", err)
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("listen for STUN: %w", err)
	}
	return newSTUNServer(ctx, conn, waitSTUNRetry), nil
}

func newSTUNServer(ctx context.Context, conn stunPacketConn, retryWait stunRetryWait) *STUNServer {
	server := &STUNServer{
		conn:      conn,
		addr:      conn.LocalAddr(),
		ctx:       ctx,
		retryWait: retryWait,
		serveDone: make(chan struct{}),
		watchDone: make(chan struct{}),
	}
	go server.serve()
	go func() {
		defer close(server.watchDone)
		select {
		case <-ctx.Done():
			server.closeConn()
		case <-server.serveDone:
		}
	}()
	return server
}

// Addr returns the UDP address owned by the server.
func (s *STUNServer) Addr() net.Addr {
	return s.addr
}

// Done closes if the serve loop stops, including after an unexpected fatal error.
func (s *STUNServer) Done() <-chan struct{} {
	return s.serveDone
}

// Err reports an unexpected serve-loop failure after Done is closed.
func (s *STUNServer) Err() error {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	return s.serveErr
}

// Close stops the server and waits for its read loop to exit. It is idempotent.
func (s *STUNServer) Close() error {
	s.closeConn()
	<-s.serveDone
	<-s.watchDone
	return s.closeErr
}

func (s *STUNServer) closeConn() {
	s.closeOnce.Do(func() {
		s.closing.Store(true)
		if err := s.conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			s.closeErr = err
		}
	})
}

func (s *STUNServer) fail(err error) {
	s.errMu.Lock()
	s.serveErr = err
	s.errMu.Unlock()
}

func waitSTUNRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func isTemporarySTUNError(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && (netErr.Timeout() || netErr.Temporary())
}

func (s *STUNServer) serve() {
	defer close(s.serveDone)
	defer s.closeConn()
	buckets := make(map[string]*stunBucket)
	buffer := make([]byte, stunPacketSize)
	lastPrune := time.Now()
	retryDelay := stunInitialRetry
	for {
		n, source, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			if s.closing.Load() && errors.Is(err, net.ErrClosed) {
				return
			}
			if isTemporarySTUNError(err) {
				log.Printf("temporary STUN read failure; retrying in %s: %v", retryDelay, err)
				if s.retryWait(s.ctx, retryDelay) {
					retryDelay = min(stunMaxRetryDelay, retryDelay*2)
					continue
				}
				if s.ctx.Err() != nil || s.closing.Load() {
					return
				}
			}
			s.fail(fmt.Errorf("STUN read failed: %w", err))
			return
		}
		retryDelay = stunInitialRetry
		now := time.Now()
		if now.Sub(lastPrune) >= stunBucketLifetime {
			for ip, candidate := range buckets {
				if now.Sub(candidate.limiter.updated) >= stunBucketLifetime {
					delete(buckets, ip)
				}
			}
			lastPrune = now
		}
		bucket := buckets[source.IP.String()]
		if bucket == nil {
			if len(buckets) >= stunMaxSources {
				continue
			}
			bucket = &stunBucket{limiter: newSTUNTokenBucket(time.Now)}
			buckets[source.IP.String()] = bucket
		}
		if !bucket.limiter.allow() {
			continue
		}

		request := new(stun.Message)
		request.Raw = append(request.Raw, buffer[:n]...)
		if err := request.Decode(); err != nil {
			if bucket.malformedLogged.IsZero() || now.Sub(bucket.malformedLogged) >= stunLogWindow {
				log.Printf("dropping malformed STUN packet from %s: %v", source.IP, err)
				bucket.malformedLogged = now
			}
			continue
		}
		if request.Type != stun.BindingRequest {
			continue
		}
		response, err := stun.Build(
			request,
			stun.BindingSuccess,
			&stun.XORMappedAddress{IP: source.IP, Port: source.Port},
			stun.Fingerprint,
		)
		if err != nil {
			continue
		}
		if _, err := s.conn.WriteToUDP(response.Raw, source); err != nil {
			if s.closing.Load() && errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("STUN response write to %s failed: %v", source, err)
		}
	}
}
