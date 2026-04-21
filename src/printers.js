// Printers Module - Detección de impresoras via WiFi (puerto 9100) y USB

const net = require("net");
const os = require("os");
const { listLocalPrinters, printRawUsb } = require("./usbPrinters");

const PRINTER_PORT = 9100;
const SCAN_TIMEOUT_MS = 500;
const SCAN_CONCURRENCY = 50;

/**
 * Detecta el subnet local de la máquina.
 * Ej: IP 192.168.1.50 → retorna "192.168.1"
 */
function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      const [a, b] = iface.address.split(".").map(Number);
      // Solo rangos privados LAN (excluye Tailscale 100.x y otros)
      const isLan =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168);
      if (isLan) candidates.push(iface.address);
    }
  }

  if (candidates.length === 0) return null;
  // Preferir Wi-Fi/Ethernet sobre VPN: tomar el primero del rango más común
  const parts = candidates[0].split(".");
  return parts.slice(0, 3).join(".");
}

/**
 * Prueba si una IP tiene el puerto 9100 abierto.
 * Retorna { ip, reachable: true/false }
 */
function probeIp(ip) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const done = (reachable) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ ip, reachable });
      }
    };

    socket.setTimeout(SCAN_TIMEOUT_MS);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));

    socket.connect(PRINTER_PORT, ip);
  });
}

/**
 * Escanea todo el subnet en paralelo (lotes de SCAN_CONCURRENCY).
 * Retorna array de IPs con impresoras encontradas.
 */
async function scanPrinters(subnet) {
  const targets = [];
  for (let i = 1; i <= 254; i++) {
    targets.push(`${subnet}.${i}`);
  }

  const found = [];

  for (let i = 0; i < targets.length; i += SCAN_CONCURRENCY) {
    const batch = targets.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(probeIp));
    for (const r of results) {
      if (r.reachable) found.push(r.ip);
    }
  }

  return found;
}

// Escanea y retorna lista de impresoras con subnet detectado.
async function discoverPrinters() {
  const subnet = getLocalSubnet();
  if (!subnet) {
    throw new Error("No se pudo detectar la red local");
  }

  console.log(
    `[PRINTERS] Escaneando ${subnet}.0/24 en puerto ${PRINTER_PORT}...`,
  );
  const start = Date.now();
  const ips = await scanPrinters(subnet);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(
    `[PRINTERS] ${ips.length} impresora(s) encontrada(s) en ${elapsed}s`,
  );

  return {
    subnet,
    printers: ips.map((ip) => ({ ip, port: PRINTER_PORT })),
  };
}

/**
 * Registra los handlers WebSocket para el módulo de impresoras.
 * El backend puede solicitar un scan con el evento "scan_printers".
 */
function setupPrinterHandlers(syncSocket) {
  syncSocket.on("scan_printers", async (data) => {
    console.log("[PRINTERS] Scan solicitado, requestId:", data?.requestId);
    try {
      const result = await discoverPrinters();
      syncSocket.emit("scan_printers_ack", {
        requestId: data?.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[PRINTERS] Error en scan:", error.message);
      syncSocket.emit("scan_printers_ack", {
        requestId: data?.requestId,
        success: false,
        error: error.message,
      });
    }
  });
}

/**
 * Envía un ticket de prueba ESC/POS a una IP/puerto.
 */
function printTestTicket(ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resolved = false;

    const done = (err) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      }
    };

    socket.setTimeout(5000);
    socket.on("timeout", () =>
      done(new Error("Timeout al conectar con la impresora")),
    );
    socket.on("error", (err) => done(err));

    socket.connect(port, ip, () => {
      const now = new Date();
      const fecha = now.toLocaleDateString("es-MX");
      const hora = now.toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const buf = [];

      // Init ESC/POS
      buf.push(Buffer.from([0x1b, 0x40]));

      // Centrar
      buf.push(Buffer.from([0x1b, 0x61, 0x01]));

      // Texto doble ancho+alto
      buf.push(Buffer.from([0x1b, 0x21, 0x30]));
      buf.push(Buffer.from("XQUISITO\n", "ascii"));

      // Texto normal
      buf.push(Buffer.from([0x1b, 0x21, 0x00]));
      buf.push(Buffer.from("========================\n", "ascii"));
      buf.push(Buffer.from("     TICKET DE PRUEBA   \n", "ascii"));
      buf.push(Buffer.from("========================\n\n", "ascii"));

      // Alinear izquierda
      buf.push(Buffer.from([0x1b, 0x61, 0x00]));
      buf.push(Buffer.from(`IP:   ${ip}\n`, "ascii"));
      buf.push(Buffer.from(`Puerto: ${port}\n`, "ascii"));
      buf.push(Buffer.from(`Fecha: ${fecha} ${hora}\n\n`, "ascii"));

      // Centrar
      buf.push(Buffer.from([0x1b, 0x61, 0x01]));
      buf.push(Buffer.from("Asigna nombre y rol\n", "ascii"));
      buf.push(Buffer.from("desde el portal admin.\n", "ascii"));
      buf.push(Buffer.from("========================\n", "ascii"));

      // Feed + corte
      buf.push(Buffer.from([0x0a, 0x0a, 0x0a]));
      buf.push(Buffer.from([0x1d, 0x56, 0x00]));

      const data = Buffer.concat(buf);
      socket.write(data, () => done());
    });
  });
}

/**
 * Handler para imprimir ticket de prueba desde el backend.
 */
function setupPrinterTestHandler(syncSocket) {
  syncSocket.on("print_test", async (data) => {
    const { ip, port = PRINTER_PORT, requestId } = data || {};
    console.log(`[PRINTERS] Test ticket → ${ip}:${port}`);
    try {
      await printTestTicket(ip, port);
      syncSocket.emit("print_test_ack", { requestId, success: true, ip });
    } catch (error) {
      console.error(`[PRINTERS] Error test ticket: ${error.message}`);
      syncSocket.emit("print_test_ack", {
        requestId,
        success: false,
        ip,
        error: error.message,
      });
    }
  });
}

/**
 * Handler para listar impresoras USB/locales instaladas en Windows.
 */
function setupUsbPrinterHandlers(syncSocket) {
  syncSocket.on("list_usb_printers", async (data) => {
    console.log("[PRINTERS] Listando impresoras USB/locales, requestId:", data?.requestId);
    try {
      const names = await listLocalPrinters();
      syncSocket.emit("list_usb_printers_ack", {
        requestId: data?.requestId,
        success: true,
        printers: names.map((name) => ({ device_name: name, vendor_id: 0, product_id: 0 })),
      });
    } catch (error) {
      console.error("[PRINTERS] Error listando USB:", error.message);
      syncSocket.emit("list_usb_printers_ack", {
        requestId: data?.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  syncSocket.on("print_test_usb", async (data) => {
    const { printerName, requestId } = data || {};
    console.log(`[PRINTERS] Test USB → ${printerName}`);
    try {
      const { buildTestTicketUsb } = require("./printing");
      const ticket = buildTestTicketUsb(printerName);
      await printRawUsb(printerName, ticket);
      syncSocket.emit("print_test_usb_ack", { requestId, success: true, printerName });
    } catch (error) {
      console.error(`[PRINTERS] Error test USB: ${error.message}`);
      syncSocket.emit("print_test_usb_ack", {
        requestId,
        success: false,
        printerName,
        error: error.message,
      });
    }
  });
}

module.exports = {
  discoverPrinters,
  setupPrinterHandlers,
  setupPrinterTestHandler,
  setupUsbPrinterHandlers,
};
