//go:build windows

package agent

import (
	"net"

	"github.com/Microsoft/go-winio"
)

type daemonListener interface {
	Accept() (net.Conn, error)
	Close() error
}

func listenEndpoint(endpoint string) (daemonListener, error) {
	return winio.ListenPipe(endpoint, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;OW)",
		InputBufferSize:    65536,
		OutputBufferSize:   65536,
	})
}

func dialEndpoint(endpoint string) (net.Conn, error) {
	return winio.DialPipe(endpoint, nil)
}
