const net = require("net");
const { getPool } = require("./database");
const { printRawUsb } = require("./usbPrinters");

const PRINTER_PORT = 9100;
const PRINT_TIMEOUT_MS = 5000;

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
function feedAndCut() {
  return Buffer.from([0x0a, 0x0a, 0x0a, GS, 0x56, 0x00]);
}
function ascii(str) {
  return Buffer.from(str, "ascii");
}

const SEPARATOR = "========================";

// Mapa de rol → etiqueta del ticket
const ROLE_LABEL = {
  bar: "BARRA",
  kitchen: "COCINA",
  other: "OTROS",
  all: "GENERAL",
};

// idarearestaurant → etiqueta legible
const AREA_LABEL = {
  "01": "COMEDOR",
  "03": "RAPIDO",
};

// Genera el buffer ESC/POS para un ticket de producción.
function buildTicket({
  role,
  mesa,
  idarearestaurant,
  orden,
  nopersonas,
  mesero,
  items,
  notas,
  folio,
  identifier,
  orderedBy = null,
}) {
  const roleLabel = ROLE_LABEL[role] || "GENERAL";
  const areaLabel = AREA_LABEL[idarearestaurant] || "COMEDOR";

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

  // 1. Init + centrar
  buf.push(init());
  buf.push(alignCenter());

  // 2. Header centrado: doble ancho+alto
  buf.push(doubleSize());
  buf.push(ascii(`\n== CUENTA NUEVA ==\n`));

  // 2b. Folio centrado, siempre presente
  buf.push(ascii(`== ${String(folio).padStart(5, "0")} ==\n`));

  // 2c. Nombre del comensal (si existe), mismo tamaño centrado
  if (orderedBy) {
    buf.push(ascii(`${orderedBy.toUpperCase()}\n`));
  }

  // 3. Resto alineado izquierda, doble ancho solo
  buf.push(alignLeft());
  buf.push(doubleWidth());

  // 4. Línea destino + orden
  const ordenLabel = String(folio).padStart(5, "0");
  buf.push(ascii(`\n${roleLabel}(${areaLabel}) ORDEN: ${ordenLabel}\n`));

  // 5. Fecha
  buf.push(ascii(`${fecha}\n`));

  // 6. Mesa / Habitación / Pick & Go
  if (identifier) {
    const num = identifier.match(/\d+/)?.[0];
    if (/habitaci/i.test(identifier) || /cuarto/i.test(identifier)) {
      buf.push(ascii(`HABITACION: ${num || identifier} MESERO: EVEN\n\n`));
    } else if (/pick/i.test(identifier)) {
      buf.push(ascii(`MESERO: EVEN\n\n`));
    } else {
      // Mesa
      const mesaLabel = num ? String(num).padStart(2, "0") : identifier;
      buf.push(ascii(`MESA: ${mesaLabel} MESERO: EVEN\n\n`));
    }
  } else {
    // Formato SR POS: "MESA: 05 - PERSONAS:3 MESERO: JUAN"
    const meseroLabel = mesero ? `MESERO: ${mesero}` : "MESERO: EVEN";
    buf.push(
      ascii(
        `MESA: ${String(mesa).padStart(2, "0")} - PERSONAS:${nopersonas} ${meseroLabel}\n`.trimEnd() +
          "\n",
      ),
    );
  }

  // 7. Separador + items
  buf.push(ascii(`${SEPARATOR}\n`));
  for (const item of items) {
    const qty = Math.round(Number(item.cantidad));
    const nombre = (
      item.nombre ||
      item.name ||
      item.idproducto ||
      "???"
    ).toUpperCase();
    buf.push(ascii(`${qty} ${nombre}\n`));
    if (item.comment) {
      buf.push(ascii(`  ** ${item.comment.toUpperCase()} **\n`));
    }
  }

  // 8. Separador final
  buf.push(ascii(`${SEPARATOR}\n`));

  // 9. Notas (si hay)
  if (notas) {
    buf.push(ascii(`NOTA: ${notas}\n`));
    buf.push(ascii(`${SEPARATOR}\n`));
  }

  // 10. Feed + corte
  buf.push(feedAndCut());

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
      comment: item.comment || "",
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

    const ticketBuf = buildTicket({
      role,
      mesa: orderData.mesa,
      idarearestaurant: orderData.idarearestaurant || "01",
      orden: folio,
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
        comment: "",
      });
    }
  }

  const jobs = [];

  for (const printer of activePrinters) {
    const role = printer.role || "all";
    const printerItems = byRole.get(role) || [];
    if (printerItems.length === 0) continue;

    const ticketBuf = buildTicket({
      role,
      identifier,
      idarearestaurant: "01",
      items: printerItems,
      notas: "",
      folio: orderInfo?.folio ?? null,
      orderedBy: orderInfo?.orderedBy ?? null,
    });

    if (printer.connection_type === "usb" && printer.usb_device_name) {
      jobs.push(
        printRawUsb(printer.usb_device_name, ticketBuf)
          .then(() =>
            console.log(
              `[PRINT] ✅ print_job USB enviado a ${printer.usb_device_name} (${role})`,
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
            console.log(
              `[PRINT] ✅ print_job enviado a ${printer.ip} (${role})`,
            ),
          )
          .catch((err) =>
            console.error(`[PRINT] ❌ Error en ${printer.ip}: ${err.message}`),
          ),
      );
    }
  }

  await Promise.allSettled(jobs);
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
