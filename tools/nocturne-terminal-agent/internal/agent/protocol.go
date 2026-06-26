package agent

import "encoding/json"

type rawRequest struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Name      string          `json:"name"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type responseLine struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Ok        bool   `json:"ok"`
	Complete  bool   `json:"complete,omitempty"`
	Count     int    `json:"count,omitempty"`
	Error     string `json:"error,omitempty"`
}

type eventLine struct {
	Type      string    `json:"type"`
	Event     string    `json:"event"`
	Seq       uint64    `json:"seq,omitempty"`
	Timestamp string    `json:"timestamp,omitempty"`
	Data      string    `json:"data,omitempty"`
	Exit      *ExitInfo `json:"exit,omitempty"`
}

type historyPayload struct {
	Offset uint64 `json:"offset,omitempty"`
}

type writePayload struct {
	Data string `json:"data"`
}

type resizePayload struct {
	Cols        uint16 `json:"cols"`
	Rows        uint16 `json:"rows"`
	PixelWidth  uint16 `json:"pixel_width,omitempty"`
	PixelHeight uint16 `json:"pixel_height,omitempty"`
}

type renamePayload struct {
	Title string `json:"title"`
}

type transcriptChunk struct {
	Seq       uint64 `json:"seq"`
	Timestamp string `json:"timestamp"`
	Data      string `json:"data"`
}
