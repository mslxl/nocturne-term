package agent

import (
	"context"
	"io"
)

type ptySize struct {
	Cols        uint16
	Rows        uint16
	PixelWidth  uint16
	PixelHeight uint16
}

type ptyProcess interface {
	io.ReadWriteCloser
	Resize(size ptySize) error
	Wait(ctx context.Context) (ExitInfo, error)
}

type ptyStarter func(spec LaunchSpec) (ptyProcess, error)

type echoPty struct {
	input  chan []byte
	output chan []byte
	done   chan struct{}
}

func newEchoPty() *echoPty {
	return &echoPty{
		input:  make(chan []byte, 16),
		output: make(chan []byte, 16),
		done:   make(chan struct{}),
	}
}

func (pty *echoPty) Read(buffer []byte) (int, error) {
	select {
	case bytes := <-pty.output:
		return copy(buffer, bytes), nil
	case <-pty.done:
		return 0, io.EOF
	}
}

func (pty *echoPty) Write(bytes []byte) (int, error) {
	copied := append([]byte(nil), bytes...)
	select {
	case pty.output <- copied:
		return len(bytes), nil
	case <-pty.done:
		return 0, io.ErrClosedPipe
	}
}

func (pty *echoPty) Close() error {
	select {
	case <-pty.done:
	default:
		close(pty.done)
	}
	return nil
}

func (pty *echoPty) Resize(_ ptySize) error {
	return nil
}

func (pty *echoPty) Wait(ctx context.Context) (ExitInfo, error) {
	select {
	case <-pty.done:
		code := 0
		return ExitInfo{Code: &code, Reason: "closed"}, nil
	case <-ctx.Done():
		return ExitInfo{}, ctx.Err()
	}
}

func startEchoPty(_ LaunchSpec) (ptyProcess, error) {
	return newEchoPty(), nil
}
