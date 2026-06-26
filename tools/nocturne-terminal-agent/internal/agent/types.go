package agent

const (
	AgentVersion    = "0.1.0"
	ProtocolVersion = 1
)

type LaunchSpec struct {
	Version     int               `json:"version"`
	SessionID   string            `json:"session_id"`
	HostID      string            `json:"host_id"`
	Title       string            `json:"title"`
	Command     string            `json:"command"`
	Args        []string          `json:"args,omitempty"`
	Cwd         string            `json:"cwd"`
	Env         map[string]string `json:"env,omitempty"`
	Cols        uint16            `json:"cols"`
	Rows        uint16            `json:"rows"`
	PixelWidth  uint16            `json:"pixel_width,omitempty"`
	PixelHeight uint16            `json:"pixel_height,omitempty"`
}

type Registry struct {
	Version         int       `toml:"version"`
	SessionID       string    `toml:"session_id"`
	HostID          string    `toml:"host_id"`
	Title           string    `toml:"title"`
	Command         string    `toml:"command"`
	Cwd             string    `toml:"cwd"`
	CreatedAt       string    `toml:"created_at"`
	AgentVersion    string    `toml:"agent_version"`
	ProtocolVersion int       `toml:"protocol_version"`
	Cols            uint16    `toml:"cols"`
	Rows            uint16    `toml:"rows"`
	PixelWidth      uint16    `toml:"pixel_width,omitempty"`
	PixelHeight     uint16    `toml:"pixel_height,omitempty"`
	Endpoint        Endpoint  `toml:"endpoint"`
	Transcript      string    `toml:"transcript"`
	Exit            *ExitInfo `toml:"exit,omitempty"`
}

type Endpoint struct {
	Kind string `toml:"kind"`
	Path string `toml:"path"`
}

type ExitInfo struct {
	Code     *int   `toml:"code,omitempty"`
	Signal   string `toml:"signal,omitempty"`
	Reason   string `toml:"reason,omitempty"`
	ExitedAt string `toml:"exited_at"`
}

type ListedSession struct {
	SessionID       string    `json:"session_id"`
	HostID          string    `json:"host_id"`
	Title           string    `json:"title"`
	Command         string    `json:"command"`
	Cwd             string    `json:"cwd"`
	AgentVersion    string    `json:"agent_version"`
	ProtocolVersion int       `json:"protocol_version"`
	Cols            uint16    `json:"cols"`
	Rows            uint16    `json:"rows"`
	PixelWidth      uint16    `json:"pixel_width,omitempty"`
	PixelHeight     uint16    `json:"pixel_height,omitempty"`
	Endpoint        Endpoint  `json:"endpoint"`
	Transcript      string    `json:"transcript"`
	Status          string    `json:"status"`
	AttachedCount   int       `json:"attached_count"`
	Exit            *ExitInfo `json:"exit,omitempty"`
}
