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
	Ticket     string             `json:"ticket,omitempty"`
	IceServers []IceServer        `json:"iceServers,omitempty"`
	LiveKit    *LiveKitConnection `json:"livekit,omitempty"`
}
