/**
 * Xquisito Agent - Soft Restaurant Integration
 * Conecta con Xquisito Backend via WebSocket y sincroniza con SQL Server local
 */

const { io } = require("socket.io-client");
const sql = require("mssql");
const fs = require("fs");
const path = require("path");

// Cargar config desde path de Electron o local
const configPath =
  process.env.XQUISITO_CONFIG_PATH || path.join(__dirname, "..", "config.json");
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  console.error("Error cargando config:", err.message);
  process.exit(1);
}

// Estado global
let sqlPool = null;
let syncSocket = null;

// Notificar estado al proceso padre (Electron)
function sendStatus(connected) {
  if (process.send) {
    process.send({ type: "status", connected });
  }
}

// ============================================
// SQL Server Connection
// ============================================

async function connectSqlServer() {
  const opts = config.sqlServer.options || {};

  const sqlConfig = {
    server: config.sqlServer.host,
    database: config.sqlServer.database,
    port: config.sqlServer.port || 1433,
    options: {
      trustServerCertificate: opts.trustServerCertificate !== false,
      encrypt: opts.encrypt || false,
      trustedConnection: opts.trustedConnection || false,
    },
  };

  if (!opts.trustedConnection) {
    sqlConfig.user = config.sqlServer.user;
    sqlConfig.password = config.sqlServer.password;
  }

  sqlPool = await sql.connect(sqlConfig);
  console.log(
    "[SQL] Conectado a SQL Server" +
      (opts.trustedConnection ? " (Windows Auth)" : ""),
  );
  return sqlPool;
}

async function getActiveTurno() {
  const result = await sqlPool.request().query(`
    SELECT TOP 1 idturno, apertura FROM turnos WHERE cierre IS NULL ORDER BY idturno DESC
  `);
  return result.recordset[0] || null;
}

// ============================================
// SQL Operations - Orders
// ============================================

async function insertOrder(orderData) {
  const turno = await getActiveTurno();
  if (!turno) {
    throw new Error("No hay turno abierto en Soft Restaurant");
  }

  // Obtener siguiente numcheque
  const numchequeResult = await sqlPool.request().query(`
    SELECT ISNULL(MAX(numcheque), 0) + 1 as nextNumcheque FROM tempcheques
  `);
  const numcheque = numchequeResult.recordset[0].nextNumcheque;

  let subtotalSinImp = 0;
  let totalImpuesto = 0;

  orderData.items.forEach((item) => {
    const impuesto = item.impuesto || 16;
    const precioSinImp = item.precio / (1 + impuesto / 100);
    subtotalSinImp += precioSinImp * item.cantidad;
    totalImpuesto += (item.precio - precioSinImp) * item.cantidad;
  });
  const total = subtotalSinImp + totalImpuesto;

  const fecha = new Date();
  const cierre = orderData.prepagado ? fecha : null;

  const insertResult = await sqlPool
    .request()
    .input("fecha", sql.DateTime, fecha)
    .input("cierre", sql.DateTime, cierre)
    .input("numcheque", sql.Int, numcheque)
    .input("estacion", sql.VarChar, "XQUISITO")
    .input("mesa", sql.VarChar, orderData.mesa)
    .input("nopersonas", sql.Int, orderData.nopersonas || 1)
    .input("idmesero", sql.VarChar, orderData.idmesero || "01")
    .input("idarearestaurant", sql.VarChar, orderData.idarearestaurant || "03")
    .input("idempresa", sql.VarChar, orderData.idempresa || "1")
    .input("tipodeservicio", sql.Int, orderData.tipodeservicio || 3)
    .input("idturno", sql.BigInt, turno.idturno)
    .input("usuarioapertura", sql.VarChar, "XQUISITO")
    .input("subtotal", sql.Money, subtotalSinImp)
    .input("subtotalsinimpuestos", sql.Money, subtotalSinImp)
    .input("total", sql.Money, total)
    .input("totalconpropina", sql.Money, total)
    .input("totalimpuesto1", sql.Money, totalImpuesto)
    .input("totalconcargo", sql.Money, total)
    .input("totalconpropinacargo", sql.Money, total)
    .input("totalarticulos", sql.Numeric, orderData.items.length)
    .input("totalsindescuento", sql.Money, total)
    .input("totalalimentos", sql.Money, total)
    .input("totalcondonativo", sql.Money, total)
    .input("totalconpropinacargodonativo", sql.Money, total)
    .input(
      "observaciones",
      sql.VarChar,
      orderData.observaciones || "Pedido Xquisito",
    )
    .input("appname", sql.VarChar, "Xquisito")
    .input(
      "orderreference",
      sql.VarChar,
      orderData.orderReference || `XQ-${Date.now()}`,
    ).query(`
      INSERT INTO tempcheques (
        fecha, cierre, numcheque, estacion, mesa, nopersonas, idmesero,
        idarearestaurant, idempresa, tipodeservicio, idturno,
        usuarioapertura, subtotal, subtotalsinimpuestos,
        total, totalconpropina, totalimpuesto1, totalconcargo,
        totalconpropinacargo, totalarticulos, totalsindescuento,
        totalalimentos, totalcondonativo, totalconpropinacargodonativo,
        observaciones, appname, orderreference,
        pagado, cancelado, impreso, impresiones, reabiertas, facturado,
        propinapagada, propinamanual, comisionpagada, callcenter, enviado,
        EnviadoRW, totalimpuestod1, totalimpuestod2, totalimpuestod3,
        sistema_envio, idformadepagoDescuento, titulartarjetamonederodescuento,
        c_iddispositivo, salerestaurantid, esalestatus, statusSR, paymentreference,
        foodorder, cashpaymentwith, paymentmethod_id, surveycode, intentoEnvioAF,
        pedidovistosrx, impresoenbitacorasrm, TKC_Token, TKC_Transaction,
        TKC_Authorization, TKC_Cupon, TKC_ExpirationDate, TKC_Recompensa,
        campoadicional2, campoadicional3, estrateca_CardNumber, estrateca_VoucherText,
        campoadicional4, campoadicional5, sacoa_CardNumber, sacoa_credits,
        estrateca_TypeDisccount, estrateca_DiscountCode, estrateca_DiscountID,
        estrateca_DiscountAmount, donativo, status_domicilio, enviopagado,
        diet_restrictions, sl_cupon_descuento, sl_tipo_cupon, TUKI_CardNumber,
        WorkspaceId, SentSync, procesar_descuento_emenu, procesar_descuento_sr,
        imprimenotabluetooth, datosimpresionnotaconsumo, mv_room, mv_lastname
      )
      OUTPUT INSERTED.folio
      VALUES (
        @fecha, @cierre, @numcheque, @estacion, @mesa, @nopersonas, @idmesero,
        @idarearestaurant, @idempresa, @tipodeservicio, @idturno,
        @usuarioapertura, @subtotal, @subtotalsinimpuestos,
        @total, @totalconpropina, @totalimpuesto1, @totalconcargo,
        @totalconpropinacargo, @totalarticulos, @totalsindescuento,
        @totalalimentos, @totalcondonativo, @totalconpropinacargodonativo,
        @observaciones, @appname, @orderreference,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0,
        0, '', '',
        0, '', 0, 0, '',
        0, 0, 0, '', 0,
        0, 0, '', '',
        '', '', '', 0,
        '', '', '', '',
        '', '', '', 0,
        '', '', '',
        0, 0, 0, 0,
        '', '', '', '',
        NEWID(), 0, 0, 0,
        0, '', '', ''
      )
    `);

  const folio = insertResult.recordset[0].folio;

  let movimiento = 1;
  for (const item of orderData.items) {
    const impuesto = item.impuesto || 16;
    const precioSinImp = item.precio / (1 + impuesto / 100);

    await sqlPool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, item.precio)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("preciocatalogo", sql.Money, item.precio)
      .input("hora", sql.DateTime, new Date()).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos, preciocatalogo,
          hora, descuento, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor, nivel,
          sistema_envio, promovolumen, iddispositivo, productsyncidsr,
          subtotalsrx, totalsrx, idmovtobillar, impuestoimporte3,
          estrateca_DiscountCode, estrateca_DiscountID, estrateca_DiscountAmount,
          procesadosrx, escargoarea, WorkspaceId
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @impuesto1, 0, 0, @preciosinimpuestos, @preciocatalogo,
          @hora, 0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          '', '', 0,
          0, 0, NEWID()
        )
      `);
    movimiento++;
  }

  return {
    folio,
    total,
    subtotal: subtotalSinImp,
    tax: totalImpuesto,
    itemsCount: orderData.items.length,
  };
}

async function applyPayment(folio, amount, tenderId, reference) {
  const cheque = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT total FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) {
    throw new Error(`Folio ${folio} no encontrado`);
  }

  const totalCheque = cheque.recordset[0].total;
  const importePago = amount === 0 ? totalCheque : amount;

  let formaPago = tenderId;
  if (!formaPago) {
    const formas = await sqlPool.request().query(`
      SELECT TOP 1 idformadepago, descripcion
      FROM formasdepago
      ORDER BY prioridadboton ASC
    `);
    if (formas.recordset.length > 0) {
      formaPago = formas.recordset[0].idformadepago;
      console.log(`[PAYMENT] Forma de pago auto: ${formaPago}`);
    } else {
      throw new Error("No hay formas de pago en el sistema");
    }
  }

  await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("idformadepago", sql.VarChar, formaPago)
    .input("importe", sql.Money, importePago)
    .input("propina", sql.Money, 0)
    .input("referencia", sql.VarChar, reference || "XQUISITO").query(`
      INSERT INTO tempchequespagos (folio, idformadepago, importe, propina, referencia)
      VALUES (@folio, @idformadepago, @importe, @propina, @referencia)
    `);

  const totalPagado = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT ISNULL(SUM(importe), 0) as totalPagado FROM tempchequespagos WHERE folio = @folio`,
    );

  const pagadoCompleto = totalPagado.recordset[0].totalPagado >= totalCheque;

  if (pagadoCompleto) {
    await sqlPool
      .request()
      .input("folio", sql.BigInt, folio)
      .query(`UPDATE tempcheques SET pagado = 1 WHERE folio = @folio`);
  }

  return {
    success: true,
    pagado: pagadoCompleto,
    status: pagadoCompleto ? "closed" : "open",
    totalPagado: totalPagado.recordset[0].totalPagado,
    totalCheque,
  };
}

// ============================================
// Transform Functions
// ============================================

function transformOrder(xquisitoOrder) {
  return {
    mesa: xquisitoOrder.tableNumber || "XQ01",
    nopersonas: xquisitoOrder.guests || 1,
    idmesero: "01",
    idarearestaurant: "03",
    idempresa: "1",
    tipodeservicio: xquisitoOrder.orderType === "delivery" ? 2 : 3,
    observaciones: xquisitoOrder.notes || "",
    orderReference: xquisitoOrder.id || `XQ-${Date.now()}`,
    prepagado: xquisitoOrder.prepaid || false,
    items: (xquisitoOrder.items || []).map((item) => ({
      idproducto: item.productId || item.sku,
      cantidad: item.quantity || 1,
      precio: item.price || 0,
      impuesto: 16,
    })),
  };
}

// ============================================
// SQL Operations - Menu Sync
// ============================================

async function getMenuGroups() {
  const result = await sqlPool.request().query(`
    SELECT
      idgrupo,
      descripcion,
      prioridad,
      clasificacion
    FROM grupos
    ORDER BY prioridad ASC, descripcion ASC
  `);
  return result.recordset;
}

async function getMenuProducts() {
  const result = await sqlPool.request().query(`
    SELECT
      p.idproducto,
      p.descripcion,
      p.idgrupo,
      p.nombrecorto,
      p.descripcionmenuelectronico,
      p.imagen_menu,
      p.visible_menu,
      pd.precio,
      pd.preciosinimpuestos,
      pd.impuesto1,
      pd.bloqueado
    FROM productos p
    LEFT JOIN productosdetalle pd ON p.idproducto = pd.idproducto
    INNER JOIN grupos g ON p.idgrupo = g.idgrupo
    WHERE (p.visible_menu = 1 OR p.visible_menu IS NULL)
    ORDER BY p.idgrupo, p.descripcion
  `);
  return result.recordset;
}

async function createGroup(name, displayOrder) {
  // Generar ID único de 5 caracteres
  const idgrupo =
    name
      .substring(0, 4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "X") + Math.floor(Math.random() * 10).toString();

  await sqlPool
    .request()
    .input("idgrupo", sql.VarChar, idgrupo)
    .input("descripcion", sql.VarChar, name.substring(0, 30))
    .input("prioridad", sql.Numeric, displayOrder || 0)
    .input("clasificacion", sql.Numeric, 1).query(`
      INSERT INTO grupos (idgrupo, descripcion, prioridad, clasificacion, alcohol)
      VALUES (@idgrupo, @descripcion, @prioridad, @clasificacion, 0)
    `);

  return { idgrupo, descripcion: name };
}

async function createProduct(name, description, price, groupId) {
  // Generar ID de producto (15 chars max)
  const timestamp = Date.now().toString().slice(-8);
  const idproducto = `XQ${timestamp}`;

  const precioSinImp = price / 1.16; // Asumir 16% IVA

  // Insertar en productos
  await sqlPool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("descripcion", sql.VarChar, name.substring(0, 60))
    .input("idgrupo", sql.VarChar, groupId)
    .input("nombrecorto", sql.VarChar, name.substring(0, 20))
    .input(
      "descripcionmenuelectronico",
      sql.VarChar,
      (description || "").substring(0, 255),
    )
    .input("visible_menu", sql.Bit, 1).query(`
      INSERT INTO productos (
        idproducto, descripcion, idgrupo, nombrecorto,
        descripcionmenuelectronico, visible_menu,
        descripcion_detalle, calorias, capturar_pendientes,
        id_etiqueta, id_etiqueta_descripcion, idprodserv_SAT,
        usarVectorPlus, imagenme_modified, monitoreo
      )
      VALUES (
        @idproducto, @descripcion, @idgrupo, @nombrecorto,
        @descripcionmenuelectronico, @visible_menu,
        '', 0, 0,
        '', '', '',
        0, 0, 0
      )
    `);

  // Insertar en productosdetalle (precios)
  await sqlPool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("idempresa", sql.VarChar, "1")
    .input("precio", sql.Money, price)
    .input("preciosinimpuestos", sql.Money, precioSinImp)
    .input("impuesto1", sql.Numeric, 16)
    .input("bloqueado", sql.Bit, 0).query(`
      INSERT INTO productosdetalle (
        idproducto, idempresa, precio, preciosinimpuestos,
        impuesto1, impuesto2, impuesto3, bloqueado,
        precioabierto, canjeablepuntos
      )
      VALUES (
        @idproducto, @idempresa, @precio, @preciosinimpuestos,
        @impuesto1, 0, 0, @bloqueado,
        0, 0
      )
    `);

  return { idproducto, descripcion: name, precio: price };
}

// ============================================
// WebSocket Event Handlers
// ============================================

function setupEventHandlers() {
  syncSocket.on("new_order", async (data) => {
    console.log("[ORDER] Nueva orden:", data.requestId);
    try {
      const orderData = transformOrder(data);
      const result = await insertOrder(orderData);
      console.log(`[ORDER] Folio: ${result.folio}`);

      syncSocket.emit("order_ack", {
        requestId: data.requestId,
        orderId: data.id,
        folio: result.folio,
        success: true,
        totals: {
          subtotal: result.subtotal,
          tax: result.tax,
          total: result.total,
        },
      });
    } catch (error) {
      console.error("[ORDER] Error:", error.message);
      syncSocket.emit("order_ack", {
        requestId: data.requestId,
        orderId: data.id,
        success: false,
        error: error.message,
      });
    }
  });

  syncSocket.on("apply_payment", async (data) => {
    console.log(`[PAYMENT] Folio ${data.folio}, $${data.amount}`);
    try {
      const result = await applyPayment(
        data.folio,
        data.amount,
        data.tenderId,
        data.reference,
      );
      console.log(`[PAYMENT] ${result.status}`);
      syncSocket.emit("apply_payment_ack", {
        requestId: data.requestId,
        success: true,
        folio: data.folio,
        ...result,
      });
    } catch (error) {
      console.error("[PAYMENT] Error:", error.message);
      syncSocket.emit("apply_payment_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // Menu Sync Handlers
  // ============================================

  syncSocket.on("sync_menu_pull", async (data) => {
    console.log("[SYNC] ========================================");
    console.log("[SYNC] Pull de menú solicitado, requestId:", data.requestId);
    try {
      console.log("[SYNC] Obteniendo grupos...");
      const groups = await getMenuGroups();
      console.log(`[SYNC] Grupos obtenidos: ${groups.length}`);

      console.log("[SYNC] Obteniendo productos...");
      const products = await getMenuProducts();
      console.log(`[SYNC] Productos obtenidos: ${products.length}`);

      console.log(
        `[SYNC] Enviando respuesta con ${groups.length} grupos, ${products.length} productos`,
      );

      syncSocket.emit("sync_menu_pull_ack", {
        requestId: data.requestId,
        success: true,
        groups,
        products,
      });
      console.log("[SYNC] Respuesta enviada correctamente");
    } catch (error) {
      console.error("[SYNC] ❌ Error en pull:", error);
      console.error("[SYNC] Stack:", error.stack);
      syncSocket.emit("sync_menu_pull_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  syncSocket.on("sync_menu_push_group", async (data) => {
    console.log(`[SYNC] Crear grupo: ${data.name}`);
    try {
      const result = await createGroup(data.name, data.displayOrder);
      console.log(`[SYNC] Grupo creado: ${result.idgrupo}`);

      syncSocket.emit("sync_menu_push_group_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[SYNC] Error creando grupo:", error.message);
      syncSocket.emit("sync_menu_push_group_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  syncSocket.on("sync_menu_push_product", async (data) => {
    console.log(`[SYNC] Crear producto: ${data.name}`);
    try {
      const result = await createProduct(
        data.name,
        data.description,
        data.price,
        data.groupId,
      );
      console.log(`[SYNC] Producto creado: ${result.idproducto}`);

      syncSocket.emit("sync_menu_push_product_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[SYNC] Error creando producto:", error.message);
      syncSocket.emit("sync_menu_push_product_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });
}

// ============================================
// WebSocket Connection
// ============================================

function connectWebSocket() {
  console.log("[WS] Conectando a", config.xquisito.wsUrl);

  syncSocket = io(`${config.xquisito.wsUrl.replace("/sync", "")}/sync`, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  syncSocket.on("connect", () => {
    console.log("[WS] Conectado!");
    sendStatus(true);

    syncSocket.emit("register", {
      branchId: config.xquisito.branchId,
      syncToken: config.xquisito.syncToken,
      agentVersion: "1.0.0",
    });
  });

  syncSocket.on("register_ack", (data) => {
    console.log("[WS] Registrado:", data.message || "OK");
  });

  syncSocket.on("register_error", (data) => {
    console.error("[WS] Error registro:", data.error);
    sendStatus(false);
  });

  syncSocket.on("disconnect", (reason) => {
    console.log("[WS] Desconectado:", reason);
    sendStatus(false);
  });

  syncSocket.on("connect_error", (error) => {
    console.error("[WS] Error:", error.message);
    sendStatus(false);
  });

  setupEventHandlers();
}

// ============================================
// Main
// ============================================

async function main() {
  console.log("=".repeat(40));
  console.log("  XQUISITO AGENT");
  console.log("=".repeat(40));
  console.log(`Branch: ${config.xquisito.branchId}`);
  console.log("");

  try {
    await connectSqlServer();

    const turno = await getActiveTurno();
    if (turno) {
      console.log(`[SQL] Turno activo: ${turno.idturno}`);
    } else {
      console.warn("[SQL] No hay turno abierto");
    }

    connectWebSocket();
  } catch (error) {
    console.error("Error fatal:", error.message);
    sendStatus(false);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  console.log("\nCerrando...");
  if (syncSocket) syncSocket.close();
  if (sqlPool) await sqlPool.close();
  process.exit(0);
});

main();
