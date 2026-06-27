package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func TestWriteInitialRegistryAndListByHost(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-a",
		HostID:    "host-a",
		Title:     "Build",
		Command:   "go test ./...",
		Cwd:       "/workspace",
		Cols:      120,
		Rows:      32,
	}
	if err := WriteInitialRegistry(spec); err != nil {
		t.Fatalf("WriteInitialRegistry failed: %v", err)
	}

	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot failed: %v", err)
	}
	registryPath := filepath.Join(root, "session-a.toml")
	content, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatalf("read registry failed: %v", err)
	}
	text := string(content)
	for _, expected := range []string{
		`session_id = "session-a"`,
		`host_id = "host-a"`,
		`title = "Build"`,
		`command = "go test ./..."`,
		`cols = 120`,
		`rows = 32`,
		`transcript = "session-a.ndjson"`,
		`[endpoint]`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("registry missing %q:\n%s", expected, text)
		}
	}

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
	if sessionLine.Type != "session" {
		t.Fatalf("expected session line, got %q", sessionLine.Type)
	}
	if sessionLine.Session.SessionID != "session-a" || sessionLine.Session.HostID != "host-a" {
		t.Fatalf("unexpected listed session: %+v", sessionLine.Session)
	}
	if sessionLine.Session.Cols != 120 || sessionLine.Session.Rows != 32 {
		t.Fatalf("listed session lost size metadata: %+v", sessionLine.Session)
	}
	if sessionLine.Session.Status != "stale" {
		t.Fatalf("expected stale before probe implementation, got %q", sessionLine.Session.Status)
	}
	if sessionLine.Session.Endpoint.Kind == "" || sessionLine.Session.Endpoint.Path == "" {
		t.Fatalf("expected endpoint display metadata in listed session: %+v", sessionLine.Session.Endpoint)
	}
}

func TestCreateInitialRegistryUsesGeneratedTitleWhenLaunchTitleIsSessionPlaceholder(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)

	registry, err := CreateInitialRegistry(LaunchSpec{
		Version:   1,
		SessionID: "session-generated-title",
		HostID:    "host-a",
		Title:     "Session 7",
		Command:   "bash",
		Cols:      80,
		Rows:      24,
	})
	if err != nil {
		t.Fatalf("CreateInitialRegistry failed: %v", err)
	}

	if registry.Title == "Session 7" {
		t.Fatalf("registry kept generated UI placeholder title")
	}
	if !regexp.MustCompile(`^[A-Z][A-Za-z]+[A-Z][A-Za-z]+$`).MatchString(registry.Title) {
		t.Fatalf("registry generated title is not a session codename: %q", registry.Title)
	}
}

func TestRenameRegistrySessionUpdatesListedTitle(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	if err := WriteInitialRegistry(LaunchSpec{
		Version:   1,
		SessionID: "session-rename",
		HostID:    "host-a",
		Title:     "Build",
		Command:   "bash",
		Cols:      80,
		Rows:      24,
	}); err != nil {
		t.Fatalf("WriteInitialRegistry failed: %v", err)
	}

	if err := RenameRegistrySession("session-rename", " Release Shell "); err != nil {
		t.Fatalf("RenameRegistrySession failed: %v", err)
	}

	var output bytes.Buffer
	if err := WriteSessionList(&output, "host-a"); err != nil {
		t.Fatalf("WriteSessionList failed: %v", err)
	}
	if !strings.Contains(output.String(), `"title":"Release Shell"`) {
		t.Fatalf("list did not use renamed registry title:\n%s", output.String())
	}
}

func TestListReportsFilenameMismatchAsInvalid(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-a",
		HostID:    "host-a",
		Title:     "Build",
		Command:   "bash",
		Cols:      80,
		Rows:      24,
	}
	if err := WriteInitialRegistry(spec); err != nil {
		t.Fatalf("WriteInitialRegistry failed: %v", err)
	}
	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot failed: %v", err)
	}
	if err := os.Rename(filepath.Join(root, "session-a.toml"), filepath.Join(root, "wrong-name.toml")); err != nil {
		t.Fatalf("rename registry failed: %v", err)
	}

	var output bytes.Buffer
	if err := WriteSessionList(&output, "host-a"); err != nil {
		t.Fatalf("WriteSessionList failed: %v", err)
	}
	if !strings.Contains(output.String(), `"type":"invalid"`) {
		t.Fatalf("expected invalid line, got:\n%s", output.String())
	}
	if !strings.Contains(output.String(), "registry filename does not match session_id") {
		t.Fatalf("expected filename mismatch error, got:\n%s", output.String())
	}
}

func TestAtomicRegistryWriteReplacesExistingFile(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-replace",
		HostID:    "host-a",
		Title:     "Replace",
		Command:   "bash",
		Cols:      80,
		Rows:      24,
	}
	if err := WriteInitialRegistry(spec); err != nil {
		t.Fatalf("WriteInitialRegistry failed: %v", err)
	}
	code := 0
	if err := MarkRegistryExited("session-replace", ExitInfo{
		Code:     &code,
		Reason:   "closed",
		ExitedAt: "2026-06-25T00:00:00Z",
	}); err != nil {
		t.Fatalf("MarkRegistryExited failed: %v", err)
	}

	root, err := stateRoot()
	if err != nil {
		t.Fatalf("stateRoot failed: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(root, "session-replace.toml"))
	if err != nil {
		t.Fatalf("read registry failed: %v", err)
	}
	text := string(content)
	if !strings.Contains(text, "[exit]") || !strings.Contains(text, `reason = "closed"`) {
		t.Fatalf("registry replacement did not persist exit info:\n%s", text)
	}
	matches, err := filepath.Glob(filepath.Join(root, "session-replace.*.tmp"))
	if err != nil {
		t.Fatalf("glob temporary registries failed: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("registry replacement left temporary files: %v", matches)
	}
}

func TestDeleteSessionFilesRemovesRegistryAndTranscript(t *testing.T) {
	temp := t.TempDir()
	setStateEnv(t, temp)
	spec := LaunchSpec{
		Version:   1,
		SessionID: "session-delete",
		HostID:    "host-a",
		Title:     "Delete",
		Command:   "bash",
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
	transcriptPath := filepath.Join(root, registry.Transcript)
	if err := os.WriteFile(transcriptPath, []byte("history\n"), transcriptFileMode); err != nil {
		t.Fatalf("write transcript failed: %v", err)
	}

	if err := DeleteSessionFiles("session-delete"); err != nil {
		t.Fatalf("DeleteSessionFiles failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(root, "session-delete.toml")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("registry was not removed: %v", err)
	}
	if _, err := os.Stat(transcriptPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("transcript was not removed: %v", err)
	}
}

func TestValidateTranscriptPathRejectsEscapes(t *testing.T) {
	for _, value := range []string{"../outside.ndjson", "/tmp/outside.ndjson", ""} {
		if runtime.GOOS == "windows" && strings.HasPrefix(value, "/") {
			continue
		}
		if err := validateTranscriptPath(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
	if err := validateTranscriptPath("session.ndjson"); err != nil {
		t.Fatalf("expected relative transcript path to pass: %v", err)
	}
}

func setStateEnv(t *testing.T, root string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", root)
		return
	}
	t.Setenv("XDG_STATE_HOME", root)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "run"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
}
