package broadcast

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Media isolates the SFU control plane from the room lifecycle and HTTP API.
type Media interface {
	Create(context.Context, string) error
	Delete(context.Context, string) error
	Participants(context.Context, string) ([]Participant, error)
	Token(string, string, bool) string
}

type Participant struct {
	Identity string `json:"identity"`
	Tracks   []struct {
		Source string `json:"source"`
	} `json:"tracks"`
}

type LiveKit struct {
	URL, Key, Secret string
	Client           *http.Client
}

func (l *LiveKit) sign(identity string, grants map[string]any) string {
	now := time.Now()
	payload, _ := json.Marshal(map[string]any{"iss": l.Key, "sub": identity, "nbf": now.Add(-5 * time.Second).Unix(), "exp": now.Add(time.Minute).Unix(), "video": grants})
	enc := base64.RawURLEncoding
	data := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(l.Secret))
	mac.Write([]byte(data))
	return data + "." + enc.EncodeToString(mac.Sum(nil))
}

func (l *LiveKit) Token(room, identity string, host bool) string {
	grants := map[string]any{"room": room, "roomJoin": true, "canSubscribe": !host, "canPublish": host, "canPublishData": false, "canUpdateOwnMetadata": false}
	if host {
		grants["canPublishSources"] = []string{"screen_share", "screen_share_audio"}
	}
	return l.sign(identity, grants)
}

func (l *LiveKit) rpc(ctx context.Context, method, room string, body, output any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", l.URL+"/twirp/livekit.RoomService/"+method, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+l.sign("", map[string]any{"roomCreate": true, "roomAdmin": true, "roomList": true, "room": room}))
	resp, err := l.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 && (method == "DeleteRoom" || method == "ListParticipants") {
		return nil
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("LiveKit %s: HTTP %d", method, resp.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(output)
	}
	return nil
}
func (l *LiveKit) Create(ctx context.Context, name string) error {
	return l.rpc(ctx, "CreateRoom", name, map[string]any{"name": name, "max_participants": 11, "empty_timeout": 1800, "departure_timeout": 60}, nil)
}
func (l *LiveKit) Delete(ctx context.Context, name string) error {
	return l.rpc(ctx, "DeleteRoom", name, map[string]string{"room": name}, nil)
}
func (l *LiveKit) Participants(ctx context.Context, name string) ([]Participant, error) {
	var result struct {
		Participants []Participant `json:"participants"`
	}
	err := l.rpc(ctx, "ListParticipants", name, map[string]string{"room": name}, &result)
	return result.Participants, err
}

// Remove only this application's namespace, leaving unrelated LiveKit rooms intact.
func (l *LiveKit) Cleanup(ctx context.Context) error {
	var result struct {
		Rooms []struct {
			Name string `json:"name"`
		} `json:"rooms"`
	}
	if err := l.rpc(ctx, "ListRooms", "", map[string]any{}, &result); err != nil {
		return err
	}
	for _, r := range result.Rooms {
		if len(r.Name) > 10 && r.Name[:10] == "broadcast-" {
			if err := l.Delete(ctx, r.Name); err != nil {
				return err
			}
		}
	}
	return nil
}
