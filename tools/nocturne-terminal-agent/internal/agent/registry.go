package agent

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

const registryFileMode os.FileMode = 0o600
const registryDirMode os.FileMode = 0o700
const transcriptFileMode os.FileMode = 0o600

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func WriteInitialRegistry(spec LaunchSpec) error {
	_, err := CreateInitialRegistry(spec)
	return err
}

func CreateInitialRegistry(spec LaunchSpec) (Registry, error) {
	if err := validateLaunchSpec(spec); err != nil {
		return Registry{}, err
	}
	root, err := stateRoot()
	if err != nil {
		return Registry{}, err
	}
	if err := os.MkdirAll(root, registryDirMode); err != nil {
		return Registry{}, fmt.Errorf("create registry directory: %w", err)
	}
	endpoint, err := endpointForSession(spec.SessionID)
	if err != nil {
		return Registry{}, fmt.Errorf("resolve daemon endpoint: %w", err)
	}
	registry := Registry{
		Version:         1,
		SessionID:       spec.SessionID,
		HostID:          spec.HostID,
		Title:           spec.Title,
		Command:         spec.Command,
		Cwd:             spec.Cwd,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		AgentVersion:    AgentVersion,
		ProtocolVersion: ProtocolVersion,
		Cols:            spec.Cols,
		Rows:            spec.Rows,
		PixelWidth:      spec.PixelWidth,
		PixelHeight:     spec.PixelHeight,
		Endpoint: Endpoint{
			Kind: endpointKind(),
			Path: endpoint,
		},
		Transcript: transcriptName(spec.SessionID),
	}
	if err := writeRegistryAtomic(root, registry); err != nil {
		return Registry{}, err
	}
	return registry, nil
}

func MarkRegistryExited(sessionID string, exit ExitInfo) error {
	root, err := stateRoot()
	if err != nil {
		return err
	}
	path, err := registryPath(root, sessionID)
	if err != nil {
		return err
	}
	registry, err := readRegistry(path)
	if err != nil {
		return err
	}
	registry.Exit = &exit
	return writeRegistryAtomic(root, registry)
}

func OpenTranscript(registry Registry) (*os.File, error) {
	root, err := stateRoot()
	if err != nil {
		return nil, err
	}
	if err := validateTranscriptPath(registry.Transcript); err != nil {
		return nil, err
	}
	path := filepath.Join(root, filepath.Clean(registry.Transcript))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, transcriptFileMode)
	if err != nil {
		return nil, fmt.Errorf("open transcript: %w", err)
	}
	if _, err := file.Seek(0, io.SeekEnd); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("seek transcript end: %w", err)
	}
	return file, nil
}

func DeleteSessionFiles(sessionID string) error {
	root, err := stateRoot()
	if err != nil {
		return err
	}
	path, err := registryPath(root, sessionID)
	if err != nil {
		return err
	}
	registry, err := readRegistry(path)
	if err != nil {
		return err
	}
	if filepath.Base(path) != registry.SessionID+".toml" {
		return fmt.Errorf("registry filename does not match session_id")
	}
	transcriptPath, err := safeTranscriptPath(root, registry.Transcript)
	if err != nil {
		return err
	}
	if err := os.Remove(transcriptPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove transcript: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove registry: %w", err)
	}
	return syncDirectory(root)
}

func WriteSessionList(writer io.Writer, hostID string) error {
	if err := validateID(hostID); err != nil {
		return fmt.Errorf("invalid host_id: %w", err)
	}
	root, err := stateRoot()
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(writer)
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return encoder.Encode(map[string]any{"type": "complete", "count": 0})
	}
	if err != nil {
		return fmt.Errorf("read registry directory: %w", err)
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".toml" {
			continue
		}
		path := filepath.Join(root, entry.Name())
		registry, err := readRegistry(path)
		if err != nil {
			if encodeErr := encoder.Encode(map[string]any{
				"type":  "invalid",
				"path":  entry.Name(),
				"error": err.Error(),
			}); encodeErr != nil {
				return encodeErr
			}
			continue
		}
		if registry.HostID != hostID {
			continue
		}
		expectedName := registry.SessionID + ".toml"
		if entry.Name() != expectedName {
			if encodeErr := encoder.Encode(map[string]any{
				"type":       "invalid",
				"path":       entry.Name(),
				"session_id": registry.SessionID,
				"error":      "registry filename does not match session_id",
			}); encodeErr != nil {
				return encodeErr
			}
			continue
		}
		session := listedSessionFromRegistry(registry)
		if registry.Exit == nil {
			if liveSession, err := ProbeSessionInfo(registry); err == nil {
				session = liveSession
			}
		}
		if encodeErr := encoder.Encode(map[string]any{"type": "session", "session": session}); encodeErr != nil {
			return encodeErr
		}
		count++
	}
	return encoder.Encode(map[string]any{"type": "complete", "count": count})
}

func WriteSessionHistory(writer io.Writer, sessionID string, requestID string) error {
	registry, err := LoadRegistry(sessionID)
	if err != nil {
		return err
	}
	root, err := stateRoot()
	if err != nil {
		return err
	}
	path, err := safeTranscriptPath(root, registry.Transcript)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(writer)
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return encoder.Encode(responseLine{
			Type:      "response",
			RequestID: requestID,
			Ok:        true,
			Complete:  true,
			Count:     0,
		})
	}
	if err != nil {
		return fmt.Errorf("read transcript: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	count := 0
	for scanner.Scan() {
		var chunk transcriptChunk
		if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
			return fmt.Errorf("decode transcript chunk: %w", err)
		}
		if err := encoder.Encode(eventLine{
			Type:      "event",
			Event:     "history",
			Seq:       chunk.Seq,
			Timestamp: chunk.Timestamp,
			Data:      chunk.Data,
		}); err != nil {
			return err
		}
		count++
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return encoder.Encode(responseLine{
		Type:      "response",
		RequestID: requestID,
		Ok:        true,
		Complete:  true,
		Count:     count,
	})
}

func validateLaunchSpec(spec LaunchSpec) error {
	if spec.Version != 1 {
		return fmt.Errorf("unsupported launch spec version %d", spec.Version)
	}
	if err := validateID(spec.SessionID); err != nil {
		return fmt.Errorf("invalid session_id: %w", err)
	}
	if err := validateID(spec.HostID); err != nil {
		return fmt.Errorf("invalid host_id: %w", err)
	}
	if strings.TrimSpace(spec.Title) == "" {
		return errors.New("title is required")
	}
	if strings.TrimSpace(spec.Command) == "" {
		return errors.New("command is required")
	}
	if spec.Cols == 0 || spec.Rows == 0 {
		return errors.New("terminal cols and rows must be positive")
	}
	return nil
}

func validateID(value string) error {
	if !idPattern.MatchString(value) {
		return errors.New("must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}")
	}
	return nil
}

func transcriptName(sessionID string) string {
	return sessionID + ".ndjson"
}

func registryPath(root string, sessionID string) (string, error) {
	if err := validateID(sessionID); err != nil {
		return "", err
	}
	return filepath.Join(root, sessionID+".toml"), nil
}

func writeRegistryAtomic(root string, registry Registry) error {
	path, err := registryPath(root, registry.SessionID)
	if err != nil {
		return err
	}
	if err := validateTranscriptPath(registry.Transcript); err != nil {
		return err
	}
	var buffer bytes.Buffer
	if err := toml.NewEncoder(&buffer).Encode(registry); err != nil {
		return fmt.Errorf("encode registry TOML: %w", err)
	}
	file, err := os.CreateTemp(root, registry.SessionID+".*.tmp")
	if err != nil {
		return fmt.Errorf("open temporary registry: %w", err)
	}
	tempPath := file.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if err := file.Chmod(registryFileMode); err != nil {
		_ = file.Close()
		return fmt.Errorf("chmod temporary registry: %w", err)
	}
	_, writeErr := file.Write(buffer.Bytes())
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("write temporary registry: %w", writeErr)
	}
	if syncErr != nil {
		return fmt.Errorf("sync temporary registry: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close temporary registry: %w", closeErr)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace registry: %w", err)
	}
	return syncDirectory(root)
}

func readRegistry(path string) (Registry, error) {
	var registry Registry
	if _, err := toml.DecodeFile(path, &registry); err != nil {
		return Registry{}, err
	}
	if err := validateID(registry.SessionID); err != nil {
		return Registry{}, fmt.Errorf("invalid session_id: %w", err)
	}
	if err := validateID(registry.HostID); err != nil {
		return Registry{}, fmt.Errorf("invalid host_id: %w", err)
	}
	if registry.Version != 1 {
		return Registry{}, fmt.Errorf("unsupported registry version %d", registry.Version)
	}
	if registry.ProtocolVersion != ProtocolVersion {
		return Registry{}, fmt.Errorf("unsupported protocol_version %d", registry.ProtocolVersion)
	}
	if strings.TrimSpace(registry.Endpoint.Path) == "" {
		return Registry{}, errors.New("endpoint path is required")
	}
	if err := validateTranscriptPath(registry.Transcript); err != nil {
		return Registry{}, err
	}
	return registry, nil
}

func validateTranscriptPath(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("transcript path is required")
	}
	if filepath.IsAbs(value) {
		return errors.New("transcript path must be relative")
	}
	clean := filepath.Clean(value)
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return errors.New("transcript path must stay inside registry directory")
	}
	return nil
}

func listedSessionFromRegistry(registry Registry) ListedSession {
	status := "stale"
	if registry.Exit != nil {
		status = "exited"
	}
	return ListedSession{
		SessionID:       registry.SessionID,
		HostID:          registry.HostID,
		Title:           registry.Title,
		Command:         registry.Command,
		Cwd:             registry.Cwd,
		AgentVersion:    registry.AgentVersion,
		ProtocolVersion: registry.ProtocolVersion,
		Cols:            registry.Cols,
		Rows:            registry.Rows,
		PixelWidth:      registry.PixelWidth,
		PixelHeight:     registry.PixelHeight,
		Endpoint:        registry.Endpoint,
		Transcript:      registry.Transcript,
		Status:          status,
		AttachedCount:   0,
		Exit:            registry.Exit,
	}
}
