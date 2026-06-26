//go:build !windows

package agent

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestListenEndpointCreatesParentDirectory(t *testing.T) {
	temp := t.TempDir()
	endpoint := filepath.Join(temp, "runtime", "terminal-agent", "session.sock")

	listener, err := listenEndpoint(endpoint)
	if err != nil {
		t.Fatalf("listenEndpoint failed: %v", err)
	}
	defer listener.Close()

	if _, err := os.Stat(filepath.Dir(endpoint)); err != nil {
		t.Fatalf("expected parent directory to be created: %v", err)
	}
	if _, err := os.Stat(endpoint); err != nil {
		t.Fatalf("expected unix socket to be created: %v", err)
	}
}

func TestListenEndpointRejectsStaleSocketRemovalErrors(t *testing.T) {
	temp := t.TempDir()
	endpoint := filepath.Join(temp, "runtime", "terminal-agent", "session.sock")
	if err := os.MkdirAll(filepath.Dir(endpoint), 0o700); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(endpoint, []byte("not-a-socket"), 0o600); err != nil {
		t.Fatalf("write stale endpoint failed: %v", err)
	}
	if err := os.Chmod(filepath.Dir(endpoint), 0o500); err != nil {
		t.Fatalf("chmod parent failed: %v", err)
	}

	if _, err := listenEndpoint(endpoint); err == nil {
		t.Fatalf("expected listenEndpoint to fail when stale socket removal is blocked")
	}
}

var _ net.Listener
