package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

const transcriptFlushInterval = 2 * time.Second
const transcriptFlushBytes = 64 * 1024
const defaultTranscriptMaxBytes int64 = 64 * 1024 * 1024
const defaultClientHeartbeatInterval = 30 * time.Second
const defaultClientHeartbeatTimeout = 90 * time.Second
const defaultClientHeartbeatCheckInterval = 5 * time.Second

var transcriptMaxBytes = defaultTranscriptMaxBytes
var clientHeartbeatInterval = defaultClientHeartbeatInterval
var clientHeartbeatTimeout = defaultClientHeartbeatTimeout
var clientHeartbeatCheckInterval = defaultClientHeartbeatCheckInterval

func RunDaemon(spec LaunchSpec) error {
	return runDaemonWithStarter(spec, defaultPtyStarter)
}

func runDaemonWithStarter(spec LaunchSpec, starter ptyStarter) error {
	registry, err := CreateInitialRegistry(spec)
	if err != nil {
		return err
	}
	transcript, err := OpenTranscript(registry)
	if err != nil {
		return err
	}
	defer transcript.Close()

	process, err := starter(spec)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	state := newDaemonState(registry, process, transcript)
	listener, err := listenEndpoint(registry.Endpoint.Path)
	if err != nil {
		return fmt.Errorf("listen daemon endpoint: %w", err)
	}
	defer listener.Close()

	go state.readPtyOutput(ctx)
	go state.waitForExit(ctx, listener)

	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-state.done:
				return state.exitErr()
			default:
				return fmt.Errorf("accept daemon client: %w", err)
			}
		}
		go state.handleConn(conn)
	}
}

type daemonState struct {
	registry Registry
	process  ptyProcess

	transcript     *bufio.Writer
	transcriptFile *os.File
	transcriptMu   sync.Mutex
	unflushedBytes int
	flushScheduled bool
	transcriptTail []byte

	seq uint64
	mu  sync.Mutex

	clientsMu sync.Mutex
	clients   map[*daemonClient]struct{}

	done     chan struct{}
	doneOnce sync.Once
	errMu    sync.Mutex
	err      error
}

type daemonClient struct {
	conn net.Conn
	send chan eventLine
	mu   sync.Mutex

	lifecycleMu sync.Mutex
	closeOnce   sync.Once
	sendOnce    sync.Once
	closed      chan struct{}
	attached    bool
	lastRequest time.Time
}

func newDaemonState(registry Registry, process ptyProcess, transcriptFile *os.File) *daemonState {
	return &daemonState{
		registry:       registry,
		process:        process,
		transcript:     bufio.NewWriterSize(transcriptFile, transcriptFlushBytes),
		transcriptFile: transcriptFile,
		clients:        map[*daemonClient]struct{}{},
		done:           make(chan struct{}),
	}
}

func (state *daemonState) handleConn(conn net.Conn) {
	client := newDaemonClient(conn)
	defer state.closeClient(client)

	go client.writeEvents()
	go state.monitorClientHeartbeat(client)

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		client.markRequestSeen(time.Now())
		var request rawRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			client.writeResponse(responseLine{Type: "response", Ok: false, Error: err.Error()})
			continue
		}
		if err := validateRequest(request); err != nil {
			client.writeResponse(responseLine{
				Type:      "response",
				RequestID: request.RequestID,
				Ok:        false,
				Error:     err.Error(),
			})
			continue
		}
		if err := state.handleRequest(client, request); err != nil {
			client.writeResponse(responseLine{
				Type:      "response",
				RequestID: request.RequestID,
				Ok:        false,
				Error:     err.Error(),
			})
		}
	}
}

func newDaemonClient(conn net.Conn) *daemonClient {
	return &daemonClient{
		conn:        conn,
		send:        make(chan eventLine, 64),
		closed:      make(chan struct{}),
		lastRequest: time.Now(),
	}
}

func validateRequest(request rawRequest) error {
	if request.Type != "request" {
		return errors.New("request type must be request")
	}
	if request.RequestID == "" {
		return errors.New("request_id is required")
	}
	if request.Name == "" {
		return errors.New("request name is required")
	}
	return nil
}

func (state *daemonState) handleRequest(client *daemonClient, request rawRequest) error {
	switch request.Name {
	case "ping":
		client.writeResponse(okResponse(request.RequestID))
	case "attach", "subscribe":
		state.addClient(client)
		client.writeResponse(okResponse(request.RequestID))
	case "detach":
		state.detachClient(client)
		client.writeResponse(okResponse(request.RequestID))
		client.close()
	case "info":
		return client.writeJSON(map[string]any{
			"type":       "response",
			"request_id": request.RequestID,
			"ok":         true,
			"session":    state.liveListedSession(),
		})
	case "history":
		count, err := state.writeHistory(client)
		if err != nil {
			return err
		}
		client.writeResponse(responseLine{Type: "response", RequestID: request.RequestID, Ok: true, Complete: true, Count: count})
	case "write":
		var payload writePayload
		if err := decodePayload(request.Payload, &payload); err != nil {
			return err
		}
		bytes, err := base64.StdEncoding.DecodeString(payload.Data)
		if err != nil {
			return fmt.Errorf("decode write payload: %w", err)
		}
		if _, err := state.process.Write(bytes); err != nil {
			return fmt.Errorf("write PTY: %w", err)
		}
		client.writeResponse(okResponse(request.RequestID))
	case "resize":
		var payload resizePayload
		if err := decodePayload(request.Payload, &payload); err != nil {
			return err
		}
		if payload.Cols == 0 || payload.Rows == 0 {
			return errors.New("resize cols and rows must be positive")
		}
		if err := state.process.Resize(ptySize{
			Cols:        payload.Cols,
			Rows:        payload.Rows,
			PixelWidth:  payload.PixelWidth,
			PixelHeight: payload.PixelHeight,
		}); err != nil {
			return fmt.Errorf("resize PTY: %w", err)
		}
		client.writeResponse(okResponse(request.RequestID))
	case "rename", "title_change":
		var payload renamePayload
		if err := decodePayload(request.Payload, &payload); err != nil {
			return err
		}
		if payload.Title == "" {
			return errors.New("title is required")
		}
		state.registry.Title = payload.Title
		if err := rewriteRegistry(state.registry); err != nil {
			return err
		}
		client.writeResponse(okResponse(request.RequestID))
	case "close_view":
		err := state.closeView(client)
		client.writeResponse(okResponse(request.RequestID))
		client.close()
		return err
	case "close", "close_run":
		err := state.closeRun()
		client.writeResponse(okResponse(request.RequestID))
		return err
	default:
		return fmt.Errorf("unsupported request %q", request.Name)
	}
	return nil
}

func (state *daemonState) closeRun() error {
	return state.process.Close()
}

func (state *daemonState) closeView(client *daemonClient) error {
	state.detachClient(client)
	if state.pingAttachedClientsAndCountReachable() > 0 {
		return nil
	}
	return state.closeRun()
}

func (state *daemonState) liveListedSession() ListedSession {
	session := listedSessionFromRegistry(state.registry)
	session.Status = "running"
	session.AttachedCount = state.attachedClientCount()
	return session
}

func (state *daemonState) attachedClientCount() int {
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	count := 0
	for client := range state.clients {
		if client.isAttached() {
			count++
		}
	}
	return count
}

func (state *daemonState) pingAttachedClientsAndCountReachable() int {
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	count := 0
	for client := range state.clients {
		if !client.isAttached() {
			delete(state.clients, client)
			continue
		}
		if err := client.writeJSON(okResponse(newHeartbeatRequestID())); err != nil {
			delete(state.clients, client)
			client.close()
			client.closeSend()
			continue
		}
		count++
	}
	return count
}

func okResponse(requestID string) responseLine {
	return responseLine{Type: "response", RequestID: requestID, Ok: true}
}

func decodePayload(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return errors.New("payload is required")
	}
	return json.Unmarshal(raw, target)
}

func (state *daemonState) readPtyOutput(ctx context.Context) {
	buffer := make([]byte, 8192)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		read, err := state.process.Read(buffer)
		if read > 0 {
			state.recordOutput(buffer[:read])
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				state.setExitErr(fmt.Errorf("read PTY output: %w", err))
			}
			return
		}
	}
}

func (state *daemonState) recordOutput(bytes []byte) {
	state.mu.Lock()
	seq := state.seq
	state.seq += uint64(len(bytes))
	state.mu.Unlock()

	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	data := base64.StdEncoding.EncodeToString(bytes)

	transcriptBytes := bytes
	transcriptSeq := seq
	if suffix, offset, ok := state.transcriptBytesAfterClear(bytes); ok {
		if err := state.clearTranscript(); err != nil {
			state.setExitErr(err)
			transcriptBytes = nil
		} else {
			transcriptBytes = suffix
			transcriptSeq = seq + uint64(offset)
		}
	}
	state.rememberTranscriptTail(bytes)

	if len(transcriptBytes) > 0 {
		chunk := transcriptChunk{
			Seq:       transcriptSeq,
			Timestamp: timestamp,
			Data:      base64.StdEncoding.EncodeToString(transcriptBytes),
		}
		if err := state.appendTranscript(chunk); err != nil {
			state.setExitErr(err)
		}
	}
	state.broadcast(eventLine{
		Type:      "event",
		Event:     "output",
		Seq:       seq,
		Timestamp: timestamp,
		Data:      data,
	})
}

func (state *daemonState) transcriptBytesAfterClear(output []byte) ([]byte, int, bool) {
	combined := append(append([]byte(nil), state.transcriptTail...), output...)
	suffix, offset, ok := transcriptBytesAfterClear(combined)
	if !ok || offset <= len(state.transcriptTail) {
		return nil, 0, false
	}
	outputOffset := offset - len(state.transcriptTail)
	return suffix, outputOffset, true
}

func (state *daemonState) rememberTranscriptTail(output []byte) {
	const maxClearSequenceLength = 6
	const maxCursorHomeLength = 16
	maxTail := maxClearSequenceLength + maxCursorHomeLength
	combined := append(append([]byte(nil), state.transcriptTail...), output...)
	if len(combined) > maxTail {
		combined = combined[len(combined)-maxTail:]
	}
	state.transcriptTail = combined
}

func (state *daemonState) appendTranscript(chunk transcriptChunk) error {
	line, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	state.transcriptMu.Lock()
	defer state.transcriptMu.Unlock()
	if _, err := state.transcript.Write(line); err != nil {
		return fmt.Errorf("write transcript chunk: %w", err)
	}
	if err := state.transcript.WriteByte('\n'); err != nil {
		return fmt.Errorf("write transcript newline: %w", err)
	}
	state.unflushedBytes += len(line) + 1
	if state.unflushedBytes >= transcriptFlushBytes {
		return state.flushTranscriptLocked()
	}
	if state.flushScheduled {
		return nil
	}
	state.flushScheduled = true
	time.AfterFunc(transcriptFlushInterval, func() {
		state.transcriptMu.Lock()
		defer state.transcriptMu.Unlock()
		_ = state.flushTranscriptLocked()
	})
	return nil
}

func (state *daemonState) flushTranscriptLocked() error {
	if state.unflushedBytes == 0 {
		return nil
	}
	if err := state.transcript.Flush(); err != nil {
		return fmt.Errorf("flush transcript: %w", err)
	}
	if err := state.transcriptFile.Sync(); err != nil {
		return fmt.Errorf("sync transcript: %w", err)
	}
	state.unflushedBytes = 0
	state.flushScheduled = false
	if err := state.enforceTranscriptCapLocked(); err != nil {
		return err
	}
	return nil
}

func (state *daemonState) enforceTranscriptCapLocked() error {
	if transcriptMaxBytes <= 0 {
		return nil
	}
	info, err := state.transcriptFile.Stat()
	if err != nil {
		return fmt.Errorf("stat transcript: %w", err)
	}
	if info.Size() <= transcriptMaxBytes {
		return nil
	}
	if _, err := state.transcriptFile.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek transcript: %w", err)
	}
	bytes, err := io.ReadAll(state.transcriptFile)
	if err != nil {
		return fmt.Errorf("read transcript for cap: %w", err)
	}
	retained := retainTranscriptTail(bytes, transcriptMaxBytes)
	if err := state.rewriteTranscriptLocked(retained); err != nil {
		return err
	}
	return nil
}

func (state *daemonState) clearTranscript() error {
	state.transcriptMu.Lock()
	defer state.transcriptMu.Unlock()
	if err := state.flushTranscriptLocked(); err != nil {
		return err
	}
	return state.rewriteTranscriptLocked(nil)
}

func (state *daemonState) rewriteTranscriptLocked(bytes []byte) error {
	if err := state.transcriptFile.Truncate(0); err != nil {
		return fmt.Errorf("truncate transcript: %w", err)
	}
	if _, err := state.transcriptFile.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek transcript: %w", err)
	}
	if len(bytes) > 0 {
		if _, err := state.transcriptFile.Write(bytes); err != nil {
			return fmt.Errorf("rewrite transcript: %w", err)
		}
	}
	if err := state.transcriptFile.Sync(); err != nil {
		return fmt.Errorf("sync transcript: %w", err)
	}
	state.transcript.Reset(state.transcriptFile)
	state.unflushedBytes = 0
	state.flushScheduled = false
	return nil
}

func retainTranscriptTail(contents []byte, maxBytes int64) []byte {
	if int64(len(contents)) <= maxBytes {
		return contents
	}
	start := len(contents) - int(maxBytes)
	if start < 0 {
		start = 0
	}
	if newline := bytes.IndexByte(contents[start:], '\n'); newline >= 0 {
		start += newline + 1
	}
	if start >= len(contents) {
		return nil
	}
	retained := append([]byte(nil), contents[start:]...)
	return retained
}

func transcriptBytesAfterClear(output []byte) ([]byte, int, bool) {
	type clearSequence struct {
		bytes              []byte
		requiresCursorHome bool
		allowsTrailingHome bool
	}
	clearSequences := []clearSequence{
		{bytes: []byte("\x1b[2J"), allowsTrailingHome: true},
		{bytes: []byte("\x1b[3J"), allowsTrailingHome: true},
		{bytes: []byte("\x1bc")},
		{bytes: []byte("\x1b[J"), requiresCursorHome: true},
		{bytes: []byte("\x1b[0J"), requiresCursorHome: true},
		{bytes: []byte("\x1b[;J"), requiresCursorHome: true},
	}
	clearStart := -1
	clearEnd := 0
	for _, sequence := range clearSequences {
		index := bytes.LastIndex(output, sequence.bytes)
		if index < 0 {
			continue
		}
		if sequence.requiresCursorHome && !hasCursorHomeImmediatelyBefore(output[:index]) {
			continue
		}
		if index > clearStart {
			clearStart = index
			clearEnd = index + len(sequence.bytes)
			if sequence.allowsTrailingHome {
				clearEnd += cursorHomeSequenceLength(output[clearEnd:])
			}
		}
	}
	if clearStart < 0 {
		return nil, 0, false
	}
	return output[clearEnd:], clearEnd, true
}

func hasCursorHomeImmediatelyBefore(output []byte) bool {
	for _, sequence := range [][]byte{
		[]byte("\x1b[H"),
		[]byte("\x1b[;H"),
		[]byte("\x1b[1;1H"),
		[]byte("\x1b[f"),
		[]byte("\x1b[;f"),
		[]byte("\x1b[1;1f"),
	} {
		if bytes.HasSuffix(output, sequence) {
			return true
		}
	}
	return false
}

func cursorHomeSequenceLength(output []byte) int {
	if len(output) < 3 || output[0] != '\x1b' || output[1] != '[' {
		return 0
	}
	index := 2
	for index < len(output) {
		value := output[index]
		if value == 'H' || value == 'f' {
			return index + 1
		}
		if (value >= '0' && value <= '9') || value == ';' {
			index++
			continue
		}
		return 0
	}
	return 0
}

func (state *daemonState) writeHistory(client *daemonClient) (int, error) {
	state.transcriptMu.Lock()
	err := state.flushTranscriptLocked()
	state.transcriptMu.Unlock()
	if err != nil {
		return 0, err
	}
	root, err := stateRoot()
	if err != nil {
		return 0, err
	}
	path, err := safeTranscriptPath(root, state.registry.Transcript)
	if err != nil {
		return 0, err
	}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("read transcript: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	count := 0
	for scanner.Scan() {
		var chunk transcriptChunk
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			return count, fmt.Errorf("decode transcript chunk: %w", err)
		}
		client.writeEvent(eventLine{
			Type:      "event",
			Event:     "history",
			Seq:       chunk.Seq,
			Timestamp: chunk.Timestamp,
			Data:      chunk.Data,
		})
		count++
	}
	return count, scanner.Err()
}

func safeTranscriptPath(root string, transcript string) (string, error) {
	if err := validateTranscriptPath(transcript); err != nil {
		return "", err
	}
	return root + string(os.PathSeparator) + transcript, nil
}

func (state *daemonState) waitForExit(ctx context.Context, listener daemonListener) {
	exit, err := state.process.Wait(ctx)
	if err != nil {
		state.setExitErr(fmt.Errorf("wait PTY: %w", err))
		exit.Reason = err.Error()
	}
	exit.ExitedAt = time.Now().UTC().Format(time.RFC3339Nano)

	state.transcriptMu.Lock()
	if flushErr := state.flushTranscriptLocked(); flushErr != nil {
		state.setExitErr(flushErr)
	}
	state.transcriptMu.Unlock()
	if err := MarkRegistryExited(state.registry.SessionID, exit); err != nil {
		state.setExitErr(fmt.Errorf("mark registry exited: %w", err))
	}
	state.registry.Exit = &exit
	state.broadcast(eventLine{Type: "event", Event: "exit", Exit: &exit})
	state.finishClientsAfterExit()
	state.doneOnce.Do(func() {
		close(state.done)
	})
	_ = listener.Close()
}

func (state *daemonState) addClient(client *daemonClient) {
	client.markAttached()
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	state.clients[client] = struct{}{}
}

func (state *daemonState) detachClient(client *daemonClient) {
	client.markDetached()
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	delete(state.clients, client)
}

func (state *daemonState) closeClient(client *daemonClient) {
	client.close()
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	delete(state.clients, client)
	client.closeSend()
}

func (state *daemonState) finishClientsAfterExit() {
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	for client := range state.clients {
		delete(state.clients, client)
		client.closeSend()
	}
}

func (state *daemonState) broadcast(event eventLine) {
	state.clientsMu.Lock()
	defer state.clientsMu.Unlock()
	for client := range state.clients {
		select {
		case client.send <- event:
		default:
			delete(state.clients, client)
			client.close()
			client.closeSend()
		}
	}
}

func (state *daemonState) setExitErr(err error) {
	state.errMu.Lock()
	defer state.errMu.Unlock()
	if state.err == nil {
		state.err = err
	}
}

func (state *daemonState) exitErr() error {
	state.errMu.Lock()
	defer state.errMu.Unlock()
	return state.err
}

func (client *daemonClient) writeEvents() {
	defer client.close()
	for event := range client.send {
		client.writeEvent(event)
	}
}

func (client *daemonClient) writeEvent(event eventLine) {
	_ = client.writeJSON(event)
}

func (client *daemonClient) writeResponse(response responseLine) {
	_ = client.writeJSON(response)
}

func (client *daemonClient) writeJSON(value any) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if _, err := client.conn.Write(line); err != nil {
		client.close()
		return err
	}
	if _, err := client.conn.Write([]byte("\n")); err != nil {
		client.close()
		return err
	}
	return nil
}

func (state *daemonState) monitorClientHeartbeat(client *daemonClient) {
	ticker := time.NewTicker(clientHeartbeatCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-client.closed:
			return
		case <-state.done:
			return
		case <-ticker.C:
			if !client.isAttached() {
				continue
			}
			if time.Since(client.lastRequestSeen()) <= clientHeartbeatTimeout {
				continue
			}
			state.closeClient(client)
			return
		}
	}
}

func (client *daemonClient) markAttached() {
	client.lifecycleMu.Lock()
	defer client.lifecycleMu.Unlock()
	client.attached = true
	client.lastRequest = time.Now()
}

func (client *daemonClient) markDetached() {
	client.lifecycleMu.Lock()
	defer client.lifecycleMu.Unlock()
	client.attached = false
}

func (client *daemonClient) isAttached() bool {
	client.lifecycleMu.Lock()
	defer client.lifecycleMu.Unlock()
	return client.attached
}

func (client *daemonClient) markRequestSeen(timestamp time.Time) {
	client.lifecycleMu.Lock()
	defer client.lifecycleMu.Unlock()
	client.lastRequest = timestamp
}

func (client *daemonClient) lastRequestSeen() time.Time {
	client.lifecycleMu.Lock()
	defer client.lifecycleMu.Unlock()
	return client.lastRequest
}

func (client *daemonClient) close() {
	client.closeOnce.Do(func() {
		close(client.closed)
		_ = client.conn.Close()
	})
}

func (client *daemonClient) closeSend() {
	client.sendOnce.Do(func() {
		close(client.send)
	})
}

func rewriteRegistry(registry Registry) error {
	root, err := stateRoot()
	if err != nil {
		return err
	}
	return writeRegistryAtomic(root, registry)
}
