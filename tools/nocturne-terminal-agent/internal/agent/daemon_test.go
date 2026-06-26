package agent

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTranscriptTruncatesToCapKeepingNewestChunks(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	originalCap := transcriptMaxBytes
	transcriptMaxBytes = 280
	t.Cleanup(func() {
		transcriptMaxBytes = originalCap
	})

	registry := Registry{Transcript: "session-cap.ndjson"}
	file, err := os.OpenFile(filepath.Join(temp, registry.Transcript), os.O_CREATE|os.O_RDWR, transcriptFileMode)
	if err != nil {
		t.Fatalf("open transcript failed: %v", err)
	}
	if _, err := file.Seek(0, io.SeekEnd); err != nil {
		t.Fatalf("seek transcript failed: %v", err)
	}
	defer file.Close()
	state := newDaemonState(registry, newEchoPty(), file)

	state.recordOutput([]byte("chunk-one-abcdefghijklmnopqrstuvwxyz"))
	state.recordOutput([]byte("chunk-two-abcdefghijklmnopqrstuvwxyz"))
	state.recordOutput([]byte("chunk-three-abcdefghijklmnopqrstuvwxyz"))
	state.recordOutput([]byte("chunk-four-abcdefghijklmnopqrstuvwxyz"))
	state.transcriptMu.Lock()
	err = state.flushTranscriptLocked()
	state.transcriptMu.Unlock()
	if err != nil {
		t.Fatalf("flush transcript failed: %v", err)
	}

	chunks := readTranscriptChunks(t, filepath.Join(temp, registry.Transcript))
	if len(chunks) < 1 {
		t.Fatalf("expected retained transcript chunks")
	}
	firstData := decodeChunkData(t, chunks[0])
	lastData := decodeChunkData(t, chunks[len(chunks)-1])
	if strings.Contains(firstData, "chunk-one") {
		t.Fatalf("oldest chunk was retained after cap truncation: %q", firstData)
	}
	if !strings.Contains(lastData, "chunk-four") {
		t.Fatalf("newest chunk was not retained after cap truncation: %q", lastData)
	}
	info, err := os.Stat(filepath.Join(temp, registry.Transcript))
	if err != nil {
		t.Fatalf("stat transcript failed: %v", err)
	}
	if info.Size() > int64(transcriptMaxBytes) {
		t.Fatalf("transcript size %d exceeded cap %d", info.Size(), transcriptMaxBytes)
	}
}

func TestTranscriptClearScreenDropsHistoryBeforeClear(t *testing.T) {
	for _, clearSequence := range []string{
		"\x1b[2J\x1b[H",
		"\x1b[H\x1b[2J",
		"\x1b[H\x1b[J",
	} {
		t.Run(strings.ReplaceAll(clearSequence, "\x1b", "ESC"), func(t *testing.T) {
			temp := t.TempDir()
			setStateEnv(t, temp)

			registry := Registry{Transcript: "session-clear.ndjson"}
			file, err := os.OpenFile(filepath.Join(temp, registry.Transcript), os.O_CREATE|os.O_RDWR, transcriptFileMode)
			if err != nil {
				t.Fatalf("open transcript failed: %v", err)
			}
			if _, err := file.Seek(0, io.SeekEnd); err != nil {
				t.Fatalf("seek transcript failed: %v", err)
			}
			defer file.Close()
			state := newDaemonState(registry, newEchoPty(), file)

			state.recordOutput([]byte("before-clear"))
			state.recordOutput([]byte(clearSequence + "after-clear"))
			state.transcriptMu.Lock()
			err = state.flushTranscriptLocked()
			state.transcriptMu.Unlock()
			if err != nil {
				t.Fatalf("flush transcript failed: %v", err)
			}

			chunks := readTranscriptChunks(t, filepath.Join(temp, registry.Transcript))
			if len(chunks) != 1 {
				t.Fatalf("expected only post-clear transcript chunk, got %d: %+v", len(chunks), chunks)
			}
			data := decodeChunkData(t, chunks[0])
			if data != "after-clear" {
				t.Fatalf("unexpected retained transcript after clear: %q", data)
			}
		})
	}
}

func TestTranscriptClearScreenDropsHistoryWhenSequenceSpansChunks(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	registry := Registry{Transcript: "session-split-clear.ndjson"}
	file, err := os.OpenFile(filepath.Join(temp, registry.Transcript), os.O_CREATE|os.O_RDWR, transcriptFileMode)
	if err != nil {
		t.Fatalf("open transcript failed: %v", err)
	}
	defer file.Close()
	state := newDaemonState(registry, newEchoPty(), file)

	state.recordOutput([]byte("before-clear\x1b["))
	state.recordOutput([]byte("2Jafter-clear"))
	state.transcriptMu.Lock()
	err = state.flushTranscriptLocked()
	state.transcriptMu.Unlock()
	if err != nil {
		t.Fatalf("flush transcript failed: %v", err)
	}

	chunks := readTranscriptChunks(t, filepath.Join(temp, registry.Transcript))
	if len(chunks) != 1 {
		t.Fatalf("expected only post-clear transcript chunk, got %d: %+v", len(chunks), chunks)
	}
	data := decodeChunkData(t, chunks[0])
	if data != "after-clear" {
		t.Fatalf("unexpected retained transcript after split clear: %q", data)
	}
}

func TestAttachedClientTimesOutWithoutHeartbeat(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	withClientHeartbeatTiming(t, 20*time.Millisecond, 60*time.Millisecond, 10*time.Millisecond)

	registry := Registry{Transcript: "session-timeout.ndjson"}
	file, err := os.OpenFile(filepath.Join(temp, registry.Transcript), os.O_CREATE|os.O_RDWR, transcriptFileMode)
	if err != nil {
		t.Fatalf("open transcript failed: %v", err)
	}
	defer file.Close()
	state := newDaemonState(registry, newEchoPty(), file)

	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	go state.handleConn(serverConn)
	reader := bufio.NewReader(clientConn)

	writeRequest(t, clientConn, "attach-timeout", "attach", nil)
	expectResponse(t, reader, "attach-timeout")

	if err := clientConn.SetReadDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		t.Fatalf("set read deadline failed: %v", err)
	}
	_, err = reader.ReadString('\n')
	if err == nil {
		t.Fatalf("expected idle attached client connection to be closed")
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		t.Fatalf("idle attached client was not closed before read deadline")
	}

	state.clientsMu.Lock()
	clientCount := len(state.clients)
	state.clientsMu.Unlock()
	if clientCount != 0 {
		t.Fatalf("timed-out client was not removed, got %d clients", clientCount)
	}
}

func TestStreamProxyHeartbeatKeepsSubscriptionAlive(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	withClientHeartbeatTiming(t, 20*time.Millisecond, 70*time.Millisecond, 10*time.Millisecond)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-heartbeat-proxy",
		HostID:    "host-a",
		Title:     "Heartbeat proxy",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-heartbeat-proxy")
	conn := waitForConn(t, registry.Endpoint.Path)
	conn.Close()

	var output synchronizedBuffer
	proxyDone := make(chan error, 1)
	go func() {
		proxyDone <- ProxySessionRequest(&output, "session-heartbeat-proxy", "subscribe", nil, true)
	}()

	waitForString(t, &output, `"request_id":"cli-`)
	time.Sleep(180 * time.Millisecond)

	var writeOutput bytes.Buffer
	payload := map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("still-alive"))}
	if err := ProxySessionRequest(&writeOutput, "session-heartbeat-proxy", "write", payload, false); err != nil {
		t.Fatalf("ProxySessionRequest write failed: %v", err)
	}
	waitForString(t, &output, `"event":"output"`)
	if strings.Contains(output.String(), `"request_id":"heartbeat-`) {
		t.Fatalf("stream proxy leaked internal heartbeat responses:\n%s", output.String())
	}

	var closeOutput bytes.Buffer
	if err := ProxySessionRequest(&closeOutput, "session-heartbeat-proxy", "close", nil, false); err != nil {
		t.Fatalf("ProxySessionRequest close failed: %v", err)
	}

	select {
	case err := <-proxyDone:
		if err != nil {
			t.Fatalf("stream proxy failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("stream proxy did not finish after session close")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after close")
	}
}

func TestStreamProxyForwardsInputRequestsOnSubscriptionConnection(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	withClientHeartbeatTiming(t, 20*time.Millisecond, 70*time.Millisecond, 10*time.Millisecond)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-stream-input-proxy",
		HostID:    "host-a",
		Title:     "Stream input proxy",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-stream-input-proxy")
	conn := waitForConn(t, registry.Endpoint.Path)
	conn.Close()

	inputReader, inputWriter := io.Pipe()
	var output synchronizedBuffer
	proxyDone := make(chan error, 1)
	go func() {
		proxyDone <- ProxySessionRequestWithInput(&output, inputReader, "session-stream-input-proxy", "subscribe", nil, true)
	}()

	waitForString(t, &output, `"request_id":"cli-`)
	writeRequest(t, inputWriter, "same-conn-write", "write", map[string]string{
		"data": base64.StdEncoding.EncodeToString([]byte("via-same-helper-connection")),
	})
	waitForString(t, &output, `"request_id":"same-conn-write"`)
	waitForString(t, &output, `"event":"output"`)
	if strings.Contains(output.String(), `"request_id":"heartbeat-`) {
		t.Fatalf("stream proxy leaked internal heartbeat responses:\n%s", output.String())
	}

	writeRequest(t, inputWriter, "same-conn-close", "close", nil)
	waitForString(t, &output, `"request_id":"same-conn-close"`)
	if err := inputWriter.Close(); err != nil {
		t.Fatalf("close proxy input failed: %v", err)
	}

	select {
	case err := <-proxyDone:
		if err != nil {
			t.Fatalf("stream proxy failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("stream proxy did not finish after proxied close")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after proxied close")
	}
}

func TestDaemonProtocolWritesTranscriptHistoryAndExitRegistry(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-protocol",
		HostID:    "host-a",
		Title:     "Protocol",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()

	registry := waitForRegistry(t, "session-protocol")
	conn := waitForConn(t, registry.Endpoint.Path)
	defer conn.Close()
	reader := bufio.NewReader(conn)

	writeRequest(t, conn, "attach-1", "attach", nil)
	expectResponse(t, reader, "attach-1")

	payload := map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("hello"))}
	writeRequest(t, conn, "write-1", "write", payload)
	expectResponse(t, reader, "write-1")
	output := expectEvent(t, reader, "output")
	if output.RequestID != "" {
		t.Fatalf("event must not include request_id: %+v", output)
	}
	if output.Data != base64.StdEncoding.EncodeToString([]byte("hello")) {
		t.Fatalf("unexpected output event data: %+v", output)
	}

	writeRequest(t, conn, "history-1", "history", nil)
	history := expectEvent(t, reader, "history")
	if history.Data != output.Data {
		t.Fatalf("history did not replay transcript chunk: %+v", history)
	}
	historyResponse := expectResponse(t, reader, "history-1")
	if !historyResponse.Complete || historyResponse.Count != 1 {
		t.Fatalf("history did not finish with complete summary: %+v", historyResponse)
	}

	writeRequest(t, conn, "close-1", "close", nil)
	expectResponse(t, reader, "close-1")
	expectEvent(t, reader, "exit")

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after close")
	}

	registry = waitForRegistry(t, "session-protocol")
	if registry.Exit == nil || registry.Exit.ExitedAt == "" {
		t.Fatalf("registry exit was not persisted: %+v", registry.Exit)
	}
}

func TestDaemonInfoReportsLiveAttachedCount(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	registry := Registry{
		Version:         1,
		SessionID:       "session-info-count",
		HostID:          "host-a",
		Title:           "Info count",
		Command:         "fake-shell",
		AgentVersion:    AgentVersion,
		ProtocolVersion: ProtocolVersion,
		Cols:            80,
		Rows:            24,
		Endpoint:        Endpoint{Path: "unused"},
		Transcript:      "session-info-count.ndjson",
	}
	file, err := os.OpenFile(filepath.Join(temp, registry.Transcript), os.O_CREATE|os.O_RDWR, transcriptFileMode)
	if err != nil {
		t.Fatalf("open transcript failed: %v", err)
	}
	defer file.Close()
	state := newDaemonState(registry, newEchoPty(), file)

	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	go state.handleConn(serverConn)
	reader := bufio.NewReader(clientConn)

	writeRequest(t, clientConn, "attach-count", "attach", nil)
	expectResponse(t, reader, "attach-count")
	writeRequest(t, clientConn, "info-count", "info", nil)

	line := readLine(t, reader)
	var response struct {
		Type      string        `json:"type"`
		RequestID string        `json:"request_id"`
		Ok        bool          `json:"ok"`
		Session   ListedSession `json:"session"`
	}
	if err := json.Unmarshal([]byte(line), &response); err != nil {
		t.Fatalf("decode info response %q: %v", line, err)
	}
	if response.Type != "response" || response.RequestID != "info-count" || !response.Ok {
		t.Fatalf("unexpected info response: %+v", response)
	}
	if response.Session.Status != "running" || response.Session.AttachedCount != 1 {
		t.Fatalf("info did not report live attached count: %+v", response.Session)
	}
}

func TestDaemonTitleChangePersistsRegistryTitle(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-title-change",
		HostID:    "host-a",
		Title:     "Initial title",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-title-change")
	conn := waitForConn(t, registry.Endpoint.Path)
	reader := bufio.NewReader(conn)

	writeRequest(t, conn, "title-1", "title_change", map[string]string{"title": "Editor: main.go"})
	expectResponse(t, reader, "title-1")
	updated := waitForRegistry(t, "session-title-change")
	if updated.Title != "Editor: main.go" {
		t.Fatalf("title_change did not persist registry title: %+v", updated)
	}

	writeRequest(t, conn, "rename-1", "rename", map[string]string{"title": "Build logs"})
	expectResponse(t, reader, "rename-1")
	updated = waitForRegistry(t, "session-title-change")
	if updated.Title != "Build logs" {
		t.Fatalf("rename did not persist registry title: %+v", updated)
	}

	writeRequest(t, conn, "close-title", "close", nil)
	expectResponse(t, reader, "close-title")
	if err := conn.Close(); err != nil {
		t.Fatalf("close client connection failed: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after close")
	}
}

func TestClientProxiesThroughRegistryEndpoint(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-client",
		HostID:    "host-a",
		Title:     "Client",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-client")
	conn := waitForConn(t, registry.Endpoint.Path)
	conn.Close()

	var output bytes.Buffer
	if err := ProxySessionRequest(&output, "session-client", "info", nil, false); err != nil {
		t.Fatalf("ProxySessionRequest info failed: %v", err)
	}
	if !strings.Contains(output.String(), `"request_id":"cli-`) {
		t.Fatalf("proxy did not generate request_id:\n%s", output.String())
	}
	if !strings.Contains(output.String(), `"session_id":"session-client"`) {
		t.Fatalf("proxy did not read session info through registry endpoint:\n%s", output.String())
	}

	output.Reset()
	if err := ProxySessionRequest(&output, "session-client", "close", nil, false); err != nil {
		t.Fatalf("ProxySessionRequest close failed: %v", err)
	}
	if !strings.Contains(output.String(), `"ok":true`) {
		t.Fatalf("close response missing ok:\n%s", output.String())
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after proxied close")
	}
}

func TestClientListProbesLiveDaemonStatusAndAttachedCount(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-list-live",
		HostID:    "host-a",
		Title:     "List live",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-list-live")
	conn := waitForConn(t, registry.Endpoint.Path)
	defer conn.Close()
	reader := bufio.NewReader(conn)

	writeRequest(t, conn, "attach-list", "attach", nil)
	expectResponse(t, reader, "attach-list")

	var output bytes.Buffer
	if err := WriteSessionList(&output, "host-a"); err != nil {
		t.Fatalf("WriteSessionList failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected session and complete lines, got %d:\n%s", len(lines), output.String())
	}
	var sessionLine struct {
		Type    string        `json:"type"`
		Session ListedSession `json:"session"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &sessionLine); err != nil {
		t.Fatalf("decode session line failed: %v", err)
	}
	if sessionLine.Session.Status != "running" || sessionLine.Session.AttachedCount != 1 {
		t.Fatalf("list did not probe live daemon state: %+v", sessionLine.Session)
	}

	writeRequest(t, conn, "detach-list", "detach", nil)
	expectResponse(t, reader, "detach-list")
	buf := make([]byte, 1)
	if _, err := conn.Read(buf); err == nil {
		t.Fatalf("expected detach to close the subscription connection")
	}
	conn.Close()
	conn = waitForConn(t, registry.Endpoint.Path)
	defer conn.Close()
	reader = bufio.NewReader(conn)
	writeRequest(t, conn, "close-list", "close", nil)
	expectResponse(t, reader, "close-list")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after close")
	}
}

func TestClientHistoryReadsExitedTranscriptWithoutDaemon(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-history-exited",
		HostID:    "host-a",
		Title:     "Exited history",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	registry, err := CreateInitialRegistry(spec)
	if err != nil {
		t.Fatalf("CreateInitialRegistry failed: %v", err)
	}
	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot failed: %v", err)
	}
	chunk := transcriptChunk{
		Seq:       42,
		Timestamp: "2026-06-25T00:00:00Z",
		Data:      base64.StdEncoding.EncodeToString([]byte("kept after exit")),
	}
	line, err := json.Marshal(chunk)
	if err != nil {
		t.Fatalf("marshal transcript chunk failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, registry.Transcript), append(line, '\n'), transcriptFileMode); err != nil {
		t.Fatalf("write transcript failed: %v", err)
	}
	exitCode := 0
	if err := MarkRegistryExited("session-history-exited", ExitInfo{
		Code:     &exitCode,
		Reason:   "closed",
		ExitedAt: "2026-06-25T00:00:01Z",
	}); err != nil {
		t.Fatalf("MarkRegistryExited failed: %v", err)
	}

	var output bytes.Buffer
	if err := WriteSessionHistory(&output, "session-history-exited", "history-1"); err != nil {
		t.Fatalf("WriteSessionHistory failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected one history event and one complete response, got %d:\n%s", len(lines), output.String())
	}
	history := expectHistoryLine(t, lines[0])
	if history.RequestID != "" {
		t.Fatalf("history event must not include request_id: %+v", history)
	}
	if history.Seq != 42 || history.Data != chunk.Data {
		t.Fatalf("unexpected offline history event: %+v", history)
	}
	var response responseLine
	if err := json.Unmarshal([]byte(lines[1]), &response); err != nil {
		t.Fatalf("decode complete response failed: %v", err)
	}
	if response.Type != "response" || response.RequestID != "history-1" || !response.Ok || !response.Complete || response.Count != 1 {
		t.Fatalf("unexpected complete response: %+v", response)
	}
}

func TestClientDeleteClosesLiveSessionAndRemovesFiles(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-delete-live",
		HostID:    "host-a",
		Title:     "Delete live",
		Command:   "fake-shell",
		Cwd:       "/workspace",
		Cols:      80,
		Rows:      24,
	}
	done := make(chan error, 1)
	go func() {
		done <- runDaemonWithStarter(spec, startEchoPty)
	}()
	registry := waitForRegistry(t, "session-delete-live")
	conn := waitForConn(t, registry.Endpoint.Path)
	conn.Close()

	var output bytes.Buffer
	if err := DeleteSession(&output, "session-delete-live"); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	if !strings.Contains(output.String(), `"ok":true`) {
		t.Fatalf("delete response missing ok:\n%s", output.String())
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("daemon did not exit after delete")
	}

	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "session-delete-live.toml")); !os.IsNotExist(err) {
		t.Fatalf("registry was not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, registry.Transcript)); !os.IsNotExist(err) {
		t.Fatalf("transcript was not removed: %v", err)
	}
}

func expectHistoryLine(t *testing.T, line string) struct {
	Type      string `json:"type"`
	Event     string `json:"event"`
	RequestID string `json:"request_id,omitempty"`
	Seq       uint64 `json:"seq"`
	Data      string `json:"data"`
} {
	t.Helper()
	var event struct {
		Type      string `json:"type"`
		Event     string `json:"event"`
		RequestID string `json:"request_id,omitempty"`
		Seq       uint64 `json:"seq"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("decode history line %q: %v", line, err)
	}
	if event.Type != "event" || event.Event != "history" {
		t.Fatalf("unexpected history event: %+v", event)
	}
	return event
}

func writeRequest(t *testing.T, writer io.Writer, requestID string, name string, payload any) {
	t.Helper()
	line := map[string]any{
		"type":       "request",
		"request_id": requestID,
		"name":       name,
	}
	if payload != nil {
		line["payload"] = payload
	}
	bytes, err := json.Marshal(line)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if _, err := writer.Write(append(bytes, '\n')); err != nil {
		t.Fatalf("write request: %v", err)
	}
}

func expectResponse(t *testing.T, reader *bufio.Reader, requestID string) responseLine {
	t.Helper()
	line := readLine(t, reader)
	var response responseLine
	if err := json.Unmarshal([]byte(line), &response); err != nil {
		t.Fatalf("decode response %q: %v", line, err)
	}
	if response.Type != "response" || response.RequestID != requestID || !response.Ok {
		t.Fatalf("unexpected response: %+v", response)
	}
	return response
}

func expectEvent(t *testing.T, reader *bufio.Reader, eventName string) struct {
	Type      string `json:"type"`
	Event     string `json:"event"`
	RequestID string `json:"request_id,omitempty"`
	Data      string `json:"data,omitempty"`
} {
	t.Helper()
	line := readLine(t, reader)
	var event struct {
		Type      string `json:"type"`
		Event     string `json:"event"`
		RequestID string `json:"request_id,omitempty"`
		Data      string `json:"data,omitempty"`
	}
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("decode event %q: %v", line, err)
	}
	if event.Type != "event" || event.Event != eventName {
		t.Fatalf("unexpected event: %+v", event)
	}
	return event
}

func readLine(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read line: %v", err)
	}
	return strings.TrimSpace(line)
}

func waitForRegistry(t *testing.T, sessionID string) Registry {
	t.Helper()
	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot: %v", err)
	}
	path := filepath.Join(root, sessionID+".toml")
	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		registry, err := readRegistry(path)
		if err == nil {
			return registry
		}
		lastErr = err
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("registry not readable: %v", lastErr)
	return Registry{}
}

func waitForConn(t *testing.T, endpoint string) net.Conn {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := dialEndpoint(endpoint)
		if err == nil {
			return conn
		}
		lastErr = err
		time.Sleep(25 * time.Millisecond)
	}
	if runtime.GOOS == "windows" {
		t.Fatalf("named pipe did not become ready: %v", lastErr)
	}
	t.Fatalf("unix socket did not become ready: %v", lastErr)
	return nil
}

func readTranscriptChunks(t *testing.T, path string) []transcriptChunk {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open transcript failed: %v", err)
	}
	defer file.Close()

	var chunks []transcriptChunk
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var chunk transcriptChunk
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			t.Fatalf("decode transcript chunk %q: %v", scanner.Text(), err)
		}
		chunks = append(chunks, chunk)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan transcript failed: %v", err)
	}
	return chunks
}

func decodeChunkData(t *testing.T, chunk transcriptChunk) string {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil {
		t.Fatalf("decode chunk data failed: %v", err)
	}
	return string(data)
}

func withClientHeartbeatTiming(t *testing.T, interval time.Duration, timeout time.Duration, checkInterval time.Duration) {
	t.Helper()
	originalInterval := clientHeartbeatInterval
	originalTimeout := clientHeartbeatTimeout
	originalCheckInterval := clientHeartbeatCheckInterval
	clientHeartbeatInterval = interval
	clientHeartbeatTimeout = timeout
	clientHeartbeatCheckInterval = checkInterval
	t.Cleanup(func() {
		clientHeartbeatInterval = originalInterval
		clientHeartbeatTimeout = originalTimeout
		clientHeartbeatCheckInterval = originalCheckInterval
	})
}

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *synchronizedBuffer) Write(bytes []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(bytes)
}

func (buffer *synchronizedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func waitForString(t *testing.T, buffer *synchronizedBuffer, needle string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buffer.String(), needle) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q in:\n%s", needle, buffer.String())
}
