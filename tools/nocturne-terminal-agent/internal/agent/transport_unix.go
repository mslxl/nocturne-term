//go:build !windows

package agent

import (
	"net"
	"os"
	"path/filepath"
)

type daemonListener interface {
	Accept() (net.Conn, error)
	Close() error
}

func listenEndpoint(endpoint string) (daemonListener, error) {
	if err := os.MkdirAll(filepath.Dir(endpoint), 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(endpoint); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", endpoint)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(endpoint, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func dialEndpoint(endpoint string) (net.Conn, error) {
	return net.Dial("unix", endpoint)
}
