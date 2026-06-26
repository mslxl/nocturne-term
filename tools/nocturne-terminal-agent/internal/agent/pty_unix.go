//go:build !windows

package agent

import (
	"context"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func defaultPtyStarter(spec LaunchSpec) (ptyProcess, error) {
	command := exec.Command(spec.Command, spec.Args...)
	command.Dir = spec.Cwd
	command.Env = os.Environ()
	for key, value := range spec.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	file, err := pty.StartWithSize(command, &pty.Winsize{
		Rows: uint16(spec.Rows),
		Cols: uint16(spec.Cols),
		X:    uint16(spec.PixelWidth),
		Y:    uint16(spec.PixelHeight),
	})
	if err != nil {
		return nil, err
	}
	return &unixPtyProcess{file: file, command: command}, nil
}

type unixPtyProcess struct {
	file    *os.File
	command *exec.Cmd
}

func (process *unixPtyProcess) Read(buffer []byte) (int, error) {
	return process.file.Read(buffer)
}

func (process *unixPtyProcess) Write(bytes []byte) (int, error) {
	return process.file.Write(bytes)
}

func (process *unixPtyProcess) Close() error {
	if process.command.Process != nil {
		_ = process.command.Process.Kill()
	}
	return process.file.Close()
}

func (process *unixPtyProcess) Resize(size ptySize) error {
	return pty.Setsize(process.file, &pty.Winsize{
		Rows: uint16(size.Rows),
		Cols: uint16(size.Cols),
		X:    uint16(size.PixelWidth),
		Y:    uint16(size.PixelHeight),
	})
}

func (process *unixPtyProcess) Wait(ctx context.Context) (ExitInfo, error) {
	done := make(chan error, 1)
	go func() {
		done <- process.command.Wait()
	}()
	select {
	case err := <-done:
		exit := ExitInfo{Reason: "exit"}
		if process.command.ProcessState != nil {
			if status, ok := process.command.ProcessState.Sys().(syscall.WaitStatus); ok {
				if status.Signaled() {
					exit.Signal = status.Signal().String()
				}
			}
			code := process.command.ProcessState.ExitCode()
			exit.Code = &code
		}
		return exit, err
	case <-ctx.Done():
		return ExitInfo{}, ctx.Err()
	}
}
