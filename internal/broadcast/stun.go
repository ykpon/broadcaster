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
)

type stunBucket struct {
	tokens          float64
	updated         time.Time
	malformedLogged time.Time
}

// STUNServer is a bounded UDP STUN Binding service.
type STUNServer struct {
	conn      *net.UDPConn
	addr      net.Addr
	closeOnce sync.Once
	closeErr  error
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
	server := &STUNServer{
		conn:      conn,
		addr:      conn.LocalAddr(),
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
	return server, nil
}

// Addr returns the UDP address owned by the server.
func (s *STUNServer) Addr() net.Addr {
	return s.addr
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
		if err := s.conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			s.closeErr = err
		}
	})
}

func (s *STUNServer) serve() {
	defer close(s.serveDone)
	defer s.closeConn()
	buckets := make(map[string]*stunBucket)
	buffer := make([]byte, stunPacketSize)
	lastPrune := time.Now()
	for {
		n, source, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		now := time.Now()
		if now.Sub(lastPrune) >= stunBucketLifetime {
			for ip, candidate := range buckets {
				if now.Sub(candidate.updated) >= stunBucketLifetime {
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
			bucket = &stunBucket{tokens: stunBurst, updated: now}
			buckets[source.IP.String()] = bucket
		}
		elapsed := now.Sub(bucket.updated).Seconds()
		bucket.tokens = min(stunBurst, bucket.tokens+elapsed*stunRate)
		bucket.updated = now
		if bucket.tokens < 1 {
			continue
		}
		bucket.tokens--

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
			return
		}
	}
}
