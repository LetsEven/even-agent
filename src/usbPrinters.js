const { execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

// ============================================================
// Detección — lista impresoras instaladas en Windows
// ============================================================

function listLocalPrinters() {
  return new Promise((resolve, reject) => {
    const script = `
$names = [System.Collections.Generic.List[string]]::new()
try { Get-WmiObject Win32_Printer | ForEach-Object { $names.Add($_.Name) } } catch {}
try {
  Get-PnpDevice -Class Printer -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.FriendlyName -and -not $names.Contains($_.FriendlyName)) { $names.Add($_.FriendlyName) }
  }
} catch {}
$names | Where-Object { $_ -ne $null -and $_.Trim() -ne '' }
`;
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        const names = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        resolve(names);
      },
    );
  });
}

// ============================================================
// Impresión raw ESC/POS vía Windows Spooler (P/Invoke)
// ============================================================

const RAW_PRINT_SCRIPT = `
param([string]$PrinterName, [string]$DataFile)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DOC_INFO_1 {
        public string pDocName;
        public string pOutputFile;
        public string pDatatype;
    }
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern int StartDocPrinter(IntPtr h, int lvl, ref DOC_INFO_1 di);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
}
"@
$data = [System.IO.File]::ReadAllBytes($DataFile)
$handle = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) { throw "OpenPrinter falló" }
$di = New-Object RawPrint+DOC_INFO_1
$di.pDocName = "ESCPOS"; $di.pOutputFile = $null; $di.pDatatype = "RAW"
if ([RawPrint]::StartDocPrinter($handle, 1, [ref]$di) -eq 0) { [RawPrint]::ClosePrinter($handle); throw "StartDocPrinter falló" }
[RawPrint]::StartPagePrinter($handle) | Out-Null
$written = 0
if (-not [RawPrint]::WritePrinter($handle, $data, $data.Length, [ref]$written)) { throw "WritePrinter falló" }
[RawPrint]::EndPagePrinter($handle) | Out-Null
[RawPrint]::EndDocPrinter($handle) | Out-Null
[RawPrint]::ClosePrinter($handle) | Out-Null
`;

function printRawUsb(printerName, dataBuffer) {
  return new Promise((resolve, reject) => {
    // Escribir datos a archivo temporal
    const tmpFile = path.join(os.tmpdir(), `xquisito_print_${Date.now()}.bin`);
    const ps1File = path.join(os.tmpdir(), `xquisito_print_${Date.now()}.ps1`);

    try {
      fs.writeFileSync(tmpFile, dataBuffer);
      fs.writeFileSync(ps1File, RAW_PRINT_SCRIPT, "utf8");
    } catch (e) {
      return reject(e);
    }

    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", ps1File,
        "-PrinterName", printerName,
        "-DataFile", tmpFile,
      ],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        // Limpiar archivos temporales
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.unlinkSync(ps1File); } catch {}

        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve();
      },
    );
  });
}

module.exports = { listLocalPrinters, printRawUsb };
