// Wolffish CLI launcher — the console-subsystem half of `wolffish` on Windows.
//
// THE PROBLEM. The app binary is GUI-subsystem, and no .cmd wrapper can hide
// that. When cmd.exe starts a child without redirection it passes no explicit
// handles and relies on console inheritance, which a GUI-subsystem process
// never gets — so `wolffish --help` printed a blank line and returned, while
// `wolffish --help > out.txt` wrote the full text. With a redirect cmd sets
// STARTF_USESTDHANDLES and the handles are inherited after all.
//
// So this program passes the standard handles down explicitly. That is also why
// .NET's Process.Start is unusable here: it sets that flag only when
// redirecting, and a redirect would hand the child a pipe.
//
// THE HALF THAT IS NOT SYMMETRIC. Measured with a probe run from a real
// console: the child can WRITE to an inherited console handle (fs.writeSync(1)
// reports every byte) but READING one returns 0 bytes — instant EOF. Reads need
// the process to be attached to the console; writes do not. That asymmetry is
// the whole reason `wolffish` printed its prompt and exited before you could
// type: readline saw EOF on the first tick.
//
// Hence the shape below. stdout and stderr are handed over directly, which
// keeps ordering exact and costs nothing. stdin is PUMPED: this process is
// attached to the console and can read it, so it does, and forwards the bytes
// down a pipe the child can actually read. The child gets cooked console input,
// which means Windows' own line editing — backspace, F3, F7 history — comes
// along for free.
//
// WHAT THE CHILD CANNOT WORK OUT FOR ITSELF. It is not attached to a console,
// so libuv cannot classify any of this as a TTY and `process.stdout.isTTY`
// stays undefined no matter what. Everything downstream of that — colour,
// width, glyph safety, "is someone there to answer a prompt" — is therefore
// passed as environment instead, and the CLI reads it through
// src/cli/lib/tty.mjs. This process is the only one in the chain that KNOWS,
// so it is the right one to say.
//
// Built with the in-box csc.exe (see scripts/win-cli-launcher/build.mjs), so
// this costs the project no toolchain — no Rust, no MSVC, nothing to install on
// a machine that wants to run `electron-builder --win`.
using System;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WolffishCli
{
    private const int StdInput = -10;
    private const int StdOutput = -11;
    private const int StdError = -12;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint FileTypeChar = 0x0002;
    private const uint EnableVirtualTerminalProcessing = 0x0004;
    private const uint EnableEchoInput = 0x0004;
    private const int Utf8 = 65001;

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref StartupInfo lpStartupInfo,
        out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SecurityAttributes lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

    [DllImport("kernel32.dll")]
    private static extern int GetConsoleOutputCP();

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleOutputCP(uint wCodePageID);

    [DllImport("kernel32.dll")]
    private static extern int GetConsoleCP();

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleCP(uint wCodePageID);

    private static IntPtr _child = IntPtr.Zero;
    private static readonly IntPtr Invalid = new IntPtr(-1);
    private static IntPtr _consoleIn = IntPtr.Zero;
    private static uint _consoleInMode;

    private static int Main()
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string app = Path.Combine(dir, "wolffish.exe");
        string entry = Path.Combine(dir, "resources", "cli", "wolffish.mjs");

        if (!File.Exists(app) || !File.Exists(entry))
        {
            Console.Error.WriteLine(
                "wolffish: this launcher must sit beside wolffish.exe and resources\\cli\\wolffish.mjs.");
            Console.Error.WriteLine("  looked in: " + dir);
            return 1;
        }

        IntPtr hIn = GetStdHandle(StdInput);
        IntPtr hOut = GetStdHandle(StdOutput);
        IntPtr hErr = GetStdHandle(StdError);

        bool stdinIsConsole = IsConsole(hIn);
        bool stdoutIsConsole = IsConsole(hOut);

        // ELECTRON_RUN_AS_NODE turns the shipped Electron binary into a plain
        // node, so the CLI needs no separate runtime and no window ever opens.
        // Set on ourselves and inherited: lpEnvironment is NULL below, which
        // gives the child a copy of this process's block.
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");

        int savedOutputCp = 0;
        int savedInputCp = 0;
        uint savedOutMode = 0;
        bool restoreMode = false;

        try
        {
            if (stdoutIsConsole)
            {
                // Own the console's presentation for the length of this command.
                // The CLI defaults to ASCII on Windows because a legacy conhost
                // on codepage 437 turns UTF-8 into mojibake — which is what a
                // bare `wolffish` printed. Rather than have the CLI guess, make
                // the guess unnecessary: switch the console to UTF-8, turn on
                // VT sequences, and tell it what is now true.
                savedOutputCp = GetConsoleOutputCP();
                savedInputCp = GetConsoleCP();
                bool utf8 = SetConsoleOutputCP(Utf8);
                if (stdinIsConsole) SetConsoleCP(Utf8);

                bool vt = false;
                if (GetConsoleMode(hOut, out savedOutMode))
                {
                    restoreMode = true;
                    vt = SetConsoleMode(hOut, savedOutMode | EnableVirtualTerminalProcessing);
                }

                Environment.SetEnvironmentVariable("WOLFFISH_TTY_STDOUT", "1");
                if (vt) Environment.SetEnvironmentVariable("FORCE_COLOR", "1");
                if (utf8) Environment.SetEnvironmentVariable("WOLFFISH_UNICODE", "1");
                ExportConsoleSize();
            }

            StartupInfo si = new StartupInfo();
            si.cb = Marshal.SizeOf(typeof(StartupInfo));
            si.dwFlags = StartfUseStdHandles;
            si.hStdOutput = Inheritable(hOut);
            si.hStdError = Inheritable(hErr);

            IntPtr pumpWriteEnd = IntPtr.Zero;
            if (stdinIsConsole)
            {
                // The child cannot read a console handle. Give it a pipe and
                // feed it from here, where reading works.
                SecurityAttributes sa = new SecurityAttributes();
                sa.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
                sa.lpSecurityDescriptor = IntPtr.Zero;
                sa.bInheritHandle = true;

                IntPtr readEnd, writeEnd;
                if (CreatePipe(out readEnd, out writeEnd, ref sa, 0))
                {
                    // Only the child's END may be inherited. A write end that
                    // leaks into the child means the pipe never reports EOF,
                    // because the child itself is holding it open.
                    SetHandleInformation(writeEnd, HandleFlagInherit, 0);
                    si.hStdInput = readEnd;
                    pumpWriteEnd = writeEnd;
                    Environment.SetEnvironmentVariable("WOLFFISH_TTY_STDIN", "1");
                    StartControlServer(hIn);
                }
                else
                {
                    si.hStdInput = Inheritable(hIn);
                }
            }
            else
            {
                // A real pipe or file from the shell: hand it straight over, so
                // `cat log.txt | wolffish -p "why?"` keeps working untouched.
                si.hStdInput = Inheritable(hIn);
            }

            StringBuilder cmd = new StringBuilder();
            cmd.Append(Quote(app)).Append(' ').Append(Quote(entry));
            string rest = ArgumentTail();
            if (rest.Length > 0) cmd.Append(' ').Append(rest);

            ProcessInformation pi;
            if (!CreateProcess(app, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi))
            {
                int err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("wolffish: could not start " + app + " (error " + err + ")");
                return 1;
            }

            _child = pi.hProcess;
            CloseHandle(pi.hThread);

            if (pumpWriteEnd != IntPtr.Zero)
            {
                CloseHandle(si.hStdInput); // the child owns its copy now
                StartStdinPump(hIn, pumpWriteEnd);
            }

            Console.CancelKeyPress += delegate (object sender, ConsoleCancelEventArgs e)
            {
                // Stay alive long enough to report a code; the child is what
                // the user meant to interrupt.
                e.Cancel = true;
                if (_child != IntPtr.Zero) TerminateProcess(_child, 130);
            };

            WaitForSingleObject(pi.hProcess, Infinite);

            uint code;
            if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
            CloseHandle(pi.hProcess);
            _child = IntPtr.Zero;
            return unchecked((int)code);
        }
        finally
        {
            // The console outlives this command. Leaving it on UTF-8 with VT
            // enabled would be this program editing the user's shell.
            if (savedOutputCp != 0) SetConsoleOutputCP((uint)savedOutputCp);
            if (savedInputCp != 0) SetConsoleCP((uint)savedInputCp);
            if (restoreMode) SetConsoleMode(hOut, savedOutMode);
            // A CLI that died between "echo 0" and "echo 1" would otherwise
            // hand the user back a terminal that types nothing.
            if (_consoleIn != IntPtr.Zero) SetConsoleMode(_consoleIn, _consoleInMode);
        }
    }

    /// <summary>
    /// A control channel the child can use to turn console echo off and on.
    /// </summary>
    /// <remarks>
    /// Masked input is the one thing cooked-mode pumping takes away and cannot
    /// give back on its own. Inside a session the CLI masks by muting
    /// readline's own writer, which works only when readline is painting the
    /// line — under this launcher it is not, and the CONSOLE is doing the
    /// echoing, so a bot token typed at `/settings → Telegram` went to the
    /// scrollback in clear.
    ///
    /// Echo belongs to whoever owns the console, and that is this process. So
    /// the child asks. A named pipe rather than a marker in the output stream:
    /// stdout is handed to the child directly and never passes back through
    /// here, so there is nothing on that path to parse — and adding a parser
    /// would mean pumping stdout too, which is latency on every byte the CLI
    /// ever prints, to serve a prompt that appears twice a year.
    ///
    /// Failure is safe in the right direction: if the pipe never connects the
    /// CLI sees that and says the input will be visible, rather than believing
    /// it is masked when it is not.
    /// </remarks>
    private static void StartControlServer(IntPtr consoleIn)
    {
        if (!GetConsoleMode(consoleIn, out _consoleInMode)) return;
        _consoleIn = consoleIn;

        string name = "wolffish-cli-" + Process_GetCurrentProcessId();
        Environment.SetEnvironmentVariable("WOLFFISH_CONSOLE_CTL", @"\\.\pipe\" + name);

        Thread server = new Thread(delegate ()
        {
            try
            {
                while (true)
                {
                    // InOut, though nothing is ever sent back: libuv opens a
                    // named pipe client with GENERIC_READ | GENERIC_WRITE, and
                    // an inbound-only server refuses that access. The connect
                    // still reported success on the Node side, so the symptom
                    // was a channel that looked open and delivered nothing.
                    using (NamedPipeServerStream pipe = new NamedPipeServerStream(
                        name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None))
                    {
                        pipe.WaitForConnection();
                        using (StreamReader reader = new StreamReader(pipe))
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                Debug("ctl recv: " + line);
                                if (line == "echo 0") SetEcho(false);
                                else if (line == "echo 1") SetEcho(true);
                            }
                        }
                    }
                    // A disconnect mid-prompt must not leave the console mute.
                    SetEcho(true);
                }
            }
            catch
            {
                SetEcho(true);
            }
        });
        server.IsBackground = true;
        server.Start();
    }

    private static void SetEcho(bool on)
    {
        if (_consoleIn == IntPtr.Zero) return;
        uint mode;
        if (!GetConsoleMode(_consoleIn, out mode)) { Debug("SetEcho: GetConsoleMode failed"); return; }
        // Restore only the bit we cleared, and only if it was set to begin
        // with — a console that arrived without echo keeps its own settings.
        uint wanted = on ? (mode | (_consoleInMode & EnableEchoInput)) : (mode & ~EnableEchoInput);
        bool ok = SetConsoleMode(_consoleIn, wanted);
        Debug(string.Format(
            "SetEcho(on={0}) mode={1:X} -> wanted={2:X} ok={3} err={4}",
            on, mode, wanted, ok, ok ? 0 : Marshal.GetLastWin32Error()));
    }

    /// <summary>
    /// Diagnostics for the one part of this program nothing else can see.
    /// </summary>
    /// <remarks>
    /// Console mode changes leave no trace in stdout, no exit code and no
    /// visible effect a test can assert on — the only symptom is a secret that
    /// appears on screen when it should not. Set WOLFFISH_CLI_DEBUG to a path
    /// to find out what actually happened; unset, it costs one null check.
    /// </remarks>
    private static void Debug(string message)
    {
        string target = Environment.GetEnvironmentVariable("WOLFFISH_CLI_DEBUG");
        if (string.IsNullOrEmpty(target)) return;
        try
        {
            File.AppendAllText(target, message + Environment.NewLine);
        }
        catch
        {
            // Diagnostics must never be the reason a command fails.
        }
    }

    private static int Process_GetCurrentProcessId()
    {
        using (System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess())
        {
            return self.Id;
        }
    }

    /// <summary>
    /// Copy console input to the child's stdin pipe until the console ends.
    /// </summary>
    /// <remarks>
    /// A background thread so it cannot keep the process alive past the child:
    /// this read blocks until someone types, and at the end of a session nobody
    /// ever will.
    ///
    /// Cooked reads, deliberately — no raw mode. The console gives back whole
    /// lines with its own editing already applied, which is the only line
    /// discipline available once the child is off the TTY, and a better one
    /// than the CLI could rebuild over a pipe.
    /// </remarks>
    private static void StartStdinPump(IntPtr console, IntPtr pipe)
    {
        Thread pump = new Thread(delegate ()
        {
            byte[] buffer = new byte[4096];
            try
            {
                while (true)
                {
                    uint read;
                    if (!ReadFile(console, buffer, (uint)buffer.Length, out read, IntPtr.Zero)) break;
                    if (read == 0) break; // ^Z
                    uint written;
                    if (!WriteFile(pipe, buffer, read, out written, IntPtr.Zero)) break;
                }
            }
            catch
            {
                // The child closed its end, or the console went away. Either
                // way there is nothing left to forward.
            }
            finally
            {
                CloseHandle(pipe); // EOF for the child
            }
        });
        pump.IsBackground = true;
        pump.Start();
    }

    /// <summary>
    /// Terminal size, which the child has no way to ask for.
    /// </summary>
    private static void ExportConsoleSize()
    {
        try
        {
            Environment.SetEnvironmentVariable(
                "COLUMNS", Console.WindowWidth.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Environment.SetEnvironmentVariable(
                "LINES", Console.WindowHeight.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        catch
        {
            // No console geometry to report; the CLI has its own fallback.
        }
    }

    /// <summary>
    /// Is this handle a real console, as opposed to merely a character device?
    /// </summary>
    /// <remarks>
    /// GetFileType is NOT sufficient, and the difference is not academic: NUL
    /// reports FILE_TYPE_CHAR exactly like a console does. Trusting it meant
    /// `wolffish conversations &lt; NUL` was told a human was present, so the
    /// listing stopped to ask a question of a stream that was already at EOF
    /// and hung there forever. GetConsoleMode succeeds only for a genuine
    /// console handle, and this process is attached to the console, so it is
    /// entitled to ask.
    /// </remarks>
    private static bool IsConsole(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == Invalid) return false;
        if (GetFileType(handle) != FileTypeChar) return false;
        uint mode;
        return GetConsoleMode(handle, out mode);
    }

    /// <summary>
    /// A standard handle the child is allowed to inherit.
    /// </summary>
    /// <remarks>
    /// A handle only crosses CreateProcess if it is MARKED inheritable.
    /// Redirected handles arrive that way; console handles need not, and an
    /// uninheritable one is the silent-no-output bug all over again.
    ///
    /// Console handles need nothing further. An earlier draft reopened them
    /// through CONOUT$/CONIN$ on the theory that a console handle is
    /// meaningless to an unattached process — true on Windows 7, false since
    /// Windows 8, where the console became the ConDrv device and its handles
    /// became ordinary kernel handles. Measured both ways: identical, so the
    /// detour is gone.
    /// </remarks>
    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == Invalid) return handle;
        SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit);
        return handle;
    }

    /// <summary>
    /// Our own command line with argv[0] removed, byte for byte.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT rebuilt from a parsed string[] args. Re-quoting an
    /// already-unescaped argument list is the classic way to mangle a prompt
    /// containing quotes or backslashes — and this CLI is mostly invoked as
    /// `wolffish -p "..."`, so that is the common case, not the edge case.
    /// Passing the tail through untouched means the child's parser sees exactly
    /// what the user typed.
    /// </remarks>
    private static string ArgumentTail()
    {
        string line = Environment.CommandLine;
        int i = 0;
        if (i < line.Length && line[i] == '"')
        {
            i++;
            while (i < line.Length && line[i] != '"') i++;
            i++;
        }
        else
        {
            while (i < line.Length && !char.IsWhiteSpace(line[i])) i++;
        }
        while (i < line.Length && char.IsWhiteSpace(line[i])) i++;
        return i >= line.Length ? string.Empty : line.Substring(i);
    }

    private static string Quote(string value)
    {
        return "\"" + value + "\"";
    }
}
