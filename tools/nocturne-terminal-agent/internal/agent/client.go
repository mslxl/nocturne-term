package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func ProbeSessionInfo(registry Registry) (ListedSession, error) {
	request := rawRequest{
		Type:      "request",
		RequestID: newRequestID(),
		Name:      "info",
	}
	conn, err := dialEndpoint(registry.Endpoint.Path)
	if err != nil {
		return ListedSession{}, fmt.Errorf("connect daemon endpoint: %w", err)
	}
	defer conn.Close()
	if err := writeRawRequest(conn, request); err != nil {
		return ListedSession{}, fmt.Errorf("write info request: %w", err)
	}
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		var response sessionInfoResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			return ListedSession{}, fmt.Errorf("decode info response: %w", err)
		}
		if response.Type != "response" || response.RequestID != request.RequestID {
			continue
		}
		if !response.Ok {
			if response.Error == "" {
				return ListedSession{}, fmt.Errorf("info request failed")
			}
			return ListedSession{}, fmt.Errorf("info request failed: %s", response.Error)
		}
		if response.Session.SessionID != registry.SessionID {
			return ListedSession{}, fmt.Errorf("info returned session_id %q for registry %q", response.Session.SessionID, registry.SessionID)
		}
		if response.Session.HostID != registry.HostID {
			return ListedSession{}, fmt.Errorf("info returned host_id %q for registry %q", response.Session.HostID, registry.HostID)
		}
		return response.Session, nil
	}
	if err := scanner.Err(); err != nil {
		return ListedSession{}, fmt.Errorf("read info response: %w", err)
	}
	return ListedSession{}, fmt.Errorf("info request did not return a response")
}

type sessionInfoResponse struct {
	Type      string        `json:"type"`
	RequestID string        `json:"request_id"`
	Ok        bool          `json:"ok"`
	Error     string        `json:"error,omitempty"`
	Session   ListedSession `json:"session"`
}

func ProxySessionRequest(writer io.Writer, sessionID string, name string, payload any, stream bool) error {
	return ProxySessionRequestWithInput(writer, nil, sessionID, name, payload, stream)
}

func ProxySessionRequestWithInput(writer io.Writer, input io.Reader, sessionID string, name string, payload any, stream bool) error {
	registry, err := LoadRegistry(sessionID)
	if err != nil {
		return err
	}
	request := rawRequest{
		Type:      "request",
		RequestID: newRequestID(),
		Name:      name,
	}
	if registry.Exit != nil {
		return writeExitedSessionClientResponse(writer, registry, request, name)
	}
	conn, err := dialEndpoint(registry.Endpoint.Path)
	if err != nil {
		return fmt.Errorf("connect daemon endpoint: %w", err)
	}
	defer conn.Close()

	if payload != nil {
		bytes, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode request payload: %w", err)
		}
		request.Payload = bytes
	}
	if err := writeRawRequest(conn, request); err != nil {
		return fmt.Errorf("write request: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopHeartbeat := make(chan struct{})
	heartbeatDone := make(chan struct{})
	if stream {
		go streamHeartbeat(conn, stopHeartbeat, heartbeatDone)
		defer func() {
			close(stopHeartbeat)
			<-heartbeatDone
		}()
	}
	proxyDone := make(chan error, 1)
	if stream && input != nil {
		go proxyInputRequests(ctx, conn, input, proxyDone)
	} else {
		close(proxyDone)
	}

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		text := scanner.Text()
		if isHeartbeatResponseLine(text) {
			continue
		}
		if _, err := fmt.Fprintln(writer, text); err != nil {
			return err
		}
		if !stream && isResponseLine(text) {
			return nil
		}
	}
	cancel()
	select {
	case err := <-proxyDone:
		if err != nil {
			return err
		}
	default:
	}
	return scanner.Err()
}

func writeExitedSessionClientResponse(writer io.Writer, registry Registry, request rawRequest, name string) error {
	switch name {
	case "history":
		return WriteSessionHistory(writer, registry.SessionID, request.RequestID)
	case "info":
		return json.NewEncoder(writer).Encode(map[string]any{
			"type":       "response",
			"request_id": request.RequestID,
			"ok":         true,
			"session":    listedSessionFromRegistry(registry),
		})
	case "close", "close_view", "close_run", "detach":
		return json.NewEncoder(writer).Encode(okResponse(request.RequestID))
	case "rename":
		var payload renamePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		if err := RenameRegistrySession(registry.SessionID, payload.Title); err != nil {
			return err
		}
		return json.NewEncoder(writer).Encode(okResponse(request.RequestID))
	case "title_change":
		var payload renamePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		if strings.TrimSpace(payload.Title) == "" {
			return errors.New("title is required")
		}
		return json.NewEncoder(writer).Encode(okResponse(request.RequestID))
	case "delete":
		if err := DeleteSessionFiles(registry.SessionID); err != nil {
			return err
		}
		return json.NewEncoder(writer).Encode(okResponse(request.RequestID))
	default:
		return json.NewEncoder(writer).Encode(responseLine{
			Type:      "response",
			RequestID: request.RequestID,
			Ok:        false,
			Error:     fmt.Sprintf("terminal session %s has exited", registry.SessionID),
		})
	}
}

func proxyInputRequests(ctx context.Context, conn net.Conn, input io.Reader, done chan<- error) {
	defer close(done)
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var request rawRequest
		if err := json.Unmarshal(line, &request); err != nil {
			done <- fmt.Errorf("decode proxied request: %w", err)
			return
		}
		if err := validateRequest(request); err != nil {
			done <- fmt.Errorf("validate proxied request: %w", err)
			return
		}
		if err := writeRawRequest(conn, request); err != nil {
			done <- fmt.Errorf("write proxied request: %w", err)
			return
		}
	}
	if err := scanner.Err(); err != nil {
		done <- fmt.Errorf("read proxied requests: %w", err)
	}
}

func writeRawRequest(conn net.Conn, request rawRequest) error {
	line, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	_, err = conn.Write(append(line, '\n'))
	return err
}

func streamHeartbeat(conn net.Conn, stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(clientHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			_ = writeRawRequest(conn, rawRequest{
				Type:      "request",
				RequestID: newHeartbeatRequestID(),
				Name:      "ping",
			})
		}
	}
}

func DeleteSession(writer io.Writer, sessionID string) error {
	registry, err := LoadRegistry(sessionID)
	if err != nil {
		return err
	}
	if registry.Exit == nil {
		var output discardWriter
		if err := ProxySessionRequest(output, sessionID, "close_run", nil, false); err != nil {
			if !isEndpointGoneError(err) {
				return fmt.Errorf("close live session before delete: %w", err)
			}
		} else if err := waitForRegistryExit(sessionID); err != nil {
			return err
		}
	}
	var lastErr error
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := DeleteSessionFiles(sessionID); err == nil {
			return json.NewEncoder(writer).Encode(map[string]any{
				"type":       "response",
				"request_id": newRequestID(),
				"ok":         true,
				"complete":   true,
			})
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return lastErr
}

func LoadRegistry(sessionID string) (Registry, error) {
	root, err := stateRoot()
	if err != nil {
		return Registry{}, err
	}
	path, err := registryPath(root, sessionID)
	if err != nil {
		return Registry{}, err
	}
	registry, err := readRegistry(path)
	if err != nil {
		return Registry{}, err
	}
	if filepath.Base(path) != registry.SessionID+".toml" {
		return Registry{}, fmt.Errorf("registry filename does not match session_id")
	}
	return registry, nil
}

func isResponseLine(text string) bool {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return false
	}
	return envelope.Type == "response"
}

func isHeartbeatResponseLine(text string) bool {
	var envelope struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return false
	}
	return envelope.Type == "response" && isHeartbeatRequestID(envelope.RequestID)
}

func newRequestID() string {
	return fmt.Sprintf("cli-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func newHeartbeatRequestID() string {
	return fmt.Sprintf("heartbeat-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func isHeartbeatRequestID(requestID string) bool {
	return len(requestID) > len("heartbeat-") && requestID[:len("heartbeat-")] == "heartbeat-"
}

func waitForRegistryExit(sessionID string) error {
	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		registry, err := LoadRegistry(sessionID)
		if err != nil {
			lastErr = err
		} else if registry.Exit != nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr != nil {
		return fmt.Errorf("wait for session exit registry: %w", lastErr)
	}
	return fmt.Errorf("session did not write exit registry before delete")
}

func isEndpointGoneError(err error) bool {
	if err == nil {
		return false
	}
	if os.IsNotExist(err) || errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "cannot find the file specified") ||
		strings.Contains(message, "no such file or directory") ||
		strings.Contains(message, "connection refused")
}

type discardWriter struct{}

func (discardWriter) Write(bytes []byte) (int, error) {
	return len(bytes), nil
}

var _ io.Writer = discardWriter{}
