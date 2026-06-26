package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/mslxl/nocturne-term/tools/nocturne-terminal-agent/internal/agent"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "nocturne-terminal-agent: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("missing command: daemon, client, or version")
	}
	switch args[0] {
	case "daemon":
		return runDaemon(args[1:], stdin)
	case "client":
		return runClient(args[1:], stdin, stdout)
	case "version":
		_, err := fmt.Fprintf(stdout, "%s\n", agent.AgentVersion)
		return err
	default:
		return fmt.Errorf("unsupported command %q", args[0])
	}
}

func runDaemon(args []string, stdin io.Reader) error {
	if len(args) != 1 || args[0] != "--launch-spec-stdin" {
		return errors.New("daemon requires --launch-spec-stdin")
	}
	var spec agent.LaunchSpec
	if err := json.NewDecoder(stdin).Decode(&spec); err != nil {
		return fmt.Errorf("decode launch spec: %w", err)
	}
	return agent.RunDaemon(spec)
}

func runClient(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) < 1 {
		return errors.New("client requires a subcommand")
	}
	switch args[0] {
	case "list":
		return runClientList(args[1:], stdout)
	case "delete":
		sessionID, err := parseSessionID(args[1:])
		if err != nil {
			return err
		}
		return agent.DeleteSession(stdout, sessionID)
	case "info", "history", "attach", "subscribe", "close", "detach", "ping":
		sessionID, err := parseSessionID(args[1:])
		if err != nil {
			return err
		}
		return agent.ProxySessionRequestWithInput(stdout, stdin, sessionID, args[0], nil, streamsUntilEOF(args[0]))
	case "rename", "title_change":
		sessionID, title, err := parseSessionIDAndValue(args[1:], "--title")
		if err != nil {
			return err
		}
		if title == "" {
			return errors.New("client rename --title requires a non-empty value")
		}
		return agent.ProxySessionRequest(stdout, sessionID, args[0], map[string]string{
			"title": title,
		}, false)
	case "write":
		sessionID, data, err := parseSessionIDAndValue(args[1:], "--data")
		if err != nil {
			return err
		}
		if _, err := base64.StdEncoding.DecodeString(data); err != nil {
			return fmt.Errorf("client write --data must be base64 terminal input: %w", err)
		}
		return agent.ProxySessionRequest(stdout, sessionID, "write", map[string]string{
			"data": data,
		}, false)
	case "resize":
		sessionID, payload, err := parseResize(args[1:])
		if err != nil {
			return err
		}
		return agent.ProxySessionRequest(stdout, sessionID, "resize", payload, false)
	default:
		return fmt.Errorf("unsupported client command %q", args[0])
	}
}

func streamsUntilEOF(command string) bool {
	return command == "attach" || command == "subscribe"
}

func runClientList(args []string, stdout io.Writer) error {
	var hostID string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--host-id":
			i++
			if i >= len(args) {
				return errors.New("client list --host-id requires a value")
			}
			hostID = args[i]
		default:
			return fmt.Errorf("unsupported client list argument %q", args[i])
		}
	}
	if hostID == "" {
		return errors.New("client list requires --host-id")
	}
	return agent.WriteSessionList(stdout, hostID)
}

func parseSessionID(args []string) (string, error) {
	var sessionID string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--session-id":
			i++
			if i >= len(args) {
				return "", errors.New("--session-id requires a value")
			}
			sessionID = args[i]
		default:
			return "", fmt.Errorf("unsupported client argument %q", args[i])
		}
	}
	if sessionID == "" {
		return "", errors.New("client command requires --session-id")
	}
	return sessionID, nil
}

func parseSessionIDAndValue(args []string, valueName string) (string, string, error) {
	var sessionID string
	var value string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--session-id":
			i++
			if i >= len(args) {
				return "", "", errors.New("--session-id requires a value")
			}
			sessionID = args[i]
		case valueName:
			i++
			if i >= len(args) {
				return "", "", fmt.Errorf("%s requires a value", valueName)
			}
			value = args[i]
		default:
			return "", "", fmt.Errorf("unsupported client argument %q", args[i])
		}
	}
	if sessionID == "" {
		return "", "", errors.New("client command requires --session-id")
	}
	return sessionID, value, nil
}

func parseResize(args []string) (string, map[string]uint16, error) {
	var sessionID string
	var cols uint64
	var rows uint64
	var pixelWidth uint64
	var pixelHeight uint64
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--session-id":
			i++
			if i >= len(args) {
				return "", nil, errors.New("--session-id requires a value")
			}
			sessionID = args[i]
		case "--cols":
			i++
			if i >= len(args) {
				return "", nil, errors.New("--cols requires a value")
			}
			if _, err := fmt.Sscan(args[i], &cols); err != nil {
				return "", nil, fmt.Errorf("invalid --cols: %w", err)
			}
		case "--rows":
			i++
			if i >= len(args) {
				return "", nil, errors.New("--rows requires a value")
			}
			if _, err := fmt.Sscan(args[i], &rows); err != nil {
				return "", nil, fmt.Errorf("invalid --rows: %w", err)
			}
		case "--pixel-width":
			i++
			if i >= len(args) {
				return "", nil, errors.New("--pixel-width requires a value")
			}
			if _, err := fmt.Sscan(args[i], &pixelWidth); err != nil {
				return "", nil, fmt.Errorf("invalid --pixel-width: %w", err)
			}
		case "--pixel-height":
			i++
			if i >= len(args) {
				return "", nil, errors.New("--pixel-height requires a value")
			}
			if _, err := fmt.Sscan(args[i], &pixelHeight); err != nil {
				return "", nil, fmt.Errorf("invalid --pixel-height: %w", err)
			}
		default:
			return "", nil, fmt.Errorf("unsupported client argument %q", args[i])
		}
	}
	if sessionID == "" {
		return "", nil, errors.New("client resize requires --session-id")
	}
	if cols == 0 || cols > 65535 || rows == 0 || rows > 65535 {
		return "", nil, errors.New("client resize requires positive 16-bit --cols and --rows")
	}
	if pixelWidth > 65535 || pixelHeight > 65535 {
		return "", nil, errors.New("client resize pixel dimensions must be 16-bit integers")
	}
	return sessionID, map[string]uint16{
		"cols":         uint16(cols),
		"rows":         uint16(rows),
		"pixel_width":  uint16(pixelWidth),
		"pixel_height": uint16(pixelHeight),
	}, nil
}
