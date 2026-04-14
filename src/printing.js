const net = require("net");
const { getPool } = require("./database");

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
      SELECT p.idproducto, g.clasificacion
      FROM productos p
      INNER JOIN grupos g ON p.idgrupo = g.idgrupo
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

  // 1. Init + alinear izquierda
  buf.push(init());
  buf.push(alignLeft());

  // 2. Header: doble ancho+alto  →  \n== CUENTA NUEVA ==\n
  buf.push(doubleSize());
  buf.push(ascii(`\n== CUENTA NUEVA ==\n`));

  // 3. Resto en doble ancho solo
  buf.push(doubleWidth());

  // 4. Línea destino + orden
  buf.push(ascii(`\n${roleLabel}(${areaLabel}) ORDEN: ${orden}\n`));

  // 5. Fecha
  buf.push(ascii(`${fecha}\n`));

  // 6. Mesa, personas, mesero (mesero vacío si no viene del POS)
  const meseroLabel = mesero ? `MESERO: ${mesero}` : "MESERO: XQUISITO";
  buf.push(
    ascii(
      `MESA: ${String(mesa).padStart(2, "0")} - PERSONAS:${nopersonas} ${meseroLabel}\n`.trimEnd() +
        "\n",
    ),
  );

  // 7. Separador + items
  buf.push(ascii(`${SEPARATOR}\n`));
  for (const item of items) {
    const qty = Number(item.cantidad).toFixed(3);
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
      nopersonas: orderData.nopersonas || 1,
      mesero: orderData.idmesero || "",
      items,
      notas: rawOrder.notes || "",
    });

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

  await Promise.allSettled(jobs);
}

module.exports = {
  setPrinters,
  getPrinters,
  printOrderTickets,
};
