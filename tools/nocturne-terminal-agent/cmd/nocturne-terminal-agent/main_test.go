package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStreamsUntilEOFOnlyForLiveSessionCommands(t *testing.T) {
	liveCommands := []string{"attach", "subscribe"}
	for _, command := range liveCommands {
		if !streamsUntilEOF(command) {
			t.Fatalf("%s should stream until EOF", command)
		}
	}

	finiteCommands := []string{"history", "info", "ping", "write", "resize", "close", "detach", "delete", "rename", "title_change"}
	for _, command := range finiteCommands {
		if streamsUntilEOF(command) {
			t.Fatalf("%s should stop after its response", command)
		}
	}
}

func TestRenameRequiresTitle(t *testing.T) {
	if err := run([]string{"client", "rename", "--session-id", "session-a"}, nil, nil); err == nil {
		t.Fatalf("rename without --title should fail")
	}
	if err := run([]string{"client", "rename", "--session-id", "session-a", "--title", ""}, nil, nil); err == nil {
		t.Fatalf("rename with empty --title should fail")
	}
}

func TestClientHistoryReadsExitedTranscriptWithoutDaemon(t *testing.T) {
	root := setStateRootForTest(t)

	const sessionID = "session-history-cli"
	data := base64.StdEncoding.EncodeToString([]byte("offline history"))
	registry := strings.Join([]string{
		`version = 1`,
		`session_id = "session-history-cli"`,
		`host_id = "host-a"`,
		`title = "History"`,
		`command = "bash"`,
		`cwd = "/workspace"`,
		`created_at = "2026-06-25T00:00:00Z"`,
		`agent_version = "0.1.0"`,
		`protocol_version = 1`,
		`cols = 80`,
		`rows = 24`,
		`transcript = "session-history-cli.ndjson"`,
		`[endpoint]`,
		`kind = "unix_socket"`,
		`path = "/tmp/does-not-exist.sock"`,
		`[exit]`,
		`code = 0`,
		`reason = "closed"`,
		`exited_at = "2026-06-25T00:00:01Z"`,
		``,
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, sessionID+".toml"), []byte(registry), 0o600); err != nil {
		t.Fatalf("write registry failed: %v", err)
	}
	transcript := `{"seq":7,"timestamp":"2026-06-25T00:00:01Z","data":"` + data + `"}` + "\n"
	if err := os.WriteFile(filepath.Join(root, sessionID+".ndjson"), []byte(transcript), 0o600); err != nil {
		t.Fatalf("write transcript failed: %v", err)
	}

	var output bytes.Buffer
	if err := run([]string{"client", "history", "--session-id", sessionID}, nil, &output); err != nil {
		t.Fatalf("client history should read exited transcript without dialing endpoint: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected history event and complete response, got %d:\n%s", len(lines), output.String())
	}
	var event struct {
		Type      string `json:"type"`
		Event     string `json:"event"`
		RequestID string `json:"request_id,omitempty"`
		Seq       uint64 `json:"seq"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &event); err != nil {
		t.Fatalf("decode history event failed: %v", err)
	}
	if event.Type != "event" || event.Event != "history" || event.RequestID != "" || event.Seq != 7 || event.Data != data {
		t.Fatalf("unexpected history event: %+v", event)
	}
	var response struct {
		Type     string `json:"type"`
		Ok       bool   `json:"ok"`
		Complete bool   `json:"complete"`
		Count    int    `json:"count"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &response); err != nil {
		t.Fatalf("decode history response failed: %v", err)
	}
	if response.Type != "response" || !response.Ok || !response.Complete || response.Count != 1 {
		t.Fatalf("unexpected history response: %+v", response)
	}
}

func TestClientPingOnExitedSessionDoesNotDialEndpoint(t *testing.T) {
	root := setStateRootForTest(t)

	const sessionID = "session-exited-ping-cli"
	writeExitedRegistryForTest(t, root, sessionID)

	for _, command := range []string{"ping", "subscribe"} {
		var output bytes.Buffer
		if err := run([]string{"client", command, "--session-id", sessionID}, nil, &output); err != nil {
			t.Fatalf("client %s should report exited session without dialing endpoint: %v", command, err)
		}

		var response struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Ok        bool   `json:"ok"`
			Error     string `json:"error"`
		}
		if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
			t.Fatalf("decode %s response failed: %v\n%s", command, err, output.String())
		}
		if response.Type != "response" || response.RequestID == "" || response.Ok {
			t.Fatalf("unexpected %s response envelope: %+v", command, response)
		}
		if !strings.Contains(response.Error, "has exited") {
			t.Fatalf("expected exited-session error for %s, got %q", command, response.Error)
		}
		if strings.Contains(response.Error, "connect daemon endpoint") || strings.Contains(response.Error, "does-not-exist") {
			t.Fatalf("exited-session error should not expose endpoint dial details: %q", response.Error)
		}
	}
}

func TestClientInfoOnExitedSessionDoesNotDialEndpoint(t *testing.T) {
	root := setStateRootForTest(t)

	const sessionID = "session-exited-info-cli"
	writeExitedRegistryForTest(t, root, sessionID)

	var output bytes.Buffer
	if err := run([]string{"client", "info", "--session-id", sessionID}, nil, &output); err != nil {
		t.Fatalf("client info should read exited registry without dialing endpoint: %v", err)
	}

	var response struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Ok        bool   `json:"ok"`
		Session   struct {
			SessionID string `json:"session_id"`
			Status    string `json:"status"`
			Exit      *struct {
				Reason string `json:"reason"`
			} `json:"exit"`
		} `json:"session"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &response); err != nil {
		t.Fatalf("decode info response failed: %v\n%s", err, output.String())
	}
	if response.Type != "response" || response.RequestID == "" || !response.Ok {
		t.Fatalf("unexpected info response envelope: %+v", response)
	}
	if response.Session.SessionID != sessionID || response.Session.Status != "exited" {
		t.Fatalf("unexpected exited session info: %+v", response.Session)
	}
	if response.Session.Exit == nil || response.Session.Exit.Reason != "closed" {
		t.Fatalf("expected exit metadata, got %+v", response.Session.Exit)
	}
}

func setStateRootForTest(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	if os.PathSeparator == '\\' {
		t.Setenv("LOCALAPPDATA", base)
		root := filepath.Join(base, "Nocturne", "terminal-sessions")
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatalf("create Windows state root failed: %v", err)
		}
		return root
	}
	t.Setenv("XDG_STATE_HOME", base)
	root := filepath.Join(base, "nocturne", "terminal-sessions")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("create XDG state root failed: %v", err)
	}
	return root
}

func writeExitedRegistryForTest(t *testing.T, root string, sessionID string) {
	t.Helper()
	registry := strings.Join([]string{
		`version = 1`,
		`session_id = "` + sessionID + `"`,
		`host_id = "host-a"`,
		`title = "Exited"`,
		`command = "bash"`,
		`cwd = "/workspace"`,
		`created_at = "2026-06-25T00:00:00Z"`,
		`agent_version = "0.1.0"`,
		`protocol_version = 1`,
		`cols = 80`,
		`rows = 24`,
		`transcript = "` + sessionID + `.ndjson"`,
		`[endpoint]`,
		`kind = "unix_socket"`,
		`path = "/tmp/does-not-exist.sock"`,
		`[exit]`,
		`code = 0`,
		`reason = "closed"`,
		`exited_at = "2026-06-25T00:00:01Z"`,
		``,
	}, "\n")
	if err := os.WriteFile(filepath.Join(root, sessionID+".toml"), []byte(registry), 0o600); err != nil {
		t.Fatalf("write registry failed: %v", err)
	}
}
