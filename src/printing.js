const net = require("net");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { getPool } = require("./database");
const { printRawUsb } = require("./usbPrinters");

const PRINTER_PORT = 9100;
const PRINT_TIMEOUT_MS = 5000;

// Folio sin ceros a la izquierda: "016" → "16". Alfanuméricos (POS) sin cambios.
function formatFolio(folio) {
  if (folio == null || folio === "") return "";
  const s = String(folio);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

// Impresoras activas de la sucursal — se actualiza via setPrinters()
let activePrinters = [];

// Actualiza la lista de impresoras activas.
function setPrinters(printers) {
  activePrinters = (printers || []).filter((p) => p.is_active !== false);
  console.log(`[PRINT] ${activePrinters.length} impresora(s) configurada(s)`);
}

function getPrinters() {
  return activePrinters;
}

// ============================================================
// Clasificacion
// ============================================================

// Retorna un mapa idproducto → clasificacion consultando la tabla grupos de SR.
async function getClasificacionFromSR(items) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Obtener idgrupo de cada producto
    const ids = items.map((i) => `'${i.idproducto}'`).join(",");
    const result = await pool.request().query(`
      SELECT p.idproducto, ISNULL(gc.clasificacionventa, g.clasificacion) AS clasificacion
      FROM productos p
      INNER JOIN grupos g ON p.idgrupo = g.idgrupo
      LEFT JOIN gruposiclasificacion gc ON g.clasificacion = gc.idgruposiclasificacion
      WHERE p.idproducto IN (${ids})
    `);

    const map = new Map();
    for (const row of result.recordset) {
      map.set(row.idproducto, row.clasificacion);
    }
    return map;
  } catch (err) {
    console.warn(
      "[PRINT] No se pudo obtener clasificacion desde SR:",
      err.message,
    );
    return null;
  }
}

// Determina los roles de impresora destino según clasificacion.
function rolsForClasificacion(clasificacion) {
  switch (Number(clasificacion)) {
    case 1:
      return ["bar", "all"];
    case 2:
      return ["kitchen", "all"];
    case 3:
      return ["other", "all"];
    default:
      return ["all"];
  }
}

// ============================================================
// ESC/POS helpers
// ============================================================

const ESC = 0x1b;
const GS = 0x1d;

function init() {
  return Buffer.from([ESC, 0x40]);
}
function alignLeft() {
  return Buffer.from([ESC, 0x61, 0x00]);
}
function alignCenter() {
  return Buffer.from([ESC, 0x61, 0x01]);
}
function doubleSize() {
  return Buffer.from([ESC, 0x21, 0x30]);
} // doble ancho+alto
function doubleWidth() {
  return Buffer.from([ESC, 0x21, 0x10]);
} // doble ancho solo
function normalSize() {
  return Buffer.from([ESC, 0x21, 0x00]);
} // texto normal
function feedAndCut() {
  return Buffer.from([0x0a, 0x0a, 0x0a, GS, 0x56, 0x00]);
}
function ascii(str) {
  return Buffer.from(str, "ascii");
}

const SEPARATOR = "========================";

const LOGO_PATH = path.join(__dirname, "..", "assets", "asterisk-black-print.png");
let _logoBytesCache = null;

async function getLogoBitmapBytes(targetWidth = 44) {
  if (_logoBytesCache) return _logoBytesCache;
  try {
    const raw = fs.readFileSync(LOGO_PATH);
    const png = PNG.sync.read(raw);
    const scale = targetWidth / png.width;
    const w = targetWidth;
    const h = Math.round(png.height * scale);
    const bytesPerRow = Math.ceil(w / 8);
    const bitmap = [];
    for (let y = 0; y < h; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < w) {
            const srcX = Math.floor(x / scale);
            const srcY = Math.floor(y / scale);
            const idx = (srcY * png.width + Math.min(srcX, png.width - 1)) * 4;
            const luma = 0.299 * png.data[idx] + 0.587 * png.data[idx + 1] + 0.114 * png.data[idx + 2];
            if (luma < 128) byte |= 1 << (7 - bit);
          }
        }
        bitmap.push(byte);
      }
    }
    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = h & 0xff;
    const yH = (h >> 8) & 0xff;
    _logoBytesCache = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH, ...bitmap]);
    return _logoBytesCache;
  } catch {
    return null;
  }
}

// Genera el buffer ESC/POS para un ticket de producción.
async function buildTicket({
  role,
  mesa,
  nopersonas,
  mesero,
  items,
  notas,
  folio,
  identifier,
  orderedBy = null,
}) {
  const now = new Date();
  const fecha =
    `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()} ` +
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  const ordenLabel = formatFolio(folio);
  const buf = [];

  // Init + center
  buf.push(init());
  buf.push(alignCenter());

  // Header: MESA XX (double size)
  buf.push(doubleSize());
  const mesaNum = identifier
    ? identifier.match(/\d+/)?.[0]
    : String(mesa).padStart(2, "0");
  buf.push(ascii(`MESA ${mesaNum ? String(mesaNum).padStart(2, "0") : identifier || mesa}\n`));

  if (orderedBy) {
    buf.push(ascii(`${orderedBy.toUpperCase()}\n`));
  }

  // Align left + height x2 for date/mesa section
  buf.push(alignLeft());
  buf.push(Buffer.from([GS, 0x21, 0x01]));

  buf.push(ascii(`\nNUMERO DE ORDEN: ${ordenLabel}\n`));
  buf.push(ascii(`${fecha}\n`));

  if (identifier) {
    const num = identifier.match(/\d+/)?.[0];
    if (/habitaci/i.test(identifier) || /cuarto/i.test(identifier)) {
      buf.push(ascii(`HABITACION: ${num || identifier} MESERO: EVEN\n\n`));
    } else if (/pick/i.test(identifier)) {
      buf.push(ascii(`MESERO: EVEN\n\n`));
    } else {
      buf.push(ascii(`MESA: ${num ? String(num).padStart(2, "0") : identifier} MESERO: EVEN\n\n`));
    }
  } else {
    const meseroLabel = mesero ? `MESERO: ${mesero}` : "MESERO: EVEN";
    buf.push(ascii(`MESA: ${String(mesa).padStart(2, "0")} - PERSONAS:${nopersonas} ${meseroLabel}\n\n`));
  }

  buf.push(ascii(`${SEPARATOR}\n`));

  // Notes before items (matches crew format)
  if (notas && notas.trim()) {
    buf.push(ascii(`COMENTARIO: ${notas.trim().toUpperCase()}\n`));
    buf.push(ascii(`${SEPARATOR}\n`));
  }

  // Items with custom fields
  for (const item of items) {
    const qty = Math.round(Number(item.cantidad));
    const nombre = (item.nombre || item.name || item.idproducto || "???").toUpperCase();
    buf.push(ascii(`${qty} ${nombre}\n`));
    if (item.custom_fields) {
      for (const field of item.custom_fields) {
        const opts = (field.selectedOptions || []).map((o) => o.optionName).join(", ");
        if (opts) buf.push(ascii(`  ${field.fieldName}: ${opts}\n`));
      }
    }
    if (item.special_instructions) {
      buf.push(ascii(`  Nota: ${item.special_instructions}\n`));
    }
  }

  buf.push(ascii(`${SEPARATOR}\n`));

  // Reset size + center + logo + 6 feeds + cut
  buf.push(normalSize());
  buf.push(alignCenter());
  const logo = await getLogoBitmapBytes();
  if (logo) {
    buf.push(Buffer.from([0x0a]));
    buf.push(logo);
  }
  buf.push(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, GS, 0x56, 0x00]));

  return Buffer.concat(buf);
}

// ============================================================
// Envío TCP
// ============================================================

function sendToPrinter(ip, port, data) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (err) => {
      if (!done) {
        done = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      }
    };

    socket.setTimeout(PRINT_TIMEOUT_MS);
    socket.on("timeout", () =>
      finish(new Error(`Timeout conectando a ${ip}:${port}`)),
    );
    socket.on("error", finish);
    socket.connect(port, ip, () => {
      socket.write(data, () => finish());
    });
  });
}

// ============================================================
// Lógica principal
// ============================================================

// Imprime los tickets correspondientes a una orden.
async function printOrderTickets(orderData, rawOrder, folio) {
  if (activePrinters.length === 0) {
    console.log("[PRINT] Sin impresoras configuradas, omitiendo impresión");
    return;
  }

  // Obtener clasificacion de SR si está disponible
  const srMap = await getClasificacionFromSR(orderData.items);

  // Construir items enriquecidos con clasificacion final
  const enrichedItems = orderData.items.map((item, idx) => {
    const rawItem = (rawOrder.items || [])[idx] || {};
    // Prioridad: SR > payload del backend > null
    const clasificacion = srMap
      ? (srMap.get(item.idproducto) ?? rawItem.clasificacion ?? null)
      : (rawItem.clasificacion ?? null);

    return {
      idproducto: item.idproducto,
      nombre: rawItem.name || item.idproducto,
      cantidad: item.cantidad,
      clasificacion,
    };
  });

  // Agrupar items por rol destino
  const byRole = new Map();
  for (const item of enrichedItems) {
    const roles = rolsForClasificacion(item.clasificacion);
    for (const role of roles) {
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(item);
    }
  }

  // Imprimir en cada impresora activa que tenga items para su rol
  const jobs = [];

  for (const printer of activePrinters) {
    const role = printer.role || "all";
    const items = byRole.get(role) || [];

    if (items.length === 0) continue;

    const ticketBuf = await buildTicket({
      role,
      mesa: orderData.mesa,
      folio,
      nopersonas: orderData.nopersonas || 1,
      mesero: orderData.idmesero || "",
      items,
      notas: rawOrder.notes || "",
    });

    if (printer.connection_type === "usb" && printer.usb_device_name) {
      jobs.push(
        printRawUsb(printer.usb_device_name, ticketBuf)
          .then(() =>
            console.log(
              `[PRINT] ✅ Ticket USB enviado a ${printer.usb_device_name} (${role})`,
            ),
          )
          .catch((err) =>
            console.error(
              `[PRINT] ❌ Error USB ${printer.usb_device_name}: ${err.message}`,
            ),
          ),
      );
    } else {
      jobs.push(
        sendToPrinter(printer.ip, printer.port || PRINTER_PORT, ticketBuf)
          .then(() =>
            console.log(`[PRINT] ✅ Ticket enviado a ${printer.ip} (${role})`),
          )
          .catch((err) =>
            console.error(
              `[PRINT] ❌ Error enviando a ${printer.ip}: ${err.message}`,
            ),
          ),
      );
    }
  }

  await Promise.allSettled(jobs);
}

// ============================================================
// Print job desde backend (FlexBill, Tap, Room, Pick&Go)
// Items ya vienen enriquecidos con clasificacion
// ============================================================

async function printJobFromBackend({ items, orderInfo }) {
  if (activePrinters.length === 0) {
    console.log("[PRINT] Sin impresoras configuradas, omitiendo print_job");
    return;
  }

  const identifier = orderInfo?.identifier || "Orden";

  // Agrupar items por rol destino (clasificacion ya viene del backend)
  const byRole = new Map();
  for (const item of items) {
    const roles = rolsForClasificacion(item.clasificacion);
    for (const role of roles) {
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push({
        nombre: item.name,
        cantidad: item.quantity,
        custom_fields: item.custom_fields || null,
        special_instructions: item.special_instructions || null,
      });
    }
  }

  const jobs = [];
  const jobLabels = [];

  for (const printer of activePrinters) {
    const role = printer.role || "all";
    const printerItems = byRole.get(role) || [];
    if (printerItems.length === 0) continue;

    const ticketBuf = await buildTicket({
      role,
      identifier,
      items: printerItems,
      notas: orderInfo?.notes ?? "",
      folio: orderInfo?.folio ?? null,
      orderedBy: orderInfo?.orderedBy ?? null,
    });

    if (printer.connection_type === "usb" && printer.usb_device_name) {
      jobs.push(printRawUsb(printer.usb_device_name, ticketBuf));
      jobLabels.push(`USB:${printer.usb_device_name}(${role})`);
    } else {
      jobs.push(sendToPrinter(printer.ip, printer.port || PRINTER_PORT, ticketBuf));
      jobLabels.push(`TCP:${printer.ip}(${role})`);
    }
  }

  if (jobs.length === 0) return;

  const results = await Promise.allSettled(jobs);
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      console.log(`[PRINT] ✅ print_job enviado a ${jobLabels[i]}`);
    } else {
      console.error(`[PRINT] ❌ Error en ${jobLabels[i]}: ${r.reason?.message}`);
      failures.push(jobLabels[i]);
    }
  });

  if (failures.length > 0) {
    throw new Error(`Fallo en impresoras: ${failures.join(", ")}`);
  }
}

function buildTestTicketUsb(printerName) {
  const now = new Date();
  const fecha =
    now.toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }) +
    " " +
    now.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const buf = [];
  buf.push(init(), alignCenter(), doubleSize());
  buf.push(ascii("\n== CUENTA NUEVA ==\n"));
  buf.push(doubleWidth());
  buf.push(ascii(`\nEVEN PRINT USB\n${fecha}\n`));
  buf.push(ascii(`${SEPARATOR}\n`));
  buf.push(ascii(`Impresora: ${printerName}\n`));
  buf.push(ascii(`${SEPARATOR}\n`));
  buf.push(ascii("Asigna nombre y rol\n"));
  buf.push(ascii("desde Impresoras.\n"));
  buf.push(ascii(`${SEPARATOR}\n`));
  buf.push(feedAndCut());
  return Buffer.concat(buf);
}

module.exports = {
  setPrinters,
  getPrinters,
  printOrderTickets,
  printJobFromBackend,
  buildTestTicketUsb,
};
