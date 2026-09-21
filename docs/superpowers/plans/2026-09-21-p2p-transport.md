# P2P Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-broadcast choice between direct WebRTC P2P and LiveKit SFU delivery, with a user-entered positive viewer limit that defaults to 10 and has no product maximum.

**Architecture:** A generation-scoped Go control plane owns logical viewer sessions, one-time WebSocket tickets, transport changes, and signaling. Server generations lazily create unique LiveKit rooms; P2P generations route only SDP/ICE while media flows through one browser peer connection per viewer. The same Go process also exposes a rate-limited UDP STUN Binding service.

**Tech Stack:** Go 1.26, `github.com/coder/websocket` v1.8.15, `github.com/pion/stun/v3` v3.1.7, React 19, TypeScript 5.8, native WebRTC, LiveKit client 2.15, Vitest 3.2, Playwright 1.63, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-21-p2p-transport-design.md`

## Global Constraints

- Transport and viewer limit are selected before every initial or repeated broadcast start and are locked while that generation is active.
- The default viewer limit is the decimal string `"10"`; accept every syntactically valid positive decimal integer without a product maximum or HTML `max` attribute.
- Preserve arbitrary precision by carrying viewer limits as normalized decimal strings and comparing them with `math/big.Int` on the server.
- A new limit below active plus reserved viewer sessions must reject the start; never evict existing viewers to satisfy it.
- P2P is strict: use STUN only, never TURN, LiveKit fallback, or automatic transport switching after ICE failure.
- P2P media must not pass through Go or LiveKit; Go routes control, SDP, and ICE only.
- Viewer pages that already joined must follow pause and generation changes without reload or a new link.
- STUN runs in the app process on UDP `:3478` by default and advertises `stun:localhost:3478` by default.
- One WebSocket message is at most 256 KiB; one peer may send at most 256 ICE candidates per generation and one connection at most 512 signaling messages per minute.
- Direct ICE times out after 20 seconds without `connected` or `completed`.
- Preserve current screen/audio capture, quality controls, playout buffer, diagnostics, room expiry, and end-room behavior in server mode.
- Use test-first red-green-refactor for every production behavior.

---

## File Map

- `internal/broadcast/limit.go`: arbitrary-precision viewer-limit parsing, normalization, and comparisons.
- `internal/broadcast/protocol.go`: shared Go HTTP/WebSocket payload types and transport constants.
- `internal/broadcast/server.go`: room/start/stop/join/end lifecycle and public status.
- `internal/broadcast/signal.go`: ticket issuance/consumption, WebSocket peers, routing, rate limits, and generation events.
- `internal/broadcast/stun.go`: UDP STUN listener, parser, response writer, source-IP token buckets, shutdown.
- `internal/broadcast/media.go`: lazy LiveKit room operations and unlimited LiveKit room capacity enforced by the app.
- `cmd/server/main.go`: config validation plus independent HTTP, STUN, cleanup, and graceful shutdown startup.
- `web/src/protocol.ts`: transport config, exact API/event types, viewer-limit normalization, persisted selection.
- `web/src/controlSocket.ts`: authenticated reconnecting control WebSocket with generation guards.
- `web/src/studioTransport.ts`: common publisher interface and LiveKit publisher extracted from `Studio`.
- `web/src/p2pPublisher.ts`: per-viewer peer connections, SDP/ICE, sender quality, timeout, stats.
- `web/src/viewerTransport.ts`: LiveKit/P2P receiving implementations and generation-scoped switching.
- `web/src/stats.ts`: aggregation of outbound P2P peer metrics.
- `web/src/Studio.tsx`: capture flow, start/stop API, selected publisher, transport UI and P2P status.
- `web/src/Viewer.tsx`: logical join, control events, transport-independent player state, P2P retry.
- `web/src/api.ts`, `web/src/room.ts`: new API models and status labels independent of LiveKit enums.
- `web/src/styles.css`: transport cards, viewer-limit field, warnings, connection counters, responsive layout.
- `compose.yaml`, `.env.example`, `Dockerfile`, `deploy/nginx.conf.example`, `deploy/livekit.yaml`: UDP 3478, public STUN configuration, and removal of the old LiveKit-wide participant cap.
- `web/e2e/broadcast.spec.ts`: LiveKit regression, P2P, mode switching, limits, and no-fallback coverage.
- `README.md`: operation, deployment, privacy/bandwidth, and NAT limitations.

---

### Task 1: Arbitrary Viewer Limit and Generation-Aware Room Lifecycle

**Files:**
- Create: `internal/broadcast/limit.go`
- Create: `internal/broadcast/limit_test.go`
- Create: `internal/broadcast/protocol.go`
- Modify: `internal/broadcast/server.go:22-288`
- Modify: `internal/broadcast/server_test.go:14-174`
- Modify: `internal/broadcast/media.go:17-92`

**Interfaces:**
- Produces: `type ViewerLimit struct`, `ParseViewerLimit(string) (ViewerLimit, error)`, `ViewerLimit.String() string`, `ViewerLimit.Allows(int) bool`.
- Produces: `type Transport string` with `TransportP2P` and `TransportServer`.
- Produces HTTP endpoints `POST /api/rooms/{id}/start` and `/stop`. Keep the legacy `/host-token` and `/viewer-token` handlers temporarily; Task 5 removes `/host-token` after Studio migrates and Task 7 removes `/viewer-token` after Viewer migrates.
- Produces: `RoomInfo` and `StartResponse` JSON shapes later mirrored by `web/src/protocol.ts`. Task 2 adds `JoinResponse` with real signaling tickets.

- [ ] **Step 1: Write failing arbitrary-limit tests**

```go
func TestViewerLimitPreservesArbitraryPrecision(t *testing.T) {
	limit, err := ParseViewerLimit("000100000000000000000000000000000000000000000000000")
	if err != nil { t.Fatal(err) }
	if got := limit.String(); got != "100000000000000000000000000000000000000000000000000" {
		t.Fatalf("normalized limit = %q", got)
	}
	if !limit.Allows(10_000) { t.Fatal("large limit rejected ordinary occupancy") }
}

func TestViewerLimitRejectsNonPositiveOrNonIntegralInput(t *testing.T) {
	for _, raw := range []string{"", "0", "-1", "+1", "1.5", " 10", "10 "} {
		if _, err := ParseViewerLimit(raw); err == nil { t.Errorf("accepted %q", raw) }
	}
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `go test ./internal/broadcast -run ViewerLimit -v`

Expected: compilation fails because `ParseViewerLimit` does not exist.

- [ ] **Step 3: Implement the value object**

```go
type ViewerLimit struct{ value *big.Int }

func ParseViewerLimit(raw string) (ViewerLimit, error) {
	if raw == "" || strings.Trim(raw, "0123456789") != "" {
		return ViewerLimit{}, errors.New("viewer limit must be decimal digits")
	}
	v, ok := new(big.Int).SetString(raw, 10)
	if !ok || v.Sign() <= 0 { return ViewerLimit{}, errors.New("viewer limit must be positive") }
	return ViewerLimit{value: v}, nil
}

func (l ViewerLimit) String() string { return new(big.Int).Set(l.value).String() }
func (l ViewerLimit) Allows(occupied int) bool {
	return l.value.Cmp(new(big.Int).SetUint64(uint64(occupied))) >= 0
}
```

- [ ] **Step 4: Add failing room lifecycle tests**

Test these exact behaviors in `server_test.go`:

```go
func TestCreateRoomDoesNotRequireLiveKitAndDefaultsToTen(t *testing.T) {
	s, media, id, _ := createTest(t)
	if media.created != nil { t.Fatalf("created LiveKit eagerly: %v", media.created) }
	_, info := call(t, s.Handler(), "GET", "/api/rooms/"+id, "")
	if info["viewerLimit"] != "10" || info["generation"] != float64(0) { t.Fatal(info) }
}

func TestP2PStartNeverCallsLiveKit(t *testing.T) {
	s, media, id, secret := createTest(t)
	code, body := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start",
		`{"hostSecret":"`+secret+`","transport":"p2p","viewerLimit":"999999999999999999999"}`)
	if code != 200 || body["generation"] != float64(1) || len(media.created) != 0 { t.Fatal(code, body, media.created) }
}

func TestServerStartIsTransactional(t *testing.T) {
	s, media, id, secret := createTest(t)
	media.createErr = errors.New("offline")
	code, _ := call(t, s.Handler(), "POST", "/api/rooms/"+id+"/start",
		`{"hostSecret":"`+secret+`","transport":"server","viewerLimit":"10"}`)
	if code != 503 || s.rooms[id].Generation != 0 || s.rooms[id].Transport != "" { t.Fatal(code, s.rooms[id]) }
}
```

Also test `/stop` rejects stale generation, server generations use `broadcast-{roomID}-{generation}`, a limit below reserved sessions returns 409, and `/end` deletes only an existing media room.

- [ ] **Step 5: Run lifecycle tests and verify RED**

Run: `go test ./internal/broadcast -run 'CreateRoom|P2PStart|ServerStart|Stop|LimitBelow' -v`

Expected: old `create` still calls LiveKit and the new routes/types are missing.

- [ ] **Step 6: Implement the generation lifecycle**

Use these public shapes in `protocol.go`:

```go
type Transport string
const (
	TransportP2P Transport = "p2p"
	TransportServer Transport = "server"
)

type RoomInfo struct {
	RoomID string `json:"roomId"`
	State string `json:"state"`
	Viewers int `json:"viewers"`
	Generation uint64 `json:"generation"`
	Transport Transport `json:"transport,omitempty"`
	ViewerLimit string `json:"viewerLimit"`
}

type LiveKitConnection struct { URL string `json:"url"`; Token string `json:"token"` }
type IceServer struct { URLs []string `json:"urls"` }
type StartResponse struct {
	Generation uint64 `json:"generation"`
	Transport Transport `json:"transport"`
	Ticket string `json:"ticket"`
	IceServers []IceServer `json:"iceServers,omitempty"`
	LiveKit *LiveKitConnection `json:"livekit,omitempty"`
}
```

Change `Room` to own `Generation`, `Transport`, `ViewerLimit`, `MediaRoom`, `Active`, `Seats`, and ticket/peer maps initialized by constructors. Add `STUNURL string` to `Server` and extend `New` so a P2P `StartResponse` contains `[]IceServer{{URLs: []string{s.STUNURL}}}`. Create no LiveKit room in `create`. In `start`, parse and validate first; prepare a server room outside `s.mu`; re-lock and re-check generation/occupancy; commit atomically; delete the prepared room on a failed re-check. Set LiveKit `max_participants` to `0` so the app's arbitrary-precision logical limit is authoritative.

- [ ] **Step 7: Run all Go tests and verify GREEN**

Run: `go test ./internal/broadcast -v`

Expected: all package tests pass, including updated JWT/RPC tests asserting `max_participants: 0`.

- [ ] **Step 8: Commit**

```bash
git add internal/broadcast/limit.go internal/broadcast/limit_test.go internal/broadcast/protocol.go internal/broadcast/server.go internal/broadcast/server_test.go internal/broadcast/media.go
git commit -m "feat: add generation-aware broadcast configuration"
```

---

### Task 2: One-Time Tickets and the WebSocket Control Plane

**Files:**
- Create: `internal/broadcast/signal.go`
- Create: `internal/broadcast/signal_test.go`
- Modify: `internal/broadcast/server.go:36-320`
- Modify: `internal/broadcast/protocol.go`
- Modify: `go.mod`
- Create: `go.sum`

**Interfaces:**
- Consumes: room `Generation`, `Transport`, `Seats`, `MediaRoom`, viewer limit, and LiveKit token signer from Task 1.
- Produces: same-origin `GET /api/rooms/{id}/signal` using `github.com/coder/websocket` v1.8.15.
- Produces: `POST /api/rooms/{id}/join` for viewer session/ticket issuance and `POST /api/rooms/{id}/signal-ticket` for a fresh viewer or host reconnect ticket without creating a generation.
- Produces: `issueTicket`, `consumeTicket`, `notifyStarted`, `notifyStopped`, and `closeRoomPeers` methods.
- Produces JSON client/server messages discriminated by `type`.

- [ ] **Step 1: Add the WebSocket dependency at the reviewed version**

Run: `go get github.com/coder/websocket@v1.8.15`

Expected: `go.mod` and `go.sum` record v1.8.15.

- [ ] **Step 2: Write failing ticket tests**

```go
func TestSignalTicketIsSingleUseBoundAndExpires(t *testing.T) {
	s, _, id, _ := createTest(t)
	now := time.Unix(100, 0)
	s.now = func() time.Time { return now }
	ticket := s.issueTicket(id, signalAuth{Role: "viewer", Session: "viewer-a"})
	got, ok := s.consumeTicket(id, ticket)
	if !ok || got.Session != "viewer-a" { t.Fatal(got, ok) }
	if _, ok := s.consumeTicket(id, ticket); ok { t.Fatal("ticket reused") }
	expired := s.issueTicket(id, signalAuth{Role: "viewer", Session: "viewer-b"})
	now = now.Add(61 * time.Second)
	if _, ok := s.consumeTicket(id, expired); ok { t.Fatal("expired ticket accepted") }
}
```

Add `TestJoinUsesConfiguredLimitAndResumesSession`: reserve ten default seats, assert the eleventh `/join` is 409, assert an existing session can redeem a new ticket without consuming another seat, start a later generation with a very large decimal limit, and assert an additional join succeeds. Never convert the configured limit to `float64` or `int`.

- [ ] **Step 3: Run ticket test and verify RED**

Run: `go test ./internal/broadcast -run SignalTicket -v`

Expected: ticket methods and injectable clock are undefined.

- [ ] **Step 4: Implement ticket issuance and consumption**

Store only SHA-256 ticket hashes in the room and bind each record to role, session, generation, and a 60-second expiry. Viewer tickets bind session but remain generation-neutral so the logical control connection survives mode changes; host tickets bind the generation returned by `/start`.

```go
type signalAuth struct { Role, Session string; Generation uint64 }
type ticketRecord struct { Auth signalAuth; Expires time.Time }
type JoinResponse struct { Session string `json:"session"`; Ticket string `json:"ticket"` }

func ticketHash(raw string) [32]byte { return sha256.Sum256([]byte(raw)) }
```

`/signal-ticket` accepts either `{hostSecret, generation}` or `{session}`. It validates the caller against the current room and returns only `{ticket}`; it never starts, stops, or increments a generation. The frontend reconnect callback uses this endpoint for the host and repeats `/join` with its existing session for the viewer.

- [ ] **Step 5: Write failing routing integration tests**

Use `httptest.NewServer`, `websocket.Dial`, and `wsjson` to prove:

1. the first message must be `{"type":"authenticate","ticket":"..."}`;
2. two viewers in different rooms never receive each other's events;
3. a viewer cannot send `offer` or target another viewer;
4. host `offer` reaches only an existing viewer in the same generation;
5. viewer `answer` and candidate route only to the current host;
6. stale-generation messages are ignored;
7. the 257th candidate closes that peer with policy violation;
8. start/stop/end events reach viewers already waiting;
9. each server-mode viewer receives a LiveKit token with its own identity.
10. a host that disconnects may redeem a fresh generation-bound ticket during a 20-second grace period; if no host reconnects, the generation stops and viewers receive `broadcast-stopped`.
11. `broadcast-ready` sets `state=live` only for the authenticated current-generation host; stale readiness is ignored.
12. active control peers prevent the one-hour empty-room expiry, and cross-origin WebSocket upgrades are rejected.

The core successful assertion should look like:

```go
writeJSON(t, host, clientSignal{Type: "offer", Generation: 1, Viewer: viewerID, SDP: "offer-sdp"})
got := readJSON[serverSignal](t, viewer)
if got.Type != "offer" || got.SDP != "offer-sdp" || got.Generation != 1 { t.Fatal(got) }
```

- [ ] **Step 6: Run routing tests and verify RED**

Run: `go test ./internal/broadcast -run 'Signal|WebSocket|Routing|CandidateLimit' -v`

Expected: the signal route and routing hub do not exist.

- [ ] **Step 7: Implement the hub and exact wire protocol**

Use these message shapes:

```go
type clientSignal struct {
	Type string `json:"type"`
	Ticket string `json:"ticket,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
	Viewer string `json:"viewer,omitempty"`
	SDP string `json:"sdp,omitempty"`
	Candidate *ICECandidate `json:"candidate,omitempty"`
}
type serverSignal struct {
	Type string `json:"type"`
	Generation uint64 `json:"generation,omitempty"`
	Transport Transport `json:"transport,omitempty"`
	Viewer string `json:"viewer,omitempty"`
	ViewerLimit string `json:"viewerLimit,omitempty"`
	SDP string `json:"sdp,omitempty"`
	Candidate *ICECandidate `json:"candidate,omitempty"`
	IceServers []IceServer `json:"iceServers,omitempty"`
	LiveKit *LiveKitConnection `json:"livekit,omitempty"`
	Error string `json:"error,omitempty"`
}
```

Accept with compression disabled, call `SetReadLimit(256 << 10)`, keep one writer goroutine per peer, and never write while holding `Server.mu`. Enforce 512 accepted client messages per rolling minute and 256 candidates per peer/generation. On expected stop, send `broadcast-stopped` without removing logical viewer sessions. On end, send `room-ended` and close all peers.

When the host socket drops unexpectedly, schedule a generation-scoped 20-second timer. A successfully authenticated replacement host cancels that timer. If it fires, call the same idempotent stop transition as `/stop`, delete any LiveKit room, and notify viewers. Viewer socket loss keeps its seat reserved for 90 seconds and sends `peer-left` to a P2P host immediately.

- [ ] **Step 8: Run Go tests and race detector**

Run: `go test -race ./internal/broadcast`

Expected: all tests pass with no race report.

- [ ] **Step 9: Commit**

```bash
git add go.mod go.sum internal/broadcast/protocol.go internal/broadcast/server.go internal/broadcast/signal.go internal/broadcast/signal_test.go
git commit -m "feat: add authenticated broadcast signaling"
```

---

### Task 3: Embedded STUN and Independent Server Startup

**Files:**
- Create: `internal/broadcast/stun.go`
- Create: `internal/broadcast/stun_test.go`
- Modify: `cmd/server/main.go:36-78`
- Modify: `cmd/server/main_test.go`
- Modify: `go.mod`
- Modify: `go.sum`

**Interfaces:**
- Produces: `ValidateSTUNURL(string) error` and `ListenSTUN(context.Context, string) (*STUNServer, error)`.
- Produces: `STUNServer.Addr() net.Addr` and `STUNServer.Close() error`.
- Uses `github.com/pion/stun/v3` v3.1.7, which includes the 2026 malformed-address panic fix.

- [ ] **Step 1: Add the STUN dependency**

Run: `go get github.com/pion/stun/v3@v3.1.7`

Expected: v3.1.7 appears in `go.mod` and `go.sum`.

- [ ] **Step 2: Write failing URL and UDP tests**

```go
func TestSTUNBindingReturnsObservedAddress(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server, err := ListenSTUN(ctx, "127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	client, err := stun.DialURI(mustSTUNURI(t, "stun:"+server.Addr().String()), &stun.DialConfig{})
	if err != nil { t.Fatal(err) }
	defer client.Close()
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	var mapped stun.XORMappedAddress
	if err := client.Do(request, func(event stun.Event) {
		if event.Error != nil { t.Error(event.Error); return }
		if err := mapped.GetFrom(event.Message); err != nil { t.Error(err) }
	}); err != nil { t.Fatal(err) }
	if !mapped.IP.IsLoopback() || mapped.Port == 0 { t.Fatalf("mapped = %v", mapped) }
}
```

Also test invalid `turn:`, `stuns:`, missing host/port, a pre-bound UDP address, cancellation closing the listener, non-Binding packets receiving no response, and the per-IP bucket dropping requests after burst 200.

- [ ] **Step 3: Run STUN tests and verify RED**

Run: `go test ./internal/broadcast -run STUN -v`

Expected: STUN server APIs are undefined.

- [ ] **Step 4: Implement the minimal Binding server**

For each accepted datagram, decode into `stun.Message`, require `message.Type == stun.BindingRequest`, then build the response with the original transaction ID and observed UDP address:

```go
response, err := stun.Build(
	request,
	stun.BindingSuccess,
	&stun.XORMappedAddress{IP: udpAddr.IP, Port: udpAddr.Port},
	stun.Fingerprint,
)
```

Use a per-source token bucket refilled at 100 tokens/second with capacity 200. A malformed datagram is dropped and logged at most once per limiter window; it must never panic the read loop.

- [ ] **Step 5: Write failing startup tests**

Extract `run(ctx, config) error` from `main` and test that:

- HTTP starts even when `media.Cleanup` returns an error;
- an invalid STUN URL returns before listeners start;
- an occupied STUN address returns an error;
- cancelling context closes HTTP and UDP listeners.

- [ ] **Step 6: Run startup tests and verify RED**

Run: `go test ./cmd/server -v`

Expected: `run` and STUN config are missing; current startup fatally depends on LiveKit cleanup.

- [ ] **Step 7: Implement independent startup**

Add config fields sourced from `STUN_LISTEN_ADDR` and `STUN_URL`, defaulting to `:3478` and `stun:localhost:3478`. Validate first, start STUN, run LiveKit cleanup once as best-effort logging, then start HTTP. Ensure both close from the same cancellation context.

- [ ] **Step 8: Verify Go packages**

Run: `go test -race ./... && go vet ./...`

Expected: both commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add go.mod go.sum internal/broadcast/stun.go internal/broadcast/stun_test.go cmd/server/main.go cmd/server/main_test.go
git commit -m "feat: embed a stun binding service"
```

---

### Task 4: Shared Frontend Protocol, Viewer-Limit Config, and Control Socket

**Files:**
- Create: `web/src/protocol.ts`
- Create: `web/src/protocol.test.ts`
- Create: `web/src/controlSocket.ts`
- Create: `web/src/controlSocket.test.ts`
- Modify: `web/src/api.ts:1-22`
- Modify: `web/src/room.ts:1-38`

**Interfaces:**
- Mirrors Task 1/2 JSON exactly: `TransportMode`, `RoomInfo`, `StartResponse`, `JoinResponse`, `ServerSignal`, `ClientSignal`.
- Produces: `normalizeViewerLimit`, `loadBroadcastConfig`, `saveBroadcastConfig`.
- Produces: `createControlSocket(options): ControlSocket` with `connect`, `send`, and `close`.

- [ ] **Step 1: Write failing config tests**

```ts
it("normalizes arbitrary positive decimal limits without Number conversion", () => {
  expect(normalizeViewerLimit("000100000000000000000000000000000000000")).toBe(
    "100000000000000000000000000000000000000",
  );
  for (const raw of ["", "0", "-1", "+1", "1.5", " 10", "10 "])
    expect(normalizeViewerLimit(raw)).toBeNull();
});

it("defaults to server transport and ten viewers when storage is absent", () => {
  expect(loadBroadcastConfig({ getItem: () => null } as Storage)).toEqual({
    transport: "server",
    viewerLimit: "10",
  });
});
```

- [ ] **Step 2: Run config tests and verify RED**

Run: `cd web && pnpm test -- protocol.test.ts`

Expected: module and functions are missing.

- [ ] **Step 3: Implement protocol and config normalization**

```ts
export type TransportMode = "p2p" | "server";
export type BroadcastConfig = { transport: TransportMode; viewerLimit: string };
export const DEFAULT_BROADCAST_CONFIG: BroadcastConfig = {
  transport: "server",
  viewerLimit: "10",
};

export function normalizeViewerLimit(raw: string): string | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+/, "");
  return normalized === "" ? null : normalized;
}
```

Define `ServerSignal` as a discriminated union so a `broadcast-started` event always contains generation, transport, viewerLimit, and exactly the connection fields for that transport.

- [ ] **Step 4: Write failing control-socket tests with a fake WebSocket**

Prove the controller authenticates first, reconnects after 1/2/4/8-second delays with a freshly fetched ticket, ignores stale-generation transport events, flushes no messages after `close`, and calls `onFatal` after the fourth failed reconnect.

```ts
expect(sockets[0].sent).toEqual([
  JSON.stringify({ type: "authenticate", ticket: "ticket-1" }),
]);
sockets[0].emitMessage({ type: "broadcast-started", generation: 2, transport: "p2p" });
sockets[0].emitMessage({ type: "broadcast-stopped", generation: 1 });
expect(events.map((event) => event.generation)).toEqual([2]);
```

- [ ] **Step 5: Run socket tests and verify RED**

Run: `cd web && pnpm test -- controlSocket.test.ts`

Expected: control-socket factory is missing.

- [ ] **Step 6: Implement the controller**

Inject `WebSocket`, timer functions, and `getTicket` for deterministic tests. Build the URL from `location.origin`, replacing `http` with `ws`, and use `/api/rooms/${roomId}/signal`. Authentication is the first `open` write. Track the highest observed generation and reject lower-generation messages before invoking callbacks.

For Studio, `getTicket` POSTs `{hostSecret, generation}` to `/signal-ticket`. For Viewer, it POSTs `{session}` to `/join` and replaces the stored ticket while retaining the returned session. A reconnect must never call `/start`.

- [ ] **Step 7: Update API and polling models**

Move `RoomInfo`/connection types out of `api.ts`; keep `api<T>` as the fetch helper. Make `roomStateLabel` accept the transport-independent strings `disconnected | connecting | connected | reconnecting` instead of importing LiveKit `ConnectionState`.

- [ ] **Step 8: Run frontend tests and build**

Run: `cd web && pnpm test && pnpm run build`

Expected: tests and TypeScript build pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/protocol.ts web/src/protocol.test.ts web/src/controlSocket.ts web/src/controlSocket.test.ts web/src/api.ts web/src/room.ts
git commit -m "feat: add browser control protocol"
```

---

### Task 5: Extract the Existing LiveKit Publisher Behind a Common Interface

**Files:**
- Create: `web/src/studioTransport.ts`
- Create: `web/src/studioTransport.test.ts`
- Modify: `web/src/media.ts:11-211`
- Modify: `web/src/media.test.ts`
- Modify: `web/src/Studio.tsx:90-404`
- Modify: `internal/broadcast/server.go`
- Modify: `internal/broadcast/server_test.go`

**Interfaces:**
- Produces: `StudioPublisher` with `start`, `updateSettings`, `getStatsSources`, `setMuted`, and `stop`.
- Produces: `createLiveKitPublisher(callbacks): StudioPublisher`.
- Keeps capture ownership in `Studio`; publishers never call `getDisplayMedia` or stop source tracks.

- [ ] **Step 1: Write failing interface tests around the LiveKit publisher**

```ts
it("connects, publishes, updates, mutes, and disposes through one interface", async () => {
  const publisher = createLiveKitPublisher(callbacks, { Room: FakeRoom as never });
  await publisher.start({
    stream,
    settings: DEFAULT_STREAM_SETTINGS,
    connection: { url: "ws://livekit", token: "token" },
  });
  await publisher.updateSettings(DEFAULT_STREAM_SETTINGS, changedSettings);
  await publisher.setMuted(true);
  await publisher.stop();
  expect(events).toEqual(["connect", "publish", "update", "mute:true", "unpublish", "disconnect"]);
});
```

Also prove a disconnect callback is generation-scoped and a stopped publisher cannot clear a replacement publisher's state.

- [ ] **Step 2: Run the publisher test and verify RED**

Run: `cd web && pnpm test -- studioTransport.test.ts`

Expected: publisher interface and factory are missing.

- [ ] **Step 3: Implement the interface and move LiveKit ownership**

```ts
export type RTCStatsProvider = { getStats(): Promise<RTCStatsReport> };
export type PublisherStart = {
  generation: number;
  stream: MediaStream;
  settings: StreamSettings;
  livekit?: LiveKitConnection;
  iceServers?: RTCIceServer[];
  send(signal: ClientSignal): void;
};

export type StudioPublisher = {
  readonly kind: TransportMode;
  start(input: PublisherStart): Promise<void>;
  updateSettings(previous: StreamSettings, next: StreamSettings): Promise<QualityUpdateResult>;
  getStatsSources(): { video?: RTCStatsProvider; audio?: RTCStatsProvider };
  setMuted(muted: boolean): Promise<void>;
  stop(): Promise<void>;
};
```

Move `Room` construction, listeners, connect, publish, unpublish, mute, and disconnect from `Studio.tsx` into `createLiveKitPublisher`. Keep `publishScreen` and `updateQuality` as LiveKit-specific helpers. Make callbacks report generic connection state and published track replacements.

- [ ] **Step 4: Adapt Studio without changing UI behavior**

Use only the server branch for now. `Studio.start` still captures first, then calls `/start` with `{transport:"server", viewerLimit:"10"}`, builds the LiveKit publisher from `response.livekit`, and authenticates the host control socket. `pause` calls `/stop` after publisher shutdown. No P2P selector is rendered until Task 8.

After the Studio path is green, remove the legacy `/host-token` route and its tests. Keep `/viewer-token` until Task 7 because the old Viewer still uses it during this checkpoint.

- [ ] **Step 5: Run regression tests and build**

Run: `go test ./internal/broadcast && cd web && pnpm test && pnpm run build`

Expected: every existing frontend test passes and Studio compiles without direct LiveKit room ownership.

- [ ] **Step 6: Commit**

```bash
git add internal/broadcast/server.go internal/broadcast/server_test.go web/src/studioTransport.ts web/src/studioTransport.test.ts web/src/media.ts web/src/media.test.ts web/src/Studio.tsx
git commit -m "refactor: isolate the livekit publisher"
```

---

### Task 6: P2P Studio Publisher, Sender Quality, Timeout, and Aggregated Stats

**Files:**
- Create: `web/src/p2pPublisher.ts`
- Create: `web/src/p2pPublisher.test.ts`
- Modify: `web/src/studioTransport.ts`
- Modify: `web/src/stats.ts:1-176`
- Modify: `web/src/stats.test.ts`

**Interfaces:**
- Consumes: `StudioPublisher`, `ServerSignal`, `ClientSignal`, `StreamSettings`.
- Produces: `createP2PPublisher(callbacks, dependencies): StudioPublisher & P2PSignaling`.
- Produces: `aggregateOutboundMetrics(peerReports): StreamMetrics`.

Define `P2PSignaling` as:

```ts
export type P2PSignaling = {
  handleSignal(signal: ServerSignal): Promise<void>;
};
```

- [ ] **Step 1: Write failing peer lifecycle tests**

With an injected fake `RTCPeerConnection`, prove:

- one `peer-ready` creates one connection and repeated readiness replaces rather than duplicates it;
- video/audio tracks are added to send-only transceivers;
- selected codec is moved to the front with `setCodecPreferences`;
- an offer is sent only after `setLocalDescription`;
- answers/candidates apply only to the matching current-generation peer;
- local ICE sends candidates with the viewer identity;
- `failed`, 20-second timeout, viewer leave, and stop close the correct connections;
- retry creates a fresh peer in the same generation;
- one failure leaves all other peers open.

```ts
await publisher.handle({ type: "peer-ready", generation: 7, viewer: "viewer-a" });
expect(peerFactory).toHaveBeenCalledTimes(1);
expect(send).toHaveBeenCalledWith(expect.objectContaining({
  type: "offer", generation: 7, viewer: "viewer-a", sdp: "offer-sdp",
}));
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `cd web && pnpm test -- p2pPublisher.test.ts`

Expected: P2P publisher is missing.

- [ ] **Step 3: Implement P2P offer/ICE lifecycle**

Keep `Map<string, PeerState>` where `PeerState` contains connection, timer, video/audio senders, and stats samples. Configure `{iceServers}` only from the start response. Never add TURN credentials or LiveKit URLs. Send `peer-failed` on timeout/failure and expose connected/failed counts through callbacks.

- [ ] **Step 4: Write failing sender-quality tests**

Assert every existing video sender receives `maxBitrate`, `maxFramerate`, and degradation preference; audio receives its bitrate; capture constraints apply once to the shared source track; a later peer receives current settings immediately.

```ts
expect(videoSender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
  encodings: [expect.objectContaining({ maxBitrate: 42_000_000, maxFramerate: 90 })],
  degradationPreference: "maintain-framerate",
}));
```

- [ ] **Step 5: Implement shared P2P quality application**

Extract transport-neutral sender parameter helpers from `media.ts` without changing LiveKit behavior. P2P codec changes remain disabled during a live generation, matching the current Studio rule. Apply settings sequentially per sender and rollback confirmed settings through the existing latest-settings updater if any mutation fails.

- [ ] **Step 6: Write failing aggregate-stats tests**

```ts
expect(aggregateOutboundMetrics([
  { bitrateKbps: 1200, packets: 10, lossPercent: 1, rttMs: 40 },
  { bitrateKbps: 800, packets: 20, lossPercent: 4, rttMs: 130 },
])).toMatchObject({ bitrateKbps: 2000, packets: 30, lossPercent: 4, rttMs: 130 });
```

Also assert limitation precedence `cpu > bandwidth > other > none` and that absent fields remain absent rather than becoming zero.

- [ ] **Step 7: Implement aggregation and verify frontend**

Run: `cd web && pnpm test && pnpm run build`

Expected: all tests and build pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/p2pPublisher.ts web/src/p2pPublisher.test.ts web/src/studioTransport.ts web/src/stats.ts web/src/stats.test.ts web/src/media.ts
git commit -m "feat: add the p2p studio publisher"
```

---

### Task 7: Generation-Scoped Viewer Transports

**Files:**
- Create: `web/src/viewerTransport.ts`
- Create: `web/src/viewerTransport.test.ts`
- Modify: `web/src/viewerRuntime.ts`
- Modify: `web/src/viewerRuntime.test.ts`
- Modify: `web/src/playout.ts`
- Modify: `web/src/Viewer.tsx:63-289`
- Modify: `internal/broadcast/server.go`
- Modify: `internal/broadcast/server_test.go`

**Interfaces:**
- Produces: `ViewerTransportController.switchTo(event)`, `handleSignal(event)`, `retryP2P()`, `stopGeneration(generation)`, and `dispose()`.
- Produces callbacks for remote tracks, generic connection state, playback blocking, and errors.
- Keeps logical joined state outside the media transport.

- [ ] **Step 1: Write failing switching tests**

Use fake LiveKit rooms and fake peer connections to prove:

1. server generation connects LiveKit with its token;
2. P2P generation creates a receive peer, sends `peer-ready`, accepts offer, sends answer, and applies remote ICE;
3. server → P2P → server closes each old transport exactly once;
4. `broadcast-stopped` clears remote tracks but keeps `joined=true` in the caller;
5. stale connect/answer/track/disconnect cannot affect the new generation;
6. `retryP2P` uses the same generation and sends a fresh `peer-ready`;
7. a 20-second timeout reports the strict NAT/firewall error and never creates LiveKit.

```ts
const p2pStarted = (generation: number): BroadcastStartedSignal => ({
  type: "broadcast-started",
  generation,
  transport: "p2p",
  viewerLimit: "10",
  iceServers: [{ urls: ["stun:localhost:3478"] }],
});

await controller.switchTo(p2pStarted(2));
await controller.handleSignal({ type: "offer", generation: 2, sdp: "offer" });
expect(send).toHaveBeenCalledWith(expect.objectContaining({
  type: "answer", generation: 2, sdp: "answer",
}));
expect(liveKitRooms[0].disconnect).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run switching tests and verify RED**

Run: `cd web && pnpm test -- viewerTransport.test.ts`

Expected: viewer controller is missing.

- [ ] **Step 3: Implement LiveKit and P2P receivers**

The P2P receiver uses `new RTCPeerConnection({iceServers})`, registers `ontrack` before signaling readiness, then lets `setRemoteDescription(offer)` create the receiving transceivers before `createAnswer`. It does not add extra recv-only transceivers before the offer. The LiveKit receiver moves existing `RoomEvent.TrackSubscribed` behavior unchanged. Both expose the actual `RTCRtpReceiver` so `applyPlayoutBuffer` works; only the LiveKit receiver may use LiveKit's playout fallback.

- [ ] **Step 4: Refactor Viewer to own one logical session**

`join()` calls `/join`, stores the returned session, opens `createControlSocket`, and sets `joined=true` after authentication. Media starts from `broadcast-started`; stop/switch never returns to the first-entry button. Unmount and room-ended close logical control and media. Preserve volume, mute, fullscreen, buffer, and incoming diagnostics.

After this path is green, remove the legacy `/viewer-token` route and its tests; `/join` plus personalized `broadcast-started` events are now the only viewer entry path.

- [ ] **Step 5: Run viewer and full frontend tests**

Run: `go test ./internal/broadcast && cd web && pnpm test && pnpm run build`

Expected: tests and build pass; no direct `new Room` or `new RTCPeerConnection` remains in `Viewer.tsx`.

- [ ] **Step 6: Commit**

```bash
git add internal/broadcast/server.go internal/broadcast/server_test.go web/src/viewerTransport.ts web/src/viewerTransport.test.ts web/src/viewerRuntime.ts web/src/viewerRuntime.test.ts web/src/playout.ts web/src/Viewer.tsx
git commit -m "feat: switch viewer transports by generation"
```

---

### Task 8: Studio Transport Selection and Limit UI

**Files:**
- Modify: `web/src/Studio.tsx:65-620`
- Modify: `web/src/studioRuntime.ts`
- Modify: `web/src/studioRuntime.test.ts`
- Modify: `web/src/styles.css:668-906,1260-1360`

**Interfaces:**
- Consumes: protocol config, control socket, LiveKit publisher, P2P publisher, and start/stop APIs.
- Produces visible controls labeled `Способ подключения`, `P2P — напрямую`, `Через сервер`, and `Лимит зрителей`.

- [ ] **Step 1: Write failing Studio runtime tests**

```ts
it("does not register a generation when capture is cancelled", async () => {
  const startGeneration = vi.fn();
  await startStudioBroadcast({ capture: () => Promise.reject(new DOMException("cancel", "AbortError")), startGeneration });
  expect(startGeneration).not.toHaveBeenCalled();
});

it("stops captured tracks when generation preparation fails", async () => {
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }],
    getVideoTracks: () => [{ applyConstraints: vi.fn() }],
  } as unknown as MediaStream;
  await expect(startStudioBroadcast({
    capture: async () => stream,
    startGeneration: async () => { throw new Error("LiveKit offline"); },
  })).rejects.toThrow("LiveKit offline");
  expect(stop).toHaveBeenCalledTimes(1);
});
```

Also test selected publisher factory, stop ordering (`publisher.stop` then `/stop`), and stale publisher completion guards.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `cd web && pnpm test -- studioRuntime.test.ts`

Expected: orchestration helper is missing.

- [ ] **Step 3: Implement orchestration and select the publisher**

Keep capture first to preserve user activation. Normalize viewer limit before capture. POST `/start` only after capture/quality succeeds. Create the returned transport publisher, authenticate host control, start publisher, then send `broadcast-ready`. On every failure, stop tracks, publisher, control socket, and any generation already registered.

- [ ] **Step 4: Add the UI controls**

Render two radio-card labels and `<input type="text" inputMode="numeric" aria-label="Лимит зрителей">` with no `max`. Disable both only when live or busy. Show an inline validation error before invoking capture. Persist the last confirmed `{transport, viewerLimit}` safely to localStorage.

For P2P, render this permanent copy next to the control:

> Поток отправляется отдельно каждому зрителю. Участники могут видеть сетевые адреса друг друга. Если прямое соединение заблокировано NAT или firewall, автоматического перехода через сервер не будет.

Show connected/failed peer counts while live and show the current transport in the status area.

- [ ] **Step 5: Add responsive styles**

Use `.transport-options` as a two-column grid above 780 px and one column below it. Give selected cards the existing accent border/background language; use the existing error/notice colors. Ensure the arbitrary-length limit scrolls horizontally inside the input instead of expanding the sidebar.

- [ ] **Step 6: Run frontend verification**

Run: `cd web && pnpm test && pnpm run build`

Expected: all tests/build pass and TypeScript reports no unreachable transport branches.

- [ ] **Step 7: Commit**

```bash
git add web/src/Studio.tsx web/src/studioRuntime.ts web/src/studioRuntime.test.ts web/src/styles.css
git commit -m "feat: let hosts choose transport and viewer limit"
```

---

### Task 9: Viewer P2P Errors, Retry, and Transport Status UI

**Files:**
- Modify: `web/src/Viewer.tsx:42-560`
- Modify: `web/src/viewerRuntime.ts`
- Modify: `web/src/viewerRuntime.test.ts`
- Modify: `web/src/styles.css:940-1100,1300-1360`

**Interfaces:**
- Consumes: `ViewerTransportController` callbacks from Task 7.
- Produces: transport status, strict P2P failure message, and `Повторить P2P-подключение` action.

- [ ] **Step 1: Add failing presentation-state tests**

Extract and test a pure `viewerScene` function:

```ts
expect(viewerScene({ joined: true, active: true, transport: "p2p", p2pFailed: true, ended: false })).toEqual({
  title: "Прямое соединение не установлено",
  subtitle: "Сеть, NAT или firewall не пропускают P2P. Повторите попытку или попросите ведущего запустить эфир через сервер.",
  action: "retry-p2p",
});
```

Also test waiting, server connecting, P2P connecting, and ended states.

- [ ] **Step 2: Run the test and verify RED**

Run: `cd web && pnpm test -- viewerRuntime.test.ts`

Expected: `viewerScene` is missing.

- [ ] **Step 3: Implement UI state and retry**

Display the current transport in the viewer note/control bar. Keep autoplay recovery, volume, mute, fit, fullscreen, buffer, and diagnostics transport-neutral. The retry button calls only `controller.retryP2P()`; it must not call `/start`, change room transport, or instantiate LiveKit.

- [ ] **Step 4: Verify mobile and desktop rendering through build/tests**

Run: `cd web && pnpm test && pnpm run build`

Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/Viewer.tsx web/src/viewerRuntime.ts web/src/viewerRuntime.test.ts web/src/styles.css
git commit -m "feat: explain and retry strict p2p failures"
```

---

### Task 10: Deployment, Documentation, and Real-Browser Coverage

**Files:**
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `Dockerfile`
- Modify: `deploy/nginx.conf.example`
- Modify: `deploy/livekit.yaml`
- Modify: `README.md`
- Modify: `web/e2e/broadcast.spec.ts`

**Interfaces:**
- Publishes app UDP 3478 and passes `STUN_LISTEN_ADDR`/`STUN_URL`.
- Documents that Nginx does not proxy STUN UDP and firewall/NAT must expose it directly.
- Exercises real browser RTCPeerConnection and real backend signal/STUN paths.

- [ ] **Step 1: Write failing Playwright expectations for the new controls and default**

At the start of the existing test, assert:

```ts
await expect(page.getByRole("radio", { name: "Через сервер" })).toBeChecked();
await expect(page.getByLabel("Лимит зрителей")).toHaveValue("10");
```

Replace direct `/viewer-token` overflow probing with `/join`, and set the limit to `10` explicitly for the server-mode ten-viewer section.

- [ ] **Step 2: Add a real P2P and switch test**

Create host plus two isolated viewer contexts. Use the existing canvas/audio capture substitution only. Select P2P, set limit `2`, start, and assert both viewers have non-zero `videoWidth`. Assert the third `/join` receives 409. Stop, select server, restart, and assert the original two viewer pages receive video again without reload and without returning to the `Смотреть эфир` button.

Inspect selected candidate pairs in both P2P browser contexts and assert their remote candidate is not a LiveKit relay. For the failure subcase, install an init script that subclasses the native `RTCPeerConnection` and forces `{iceTransportPolicy:"relay"}` while the room provides no TURN server. Assert the strict error appears after the test clock advances past 20 seconds and that captured API requests contain no server LiveKit connection.

- [ ] **Step 3: Run Playwright and verify RED before deployment edits**

Run: `cd web && pnpm test:e2e`

Expected: new selectors/endpoints/P2P paths fail before the remaining stack wiring is complete.

- [ ] **Step 4: Wire deployment configuration**

In `compose.yaml`, add to `app.environment`:

```yaml
STUN_LISTEN_ADDR: ":3478"
STUN_URL: ${STUN_URL:-stun:localhost:3478}
```

and to `app.ports`:

```yaml
- "${STUN_PORT:-3478}:3478/udp"
```

Add `EXPOSE 3478/udp` to the runtime Dockerfile. Add `STUN_URL=stun:stream.example.com:3478` and `STUN_PORT=3478` to `.env.example`. Do not add an Nginx UDP proxy; document the direct port next to the HTTP locations.

Remove `room.max_participants: 11` from `deploy/livekit.yaml`; application sessions and the chosen decimal viewer limit are authoritative, while LiveKit receives `max_participants: 0` for each server generation.

- [ ] **Step 5: Update README claims and commands**

Change the opening from “media always passes through the server” to the two explicit modes. Document default 10 with no configured maximum, proportional P2P upload, peer IP visibility, strict no-fallback behavior, UDP 3478, and LiveKit ports only for server mode. Update the API route list and the verified-test count only after the final fresh run.

- [ ] **Step 6: Rebuild the Docker stack**

Run: `docker compose up --build -d --remove-orphans`

Expected: `app` and `livekit` are healthy/running; app logs show HTTP and STUN listeners.

- [ ] **Step 7: Run real-browser tests and verify GREEN**

Run: `cd web && pnpm test:e2e`

Expected: server regression, P2P, mode switching, arbitrary limit, strict failure, and mobile/not-found tests pass.

- [ ] **Step 8: Run the full fresh verification gate**

Run in repository root:

```bash
go test -race ./...
go vet ./...
cd web
pnpm test
pnpm run build
pnpm test:e2e
```

Expected: every command exits 0 with no test failures, race report, vet errors, TypeScript errors, or browser console errors. Record the actual frontend test count in README; do not retain the old count if it changed.

- [ ] **Step 9: Perform the public-network acceptance check when deployment credentials are available**

Open the HTTPS viewer URL on a device using a different network from the host, start P2P, and verify the selected candidate pair becomes `succeeded` and video/audio play. Repeat with UDP 3478 blocked and confirm the strict NAT/firewall error without a LiveKit request. If no public deployment or second network is available in the execution environment, record this exact check as unverified in the handoff and do not claim public NAT traversal was tested.

- [ ] **Step 10: Inspect the final diff against the spec**

Run: `git diff --check && git status --short && git diff --stat`

Manually verify every criterion in `docs/superpowers/specs/2026-09-21-p2p-transport-design.md`: lazy LiveKit, strict P2P, automatic generation switching, no product viewer maximum, embedded STUN, warnings, and both transports' diagnostics.

- [ ] **Step 11: Commit**

```bash
git add compose.yaml .env.example Dockerfile deploy/nginx.conf.example deploy/livekit.yaml README.md web/e2e/broadcast.spec.ts
git commit -m "test: verify selectable p2p broadcasting"
```
