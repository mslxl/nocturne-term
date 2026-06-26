//go:build windows

package agent

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestWindowsDefaultPtyStarterKeepsInteractiveCmdAlive(t *testing.T) {
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = `C:\Windows\System32\cmd.exe`
	}
	for _, tt := range []struct {
		name    string
		command string
		args    []string
	}{
		{name: "cmd-exe-no-args", command: "cmd.exe"},
		{name: "comspec-no-args", command: comspec},
		{name: "cmd-exe-prompt", command: "cmd.exe", args: []string{"/d", "/q", "/k", "prompt $G"}},
		{name: "comspec-prompt", command: comspec, args: []string{"/d", "/q", "/k", "prompt $G"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			assertWindowsPtyKeepsCmdAlive(t, tt.command, tt.args)
		})
	}
}

func assertWindowsPtyKeepsCmdAlive(t *testing.T, command string, args []string) {
	t.Helper()
	process, err := defaultPtyStarter(LaunchSpec{
		Version:   1,
		SessionID: "term-windows-live-cmd",
		HostID:    "host-a",
		Title:     "Windows live cmd",
		Command:   command,
		Args:      args,
		Cols:      80,
		Rows:      24,
	})
	if err != nil {
		t.Fatalf("start Windows PTY failed: %v", err)
	}
	defer process.Close()

	waitDone := make(chan ExitInfo, 1)
	waitErr := make(chan error, 1)
	go func() {
		exit, err := process.Wait(context.Background())
		if err != nil {
			waitErr <- err
			return
		}
		waitDone <- exit
	}()

	select {
	case exit := <-waitDone:
		t.Fatalf("interactive cmd exited immediately: %+v", exit)
	case err := <-waitErr:
		t.Fatalf("interactive cmd wait failed immediately: %v", err)
	case <-time.After(750 * time.Millisecond):
	}

	marker := "NOCTURNE_WINDOWS_CONPTY_LIVE"
	if _, err := process.Write([]byte("echo " + marker + "\r")); err != nil {
		t.Fatalf("write to Windows PTY failed: %v", err)
	}
	if !readPtyUntil(t, process, marker, 3*time.Second) {
		t.Fatalf("Windows PTY did not return marker %q", marker)
	}
}

func readPtyUntil(t *testing.T, process ptyProcess, marker string, timeout time.Duration) bool {
	t.Helper()
	output := make(chan string, 1)
	go func() {
		var builder strings.Builder
		buffer := make([]byte, 4096)
		for {
			read, err := process.Read(buffer)
			if read > 0 {
				builder.Write(buffer[:read])
				if strings.Contains(builder.String(), marker) {
					output <- builder.String()
					return
				}
			}
			if err != nil {
				output <- builder.String()
				return
			}
		}
	}()

	select {
	case text := <-output:
		return strings.Contains(text, marker)
	case <-time.After(timeout):
		_ = process.Close()
		t.Logf("timed out waiting for marker; PTY read did not produce %q", marker)
		return false
	}
}
