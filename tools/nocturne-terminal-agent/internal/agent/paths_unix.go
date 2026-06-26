//go:build !windows

package agent

import (
	"errors"
	"os"
	"path/filepath"
)

func stateRoot() (string, error) {
	if value := os.Getenv("XDG_STATE_HOME"); value != "" {
		return filepath.Join(value, "nocturne", "terminal-sessions"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("cannot resolve home directory for XDG state")
	}
	return filepath.Join(home, ".local", "state", "nocturne", "terminal-sessions"), nil
}

func runtimeRoot() (string, error) {
	if value := os.Getenv("XDG_RUNTIME_DIR"); value != "" {
		return filepath.Join(value, "nocturne", "terminal-agent"), nil
	}
	if value := os.Getenv("XDG_CACHE_HOME"); value != "" {
		return filepath.Join(value, "nocturne", "run", "terminal-agent"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("cannot resolve home directory for XDG cache")
	}
	return filepath.Join(home, ".cache", "nocturne", "run", "terminal-agent"), nil
}

func endpointForSession(sessionID string) (string, error) {
	if err := validateID(sessionID); err != nil {
		return "", err
	}
	root, err := runtimeRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, sessionID+".sock"), nil
}

func endpointKind() string {
	return "unix_socket"
}
