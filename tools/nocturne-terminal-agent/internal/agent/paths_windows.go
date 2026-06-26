//go:build windows

package agent

import (
	"errors"
	"os"
	"path/filepath"
)

func stateRoot() (string, error) {
	if value := os.Getenv("LOCALAPPDATA"); value != "" {
		return filepath.Join(value, "Nocturne", "terminal-sessions"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("cannot resolve home directory for LocalAppData fallback")
	}
	return filepath.Join(home, "AppData", "Local", "Nocturne", "terminal-sessions"), nil
}

func endpointForSession(sessionID string) (string, error) {
	if err := validateID(sessionID); err != nil {
		return "", err
	}
	return `\\.\pipe\nocturne-terminal-agent-` + sessionID, nil
}

func endpointKind() string {
	return "windows_named_pipe"
}
