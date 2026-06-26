//go:build windows

package agent

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32                   = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePty                 = modKernel32.NewProc("CreatePseudoConsole")
	procResizePty                 = modKernel32.NewProc("ResizePseudoConsole")
	procClosePty                  = modKernel32.NewProc("ClosePseudoConsole")
	procInitializeAttributeList   = modKernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateThreadAttribute     = modKernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteThreadAttributeList = modKernel32.NewProc("DeleteProcThreadAttributeList")
	errConPtyUnsupported          = fmt.Errorf("ConPTY is not available on this version of Windows")
)

const (
	sOk                              uintptr = 0
	procThreadAttributePseudoConsole uintptr = 0x00020016
	stillActive                      uint32  = 259
)

type windowsCoord struct {
	X int16
	Y int16
}

type windowsStartupInfoEx struct {
	startupInfo   windows.StartupInfo
	attributeList []byte
}

func (coord windowsCoord) pack() uintptr {
	return uintptr((int32(coord.Y) << 16) | int32(coord.X))
}

func defaultPtyStarter(spec LaunchSpec) (ptyProcess, error) {
	commandLine := windowsCommandLine(spec.Command, spec.Args)
	process, err := startWindowsPty(commandLine, spec)
	if err != nil {
		return nil, err
	}
	return process, nil
}

type windowsPtyProcess struct {
	hpc    windows.Handle
	pi     windows.ProcessInformation
	ptyIn  windows.Handle
	ptyOut windows.Handle
	cmdIn  windows.Handle
	cmdOut windows.Handle
}

func (process *windowsPtyProcess) Read(buffer []byte) (int, error) {
	var numRead uint32
	err := windows.ReadFile(process.cmdOut, buffer, &numRead, nil)
	return int(numRead), err
}

func (process *windowsPtyProcess) Write(bytes []byte) (int, error) {
	var numWritten uint32
	err := windows.WriteFile(process.cmdIn, bytes, &numWritten, nil)
	return int(numWritten), err
}

func (process *windowsPtyProcess) Close() error {
	if process.hpc != 0 {
		procClosePty.Call(uintptr(process.hpc))
		process.hpc = 0
	}
	var err error
	for _, handle := range []windows.Handle{
		process.pi.Process,
		process.pi.Thread,
		process.ptyIn,
		process.ptyOut,
		process.cmdIn,
		process.cmdOut,
	} {
		if handle == 0 || handle == windows.InvalidHandle {
			continue
		}
		if closeErr := windows.CloseHandle(handle); err == nil && closeErr != nil {
			err = closeErr
		}
	}
	return err
}

func (process *windowsPtyProcess) Resize(size ptySize) error {
	coord := windowsCoord{X: int16(size.Cols), Y: int16(size.Rows)}
	ret, _, _ := procResizePty.Call(uintptr(process.hpc), coord.pack())
	if ret != sOk {
		return fmt.Errorf("ResizePseudoConsole failed with status 0x%x", ret)
	}
	return nil
}

func (process *windowsPtyProcess) Wait(ctx context.Context) (ExitInfo, error) {
	for {
		if err := ctx.Err(); err != nil {
			return ExitInfo{}, err
		}
		ret, err := windows.WaitForSingleObject(process.pi.Process, 1000)
		if err != nil {
			return ExitInfo{}, err
		}
		if ret == uint32(windows.WAIT_TIMEOUT) {
			continue
		}
		if ret == uint32(windows.WAIT_FAILED) {
			return ExitInfo{}, fmt.Errorf("WaitForSingleObject failed")
		}
		var code uint32
		if err := windows.GetExitCodeProcess(process.pi.Process, &code); err != nil {
			return ExitInfo{}, err
		}
		if code == stillActive {
			continue
		}
		intCode := int(code)
		return ExitInfo{Code: &intCode, Reason: "exit"}, nil
	}
}

func windowsCommandLine(command string, args []string) string {
	return windows.ComposeCommandLine(append([]string{command}, args...))
}

func startWindowsPty(commandLine string, spec LaunchSpec) (*windowsPtyProcess, error) {
	if !isConPtyAvailable() {
		return nil, errConPtyUnsupported
	}

	var ptyIn windows.Handle
	var cmdIn windows.Handle
	if err := windows.CreatePipe(&ptyIn, &cmdIn, nil, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe input: %w", err)
	}
	var cmdOut windows.Handle
	var ptyOut windows.Handle
	if err := windows.CreatePipe(&cmdOut, &ptyOut, nil, 0); err != nil {
		_ = windows.CloseHandle(ptyIn)
		_ = windows.CloseHandle(cmdIn)
		return nil, fmt.Errorf("CreatePipe output: %w", err)
	}

	hpc, err := createPseudoConsole(windowsCoord{
		X: int16(spec.Cols),
		Y: int16(spec.Rows),
	}, ptyIn, ptyOut)
	if err != nil {
		_ = windows.CloseHandle(ptyIn)
		_ = windows.CloseHandle(ptyOut)
		_ = windows.CloseHandle(cmdIn)
		_ = windows.CloseHandle(cmdOut)
		return nil, err
	}

	process, err := createWindowsPtyProcess(hpc, commandLine, spec)
	if err != nil {
		procClosePty.Call(uintptr(hpc))
		_ = windows.CloseHandle(ptyIn)
		_ = windows.CloseHandle(ptyOut)
		_ = windows.CloseHandle(cmdIn)
		_ = windows.CloseHandle(cmdOut)
		return nil, err
	}
	return &windowsPtyProcess{
		hpc:    hpc,
		pi:     process,
		ptyIn:  ptyIn,
		ptyOut: ptyOut,
		cmdIn:  cmdIn,
		cmdOut: cmdOut,
	}, nil
}

func isConPtyAvailable() bool {
	return procCreatePty.Find() == nil &&
		procResizePty.Find() == nil &&
		procClosePty.Find() == nil &&
		procInitializeAttributeList.Find() == nil &&
		procUpdateThreadAttribute.Find() == nil &&
		procDeleteThreadAttributeList.Find() == nil
}

func createPseudoConsole(size windowsCoord, input windows.Handle, output windows.Handle) (windows.Handle, error) {
	var hpc windows.Handle
	ret, _, _ := procCreatePty.Call(
		size.pack(),
		uintptr(input),
		uintptr(output),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	if ret != sOk {
		return 0, fmt.Errorf("CreatePseudoConsole failed with status 0x%x", ret)
	}
	return hpc, nil
}

func createWindowsPtyProcess(hpc windows.Handle, commandLine string, spec LaunchSpec) (windows.ProcessInformation, error) {
	startupInfo, err := startupInfoForPty(hpc)
	if err != nil {
		return windows.ProcessInformation{}, err
	}
	defer procDeleteThreadAttributeList.Call(uintptr(unsafe.Pointer(&startupInfo.attributeList[0])))
	startupInfo.startupInfo.Cb = uint32(unsafe.Sizeof(windows.StartupInfo{})) + uint32(unsafe.Sizeof(&startupInfo.attributeList[0]))
	commandLineUtf16, err := windows.UTF16FromString(commandLine)
	if err != nil {
		return windows.ProcessInformation{}, fmt.Errorf("encode command line: %w", err)
	}
	commandLinePtr := &commandLineUtf16[0]
	var cwdUtf16 []uint16
	var cwdPtr *uint16
	if strings.TrimSpace(spec.Cwd) != "" {
		cwdUtf16, err = windows.UTF16FromString(spec.Cwd)
		if err != nil {
			return windows.ProcessInformation{}, fmt.Errorf("encode working directory: %w", err)
		}
		cwdPtr = &cwdUtf16[0]
	}
	envBlock, err := windowsEnvironmentBlock(spec.Env)
	if err != nil {
		return windows.ProcessInformation{}, err
	}
	var envPtr *uint16
	if len(envBlock) > 0 {
		envPtr = &envBlock[0]
	}
	var process windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(
		nil,
		commandLinePtr,
		nil,
		nil,
		false,
		flags,
		envPtr,
		cwdPtr,
		&startupInfo.startupInfo,
		&process,
	); err != nil {
		return windows.ProcessInformation{}, fmt.Errorf("CreateProcess: %w", err)
	}
	return process, nil
}

func startupInfoForPty(hpc windows.Handle) (*windowsStartupInfoEx, error) {
	var size uintptr
	procInitializeAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return nil, fmt.Errorf("InitializeProcThreadAttributeList did not report buffer size")
	}
	startupInfo := &windowsStartupInfoEx{
		attributeList: make([]byte, size),
	}
	startupInfo.startupInfo.Flags = windows.STARTF_USESTDHANDLES
	ret, _, err := procInitializeAttributeList.Call(
		uintptr(unsafe.Pointer(&startupInfo.attributeList[0])),
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != 1 {
		return nil, fmt.Errorf("InitializeProcThreadAttributeList: %v", err)
	}
	ret, _, err = procUpdateThreadAttribute.Call(
		uintptr(unsafe.Pointer(&startupInfo.attributeList[0])),
		0,
		procThreadAttributePseudoConsole,
		uintptr(hpc),
		unsafe.Sizeof(hpc),
		0,
		0,
	)
	if ret != 1 {
		procDeleteThreadAttributeList.Call(uintptr(unsafe.Pointer(&startupInfo.attributeList[0])))
		return nil, fmt.Errorf("UpdateProcThreadAttribute PSEUDOCONSOLE: %v", err)
	}
	return startupInfo, nil
}

func windowsEnvironmentBlock(overrides map[string]string) ([]uint16, error) {
	merged := make(map[string]string)
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		merged[strings.ToUpper(key)] = key + "=" + value
	}
	for key, value := range overrides {
		if strings.ContainsRune(key, '=') {
			return nil, fmt.Errorf("environment key %q must not contain =", key)
		}
		merged[strings.ToUpper(key)] = key + "=" + value
	}
	items := make([]string, 0, len(merged))
	for _, item := range merged {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.ToUpper(items[i]) < strings.ToUpper(items[j])
	})
	block := strings.Join(items, "\x00") + "\x00\x00"
	return utf16.Encode([]rune(block)), nil
}
