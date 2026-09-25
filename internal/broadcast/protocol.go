package broadcast

type Transport string

const (
	TransportP2P    Transport = "p2p"
	TransportServer Transport = "server"
)

type RoomInfo struct {
	RoomID      string    `json:"roomId"`
	State       string    `json:"state"`
	Viewers     int       `json:"viewers"`
	Generation  uint64    `json:"generation"`
	Transport   Transport `json:"transport,omitempty"`
	ViewerLimit string    `json:"viewerLimit"`
}

type LiveKitConnection struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type IceServer struct {
	URLs []string `json:"urls"`
}

type StartResponse struct {
	Generation uint64             `json:"generation"`
	Transport  Transport          `json:"transport"`
	Ticket     string             `json:"ticket"`
	IceServers []IceServer        `json:"iceServers,omitempty"`
	LiveKit    *LiveKitConnection `json:"livekit,omitempty"`
}

type JoinResponse struct {
	Session string `json:"session"`
	Ticket  string `json:"ticket"`
}

type ICECandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type clientSignal struct {
	Type          string        `json:"type"`
	Ticket        string        `json:"ticket,omitempty"`
	Generation    uint64        `json:"generation,omitempty"`
	Viewer        string        `json:"viewer,omitempty"`
	NegotiationID string        `json:"negotiationId,omitempty"`
	SDP           string        `json:"sdp,omitempty"`
	Candidate     *ICECandidate `json:"candidate,omitempty"`
}

type serverSignal struct {
	Type          string             `json:"type"`
	Generation    uint64             `json:"generation,omitempty"`
	Resync        bool               `json:"resync,omitempty"`
	Transport     Transport          `json:"transport,omitempty"`
	Viewer        string             `json:"viewer,omitempty"`
	NegotiationID string             `json:"negotiationId,omitempty"`
	ViewerLimit   string             `json:"viewerLimit,omitempty"`
	SDP           string             `json:"sdp,omitempty"`
	Candidate     *ICECandidate      `json:"candidate,omitempty"`
	IceServers    []IceServer        `json:"iceServers,omitempty"`
	LiveKit       *LiveKitConnection `json:"livekit,omitempty"`
	Error         string             `json:"error,omitempty"`
}
