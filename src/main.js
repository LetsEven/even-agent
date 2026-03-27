/**
 * Xquisito Agent - Electron Main Process
 * Integra sincronización con Soft Restaurant via WebSocket
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
} = require("electron");

// Quitar menú de la ventana
Menu.setApplicationMenu(null);
const path = require("path");
const fs = require("fs");
const { io } = require("socket.io-client");
const sql = require("mssql");
const sqlOnboarding = require("./sqlOnboarding");

let mainWindow = null;
let tray = null;
let isConnected = false;
let configPath = null;
let isQuitting = false;

// Agent state
let syncSocket = null;
let sqlPool = null;
let pingInterval = null;
let currentConfig = null;

// Redirigir logs al renderer para verlos en DevTools
const originalLog = console.log;
const originalError = console.error;

function sendLogToRenderer(type, args) {
  const msg = args
    .map((a) =>
      typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
    )
    .join(" ");
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents
      .executeJavaScript(
        `console.${type}('[AGENT] ${msg.replace(/'/g, "\\'")}');`,
      )
      .catch(() => {});
  }
}

console.log = (...args) => {
  originalLog(...args);
  sendLogToRenderer("log", args);
};

console.error = (...args) => {
  originalError(...args);
  sendLogToRenderer("error", args);
};

// ============================================
// Configuración
// ============================================

function getConfigPath() {
  if (!configPath) {
    const isDev = !app.isPackaged;
    configPath = isDev
      ? path.join(__dirname, "..", "config.json")
      : path.join(app.getPath("userData"), "config.json");
  }
  return configPath;
}

function configExists() {
  return fs.existsSync(getConfigPath());
}

function getConfig() {
  if (configExists()) {
    const content = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(content);
  }
  return null;
}

function saveConfig(branchId, syncToken) {
  // Mantener config SQL existente o usar defaults de Soft Restaurant
  const existing = getConfig();
  const sqlConfig = existing?.sqlServer || {
    host: "localhost",
    database: "softrestaurant10",
    port: 1433,
  };

  const config = {
    sqlServer: sqlConfig,
    xquisito: {
      branchId: branchId,
      syncToken: syncToken,
      wsUrl: "https://xquisito-backend-production.up.railway.app/sync",
    },
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
  return config;
}

// ============================================
// SQL Server
// ============================================

let sqlConfig = null;

async function connectSqlServer(config) {
  // Primero intentar usar credenciales del onboarding
  const onboardingConfig = sqlOnboarding.getSqlConfig();

  if (onboardingConfig) {
    sqlConfig = onboardingConfig;
    console.log("[SQL] Usando credenciales de onboarding");
  } else {
    // Fallback a config.json (compatibilidad)
    sqlConfig = {
      server: config.sqlServer.host || "localhost",
      database: config.sqlServer.database || "softrestaurant10",
      port: config.sqlServer.port || 1433,
      options: {
        trustServerCertificate: true,
        encrypt: true,
      },
      connectionTimeout: 30000,
      requestTimeout: 30000,
      pool: {
        min: 1,
        max: 10,
        idleTimeoutMillis: 30000,
      },
    };

    // Windows Auth o SQL Auth según config
    if (config.sqlServer.options?.trustedConnection) {
      sqlConfig.options.trustedConnection = true;
    } else {
      sqlConfig.user = config.sqlServer.user || "sa";
      sqlConfig.password = config.sqlServer.password || "";
    }
  }

  sqlPool = await sql.connect(sqlConfig);
  const authMethod = sqlConfig.options?.trustedConnection
    ? "Windows Auth"
    : "SQL Auth";
  console.log(`[SQL] Conectado a ${sqlConfig.server} (${authMethod})`);
  return sqlPool;
}

// Verificar y reconectar SQL si es necesario
async function ensureSqlConnection() {
  try {
    if (!sqlPool || !sqlPool.connected) {
      console.log("[SQL] Reconectando...");
      if (sqlPool) {
        try {
          await sqlPool.close();
        } catch (e) {}
      }
      sqlPool = await sql.connect(sqlConfig);
      console.log("[SQL] Reconectado");
    }
  } catch (error) {
    console.error("[SQL] Error reconectando:", error.message);
    throw error;
  }
}

async function getActiveTurno() {
  await ensureSqlConnection();
  const result = await sqlPool.request().query(`
    SELECT TOP 1 idturno, apertura FROM turnos WHERE cierre IS NULL ORDER BY idturno DESC
  `);
  return result.recordset[0] || null;
}

async function getNextNumCheque() {
  await ensureSqlConnection();

  const result = await sqlPool.request().query(`
    SELECT ISNULL(MAX(numcheque), 0) + 1 AS nextNumCheque
    FROM tempcheques
  `);

  return result.recordset[0].nextNumCheque;
}

// ============================================
// Promociones
// ============================================

/**
 * Consulta si un producto tiene promoción activa
 * Retorna: { hasPromo, preciopromocion, descuento, idtipodescuento, promovolumen }
 */
/*async function getActivePromo(idproducto, idempresa = "1") {
  await ensureSqlConnection();

  const result = await sqlPool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("idempresa", sql.VarChar, idempresa).query(`
      SELECT TOP 1
        pp.preciopromocion,
        pp.descuento,
        pp.idtipodescuento,
        p.descripcion as nombrepromo,
        p.promovolumen
      FROM promoproductos pp
      INNER JOIN promociones p ON pp.idpromocion = p.idpromocion
      WHERE pp.idproducto = @idproducto
        AND pp.idempresa = @idempresa
        AND p.status = 1
        AND (
          -- Validar fecha de vigencia
          (p.fechainicio IS NULL OR p.fechainicio <= GETDATE())
          AND (p.fechafin IS NULL OR p.fechafin >= GETDATE())
        )
      ORDER BY pp.preciopromocion ASC
    `);

  if (result.recordset.length > 0) {
    const promo = result.recordset[0];
    return {
      hasPromo: true,
      preciopromocion: promo.preciopromocion,
      descuento: promo.descuento || 0,
      idtipodescuento: promo.idtipodescuento || "",
      promovolumen: promo.promovolumen || 0,
      nombrepromo: promo.nombrepromo,
    };
  }

  return { hasPromo: false };
}*/

/**
 * Aplica promoción a un item si existe
 * Retorna el item con precio ajustado y campos de descuento
 */
/*async function applyPromoToItem(item, idempresa = "1") {
  const promo = await getActivePromo(item.idproducto, idempresa);

  if (!promo.hasPromo) {
    return {
      ...item,
      preciocatalogo: item.precio,
      descuento: 0,
      idtipodescuento: "",
      promovolumen: 0,
    };
  }

  let precioFinal = item.precio;
  let descuentoPorcentaje = 0;

  // Si hay precio de promo directo, usarlo
  if (promo.preciopromocion && promo.preciopromocion > 0) {
    precioFinal = promo.preciopromocion;
    descuentoPorcentaje = ((item.precio - precioFinal) / item.precio) * 100;
  }
  // Si hay descuento porcentual, calcularlo
  else if (promo.descuento && promo.descuento > 0) {
    descuentoPorcentaje = promo.descuento;
    precioFinal = item.precio * (1 - descuentoPorcentaje / 100);
  }

  console.log(
    `[PROMO] ${item.idproducto}: $${item.precio} -> $${precioFinal.toFixed(2)} (${descuentoPorcentaje.toFixed(1)}% off)`,
  );

  return {
    ...item,
    precio: precioFinal,
    preciocatalogo: item.precio, // Precio original
    descuento: descuentoPorcentaje,
    idtipodescuento: promo.idtipodescuento,
    promovolumen: promo.promovolumen,
  };
}*/

async function insertOrder(orderData) {
  await ensureSqlConnection();
  const turno = await getActiveTurno();
  const numcheque = await getNextNumCheque();
  if (!turno) throw new Error("No hay turno abierto en Soft Restaurant");

  const idempresa = orderData.idempresa || "1";

  // Aplicar promociones a cada item
  /*const itemsConPromo = [];
  for (const item of orderData.items) {
    const itemPromo = await applyPromoToItem(item, idempresa);
    itemsConPromo.push(itemPromo);
  }

  // Calcular totales con precios ya con descuento
  let totalSinDescuento = 0; // Total con precios originales*/
  let totalImpuesto = 0;
  let subtotalSinImp = 0;

  for (const item of orderData.items) {
    const impuesto = item.impuesto || 16;
    const precioSinImp = item.precio / (1 + impuesto / 100);

    subtotalSinImp += precioSinImp * item.cantidad;
    totalImpuesto += (item.precio - precioSinImp) * item.cantidad;
    //totalSinDescuento += item.preciocatalogo * item.cantidad;
  }
  const total = subtotalSinImp;
  //const descuentoTotal = totalSinDescuento - total;

  const insertResult = await sqlPool
    .request()
    .input("fecha", sql.DateTime, new Date())
    .input("cierre", sql.DateTime, new Date())
    .input("estacion", sql.VarChar, "XQUISITO")
    .input("numcheque", sql.BigInt, numcheque)
    .input("mesa", sql.VarChar, orderData.mesa || "XQ01")
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
    //.input("totalsindescuento", sql.Money, totalSinDescuento)
    //.input("descuentoimporte", sql.Money, descuentoTotal)
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
        fecha, cierre, estacion, numcheque, mesa, nopersonas, idmesero,
        idarearestaurant, idempresa, tipodeservicio, idturno,
        usuarioapertura, subtotal, subtotalsinimpuestos,
        total, totalconpropina, totalimpuesto1, totalconcargo,
        totalconpropinacargo, totalarticulos,
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
        @fecha, @cierre, @estacion, @numcheque, @mesa, @nopersonas, @idmesero,
        @idarearestaurant, @idempresa, @tipodeservicio, @idturno,
        @usuarioapertura, @subtotal, @subtotalsinimpuestos,
        @total, @totalconpropina, @totalimpuesto1, @totalconcargo,
        @totalconpropinacargo, @totalarticulos,
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
      .input("preciocatalogo", sql.Money, item.preciocatalogo)
      .input("descuento", sql.Numeric, item.descuento || 0)
      //.input("promovolumen", sql.Bit, item.promovolumen || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("hora", sql.DateTime, new Date()).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos, preciocatalogo,
          hora, descuento, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor, nivel,
          sistema_envio, iddispositivo, productsyncidsr,
          subtotalsrx, totalsrx, idmovtobillar, impuestoimporte3,
          estrateca_DiscountCode, estrateca_DiscountID, estrateca_DiscountAmount,
          procesadosrx, escargoarea, WorkspaceId, idtipodescuento
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @impuesto1, 0, 0, @preciosinimpuestos, @preciocatalogo,
          @hora, @descuento, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0, 0,
          '', '', 0,
          0, 0, NEWID(), @idtipodescuento
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
  await ensureSqlConnection();
  const cheque = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT total FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) throw new Error(`Folio ${folio} no encontrado`);

  const totalCheque = cheque.recordset[0].total;
  const importePago = amount === 0 ? totalCheque : amount;

  let formaPago = tenderId;
  if (!formaPago) {
    const formas = await sqlPool.request().query(`
      SELECT TOP 1 idformadepago FROM formasdepago ORDER BY prioridadboton ASC
    `);
    if (formas.recordset.length > 0) {
      formaPago = formas.recordset[0].idformadepago;
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

// Agregar items a un folio existente (para FlexBill - rondas)
async function addItemsToOrder(folio, items) {
  await ensureSqlConnection();
  // Verificar que el folio existe y no está pagado
  const cheque = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT folio, pagado, total FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) throw new Error(`Folio ${folio} no encontrado`);
  if (cheque.recordset[0].pagado)
    throw new Error(`Folio ${folio} ya está pagado`);

  // Obtener el último movimiento
  const lastMov = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT ISNULL(MAX(movimiento), 0) as lastMov FROM tempcheqdet WHERE foliodet = @folio`,
    );

  let movimiento = lastMov.recordset[0].lastMov + 1;
  let subtotalNuevo = 0;
  let impuestoNuevo = 0;
  let totalSinDescuentoNuevo = 0;

  // Aplicar promociones a cada item
  const itemsConPromo = [];
  for (const item of items) {
    const itemPromo = await applyPromoToItem(item, "1");
    itemsConPromo.push(itemPromo);
  }

  // Insertar cada item con promoción aplicada
  for (const item of items) {
    const impuesto = item.impuesto || 16;
    const precioSinImp = item.precio / (1 + impuesto / 100);
    subtotalNuevo += precioSinImp * item.cantidad;
    impuestoNuevo += (item.precio - precioSinImp) * item.cantidad;
    totalSinDescuentoNuevo += item.preciocatalogo * item.cantidad;

    await sqlPool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, item.precio)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("preciocatalogo", sql.Money, item.preciocatalogo)
      .input("descuento", sql.Numeric, item.descuento || 0)
      //.input("promovolumen", sql.Bit, item.promovolumen || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("hora", sql.DateTime, new Date()).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos, preciocatalogo,
          hora, descuento, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor, nivel,
          sistema_envio, iddispositivo, productsyncidsr,
          subtotalsrx, totalsrx, idmovtobillar, impuestoimporte3,
          estrateca_DiscountCode, estrateca_DiscountID, estrateca_DiscountAmount,
          procesadosrx, escargoarea, WorkspaceId, idtipodescuento
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @impuesto1, 0, 0, @preciosinimpuestos, @preciocatalogo,
          @hora, @descuento, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0, 0,
          '', '', 0,
          0, 0, NEWID(), @idtipodescuento
        )
      `);
    movimiento++;
  }

  // Actualizar totales del cheque
  const totalNuevo = subtotalNuevo + impuestoNuevo;
  await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("subtotalNuevo", sql.Money, subtotalNuevo)
    .input("totalNuevo", sql.Money, totalNuevo)
    .input("impuestoNuevo", sql.Money, impuestoNuevo)
    .input("itemsCount", sql.Numeric, items.length).query(`
      UPDATE tempcheques SET
        subtotal = subtotal + @subtotalNuevo,
        subtotalsinimpuestos = subtotalsinimpuestos + @subtotalNuevo,
        total = total + @totalNuevo,
        totalconpropina = totalconpropina + @totalNuevo,
        totalimpuesto1 = totalimpuesto1 + @impuestoNuevo,
        totalconcargo = totalconcargo + @totalNuevo,
        totalconpropinacargo = totalconpropinacargo + @totalNuevo,
        totalarticulos = totalarticulos + @itemsCount,
        totalalimentos = totalalimentos + @totalNuevo,
        totalcondonativo = totalcondonativo + @totalNuevo,
        totalconpropinacargodonativo = totalconpropinacargodonativo + @totalNuevo
      WHERE folio = @folio
    `);

  // Obtener totales actualizados
  const updated = await sqlPool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT subtotal, total, totalimpuesto1 FROM tempcheques WHERE folio = @folio`,
    );

  return {
    folio,
    itemsAdded: items.length,
    totals: {
      subtotal: updated.recordset[0].subtotal,
      tax: updated.recordset[0].totalimpuesto1,
      total: updated.recordset[0].total,
    },
  };
}

// Obtener cheques abiertos por mesa
async function getChecksByTable(tableNumber, includeClosed = false) {
  await ensureSqlConnection();
  const query = includeClosed
    ? `SELECT folio, mesa, fecha, nopersonas, subtotal, total, totalimpuesto1, pagado
       FROM tempcheques WHERE mesa = @mesa ORDER BY fecha DESC`
    : `SELECT folio, mesa, fecha, nopersonas, subtotal, total, totalimpuesto1, pagado
       FROM tempcheques WHERE mesa = @mesa AND pagado = 0 ORDER BY fecha DESC`;

  const result = await sqlPool
    .request()
    .input("mesa", sql.VarChar, String(tableNumber))
    .query(query);

  const checks = [];
  for (const cheque of result.recordset) {
    // Obtener items del cheque
    const items = await sqlPool
      .request()
      .input("folio", sql.BigInt, cheque.folio).query(`
        SELECT d.movimiento, d.idproducto, d.cantidad, d.precio, d.preciosinimpuestos,
               p.descripcion as nombre
        FROM tempcheqdet d
        LEFT JOIN productos p ON d.idproducto = p.idproducto
        WHERE d.foliodet = @folio
        ORDER BY d.movimiento
      `);

    // Obtener pagos del cheque
    const pagos = await sqlPool
      .request()
      .input("folio", sql.BigInt, cheque.folio)
      .query(
        `SELECT ISNULL(SUM(importe), 0) as totalPagado FROM tempchequespagos WHERE folio = @folio`,
      );

    checks.push({
      folio: cheque.folio,
      mesa: cheque.mesa,
      fecha: cheque.fecha,
      nopersonas: cheque.nopersonas,
      subtotal: cheque.subtotal,
      total: cheque.total,
      totalimpuesto1: cheque.totalimpuesto1,
      pagado: cheque.pagado === 1,
      totalPagado: pagos.recordset[0].totalPagado,
      items: items.recordset.map((item) => ({
        menuItemId: item.idproducto,
        name: item.nombre || item.idproducto,
        quantity: item.cantidad,
        unitPrice: item.preciosinimpuestos,
        total: item.precio * item.cantidad,
      })),
    });
  }

  return { checks };
}

function transformOrder(xquisitoOrder) {
  // Asegurar que mesa sea siempre un string válido
  let mesa = xquisitoOrder.tableNumber || xquisitoOrder.table_number || "XQ01";
  if (mesa === null || mesa === undefined || mesa === "") {
    mesa = "XQ01";
  }
  mesa = String(mesa).trim() || "XQ01";

  return {
    mesa,
    nopersonas: xquisitoOrder.guests || 1,
    idmesero: "01",
    idarearestaurant: "03",
    idempresa: "1",
    tipodeservicio: xquisitoOrder.orderType === "delivery" ? 2 : 3,
    observaciones: xquisitoOrder.notes || "",
    orderReference: xquisitoOrder.id || `XQ-${Date.now()}`,
    items: (xquisitoOrder.items || []).map((item) => ({
      idproducto: item.productId || item.sku,
      cantidad: item.quantity || 1,
      precio: item.price || 0,
      impuesto: 16,
    })),
  };
}

// ============================================
// Agente WebSocket
// ============================================

function updateStatus(connected) {
  isConnected = connected;
  updateTray();
  if (mainWindow) {
    mainWindow.webContents.send("agent-status", { connected });
  }
}

function setupEventHandlers() {
  syncSocket.on("new_order", async (data) => {
    console.log("[ORDER] Nueva orden:", data.requestId);
    console.log(
      "[ORDER] Datos recibidos:",
      JSON.stringify({
        tableNumber: data.tableNumber,
        table_number: data.table_number,
        guests: data.guests,
        items: data.items?.length || 0,
      }),
    );
    try {
      const orderData = transformOrder(data);
      console.log("[ORDER] Mesa transformada:", orderData.mesa);
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

  // Handler para agregar items a folio existente (FlexBill - rondas)
  syncSocket.on("add_items", async (data) => {
    console.log(
      `[ADD_ITEMS] Folio ${data.folio}, ${data.items?.length || 0} items`,
    );
    try {
      const items = (data.items || []).map((item) => ({
        idproducto: item.productId || item.sku,
        cantidad: item.quantity || 1,
        precio: item.price || 0,
        impuesto: 16,
      }));

      const result = await addItemsToOrder(data.folio, items);
      console.log(`[ADD_ITEMS] ${result.itemsAdded} items agregados`);
      syncSocket.emit("add_items_ack", {
        requestId: data.requestId,
        success: true,
        folio: data.folio,
        ...result,
      });
    } catch (error) {
      console.error("[ADD_ITEMS] Error:", error.message);
      syncSocket.emit("add_items_ack", {
        requestId: data.requestId,
        success: false,
        error: error.message,
      });
    }
  });

  // Handler para obtener cheques por mesa (Tap&Pay)
  syncSocket.on("get_checks_by_table", async (data) => {
    console.log(`[GET_CHECKS] Mesa ${data.table}`);
    try {
      const result = await getChecksByTable(
        data.table,
        data.includeClosed || false,
      );
      console.log(
        `[GET_CHECKS] ${result.checks.length} cheque(s) encontrado(s)`,
      );
      syncSocket.emit("get_checks_by_table_ack", {
        requestId: data.requestId,
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[GET_CHECKS] Error:", error.message);
      syncSocket.emit("get_checks_by_table_ack", {
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
      await ensureSqlConnection();

      console.log("[SYNC] Obteniendo grupos...");
      const groupsResult = await sqlPool.request().query(`
        SELECT idgrupo, descripcion, prioridad, clasificacion
        FROM grupos
        ORDER BY prioridad ASC, descripcion ASC
      `);
      const groups = groupsResult.recordset;
      console.log(`[SYNC] Grupos obtenidos: ${groups.length}`);

      console.log("[SYNC] Obteniendo productos con promociones...");
      const productsResult = await sqlPool.request().query(`
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
          pd.bloqueado,
          -- Campos de promoción
          pp.preciopromocion,
          pp.descuento as promo_descuento,
          pp.idtipodescuento,
          promo.descripcion as promo_nombre,
          CASE WHEN promo.status = 1
               AND (promo.fechainicio IS NULL OR promo.fechainicio <= GETDATE())
               AND (promo.fechafin IS NULL OR promo.fechafin >= GETDATE())
               THEN 1 ELSE 0 END as promo_activa
        FROM productos p
        LEFT JOIN productosdetalle pd ON p.idproducto = pd.idproducto
        INNER JOIN grupos g ON p.idgrupo = g.idgrupo
        LEFT JOIN promoproductos pp ON p.idproducto = pp.idproducto AND pd.idempresa = pp.idempresa
        LEFT JOIN promociones promo ON pp.idpromocion = promo.idpromocion
        WHERE (p.visible_menu = 1 OR p.visible_menu IS NULL)
        ORDER BY p.idgrupo, p.descripcion
      `);

      // Procesar productos para calcular precio final con promo
      const products = productsResult.recordset.map((prod) => {
        const result = {
          ...prod,
          precio_original: prod.precio,
          precio_promo: null,
          tiene_promo: false,
        };

        if (prod.promo_activa === 1) {
          result.tiene_promo = true;
          if (prod.preciopromocion && prod.preciopromocion > 0) {
            result.precio_promo = prod.preciopromocion;
          } else if (prod.promo_descuento && prod.promo_descuento > 0) {
            result.precio_promo =
              prod.precio * (1 - prod.promo_descuento / 100);
          }
        }

        return result;
      });

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
      await ensureSqlConnection();

      // Generar ID único de 5 caracteres
      const idgrupo =
        data.name
          .substring(0, 4)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "X") +
        Math.floor(Math.random() * 10).toString();

      await sqlPool
        .request()
        .input("idgrupo", sql.VarChar, idgrupo)
        .input("descripcion", sql.VarChar, data.name.substring(0, 30))
        .input("prioridad", sql.Numeric, data.displayOrder || 0)
        .input("clasificacion", sql.Numeric, 1).query(`
          INSERT INTO grupos (idgrupo, descripcion, prioridad, clasificacion, alcohol)
          VALUES (@idgrupo, @descripcion, @prioridad, @clasificacion, 0)
        `);

      console.log(`[SYNC] Grupo creado: ${idgrupo}`);

      syncSocket.emit("sync_menu_push_group_ack", {
        requestId: data.requestId,
        success: true,
        idgrupo,
        descripcion: data.name,
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
      await ensureSqlConnection();

      // Generar ID de producto (15 chars max)
      const timestamp = Date.now().toString().slice(-8);
      const idproducto = `XQ${timestamp}`;
      const precioSinImp = data.price / 1.16; // Asumir 16% IVA

      // Insertar en productos
      await sqlPool
        .request()
        .input("idproducto", sql.VarChar, idproducto)
        .input("descripcion", sql.VarChar, data.name.substring(0, 60))
        .input("idgrupo", sql.VarChar, data.groupId)
        .input("nombrecorto", sql.VarChar, data.name.substring(0, 20))
        .input(
          "descripcionmenuelectronico",
          sql.VarChar,
          (data.description || "").substring(0, 255),
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
        .input("precio", sql.Money, data.price)
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

      console.log(`[SYNC] Producto creado: ${idproducto}`);

      syncSocket.emit("sync_menu_push_product_ack", {
        requestId: data.requestId,
        success: true,
        idproducto,
        descripcion: data.name,
        precio: data.price,
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

async function startAgent() {
  const config = getConfig();
  if (!config) return;

  currentConfig = config;
  console.log("[AGENT] Iniciando...");

  try {
    await connectSqlServer(config);

    const turno = await getActiveTurno();
    console.log(
      turno
        ? `[SQL] Turno activo: ${turno.idturno}`
        : "[SQL] No hay turno abierto",
    );

    // WebSocket connection con configuración optimizada para estabilidad
    const wsUrl = config.xquisito.wsUrl.replace("/sync", "");
    syncSocket = io(`${wsUrl}/sync`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 30000,
      // Aumentar timeouts para conexiones más estables
      pingTimeout: 30000,
      pingInterval: 15000,
      // Forzar nueva conexión en reconexión
      forceNew: false,
    });

    // Función para registrar con el servidor
    function registerWithServer() {
      if (syncSocket && syncSocket.connected) {
        console.log("[WS] Enviando registro...");
        syncSocket.emit("register", {
          branchId: config.xquisito.branchId,
          syncToken: config.xquisito.syncToken,
          agentVersion: "1.0.0",
        });
      }
    }

    // Función para iniciar heartbeat activo
    function startHeartbeat() {
      stopHeartbeat();
      pingInterval = setInterval(() => {
        if (syncSocket && syncSocket.connected) {
          syncSocket.emit("ping");
        }
      }, 15000); // Ping cada 15 segundos
    }

    // Función para detener heartbeat
    function stopHeartbeat() {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    }

    syncSocket.on("connect", () => {
      console.log("[WS] Conectado!");
      updateStatus(true);
      registerWithServer();
      startHeartbeat();
    });

    syncSocket.on("register_ack", (data) => {
      console.log("[WS] Registrado:", data.message || "OK");
    });

    syncSocket.on("register_error", (data) => {
      console.error("[WS] Error registro:", data.error);
      updateStatus(false);
    });

    // Respuesta del servidor a nuestro ping
    syncSocket.on("pong", () => {
      // Heartbeat exitoso - conexión activa
    });

    syncSocket.on("disconnect", (reason) => {
      console.log("[WS] Desconectado:", reason);
      stopHeartbeat();

      // Marcar como desconectado solo en casos permanentes
      if (reason === "io server disconnect") {
        // Server cerró conexión - intentará reconectar automáticamente
        updateStatus(false);
      } else if (reason === "io client disconnect") {
        // Cliente cerró conexión intencionalmente
        updateStatus(false);
      }
      // Para "transport close", "ping timeout", etc. - socket.io reintentará
    });

    syncSocket.on("reconnect", (attemptNumber) => {
      console.log(`[WS] Reconectado después de ${attemptNumber} intentos`);
      updateStatus(true);
      // Re-registrar después de reconectar
      registerWithServer();
      startHeartbeat();
    });

    syncSocket.on("reconnect_attempt", (attemptNumber) => {
      if (attemptNumber % 5 === 1) {
        // Log cada 5 intentos
        console.log(`[WS] Intento de reconexión #${attemptNumber}`);
      }
    });

    syncSocket.on("connect_error", (error) => {
      console.error("[WS] Error conexión:", error.message);
      // Solo actualizar status si ya no está intentando reconectar
      if (!syncSocket.active) {
        updateStatus(false);
      }
    });

    setupEventHandlers();
  } catch (error) {
    console.error("[AGENT] Error:", error.message);
    updateStatus(false);
  }
}

async function stopAgent() {
  // Detener heartbeat
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  if (syncSocket) {
    syncSocket.close();
    syncSocket = null;
  }
  if (sqlPool) {
    await sqlPool.close();
    sqlPool = null;
  }
  updateStatus(false);
  console.log("[AGENT] Detenido");
}

async function restartAgent() {
  await stopAgent();
  setTimeout(startAgent, 500);
}

// ============================================
// Tray
// ============================================

function createTrayIcon(connected) {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const color = connected ? [0, 180, 0, 255] : [200, 0, 0, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const cx = size / 2,
        cy = size / 2,
        r = 6;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist <= r) {
        canvas[idx] = color[0];
        canvas[idx + 1] = color[1];
        canvas[idx + 2] = color[2];
        canvas[idx + 3] = color[3];
      } else {
        canvas[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;

  tray.setImage(createTrayIcon(isConnected));
  tray.setToolTip(
    `Xquisito Agent - ${isConnected ? "Conectado" : "Desconectado"}`,
  );

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Estado: ${isConnected ? "Conectado" : "Desconectado"}`,
      enabled: false,
    },
    { type: "separator" },
    { label: "Iniciar", click: startAgent, enabled: !syncSocket },
    { label: "Detener", click: stopAgent, enabled: !!syncSocket },
    { label: "Reiniciar", click: restartAgent, enabled: !!syncSocket },
    { type: "separator" },
    { label: "Configuracion...", click: showWindow },
    { type: "separator" },
    {
      label: "Salir",
      click: async () => {
        isQuitting = true;
        await stopAgent();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  tray = new Tray(createTrayIcon(false));
  tray.setToolTip("Xquisito Agent");
  tray.on("double-click", showWindow);
  updateTray();
}

// ============================================
// Ventana
// ============================================

function getIconPath() {
  const isDev = !app.isPackaged;
  return isDev
    ? path.join(__dirname, "..", "assets", "icon-white.ico")
    : path.join(process.resourcesPath, "app.asar", "assets", "icon-white.ico");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 750,
    resizable: false,
    maximizable: false,
    show: false,
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // F12 para abrir DevTools (ver logs)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();

  const config = getConfig();
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.send("load-config", config);
    mainWindow.webContents.send("agent-status", { connected: isConnected });
  });

  mainWindow.show();
  mainWindow.focus();
}

// ============================================
// IPC Handlers
// ============================================

ipcMain.handle("get-config", () => getConfig());

ipcMain.handle("save-config", async (event, { branchId, syncToken }) => {
  try {
    saveConfig(branchId, syncToken);
    await restartAgent();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("test-sql", async () => {
  try {
    const config = getConfig();
    if (!config) return { success: false, error: "No hay configuracion" };

    const testConfig = {
      server: config.sqlServer.host || "localhost",
      database: config.sqlServer.database || "softrestaurant10",
      port: config.sqlServer.port || 1433,
      user: config.sqlServer.user || "sa",
      password: config.sqlServer.password || "",
      options: {
        trustServerCertificate: true,
        encrypt: false,
      },
      connectionTimeout: 15000,
    };

    const testPool = await sql.connect(testConfig);
    await testPool.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("test-sql-with-config", async (event, sqlConfig) => {
  try {
    const testConfig = {
      server: sqlConfig.host || "localhost",
      database: sqlConfig.database || "softrestaurant10",
      port: sqlConfig.port || 1433,
      user: sqlConfig.user || "sa",
      password: sqlConfig.password || "",
      options: {
        trustServerCertificate: true,
        encrypt: false,
      },
      connectionTimeout: 15000,
    };

    const testPool = await sql.connect(testConfig);
    await testPool.close();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-full-config", async (event, configData) => {
  try {
    const config = {
      sqlServer: {
        host: configData.sqlHost || "localhost",
        database: configData.sqlDatabase || "softrestaurant10",
        port: configData.sqlPort || 1433,
        user: configData.sqlUser || "sa",
        password: configData.sqlPassword || "",
      },
      xquisito: {
        branchId: configData.branchId,
        syncToken: configData.syncToken,
        wsUrl: "https://xquisito-backend-production.up.railway.app/sync",
      },
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
    await restartAgent();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-status", () => ({
  connected: isConnected,
  running: !!syncSocket,
}));
ipcMain.handle("start-agent", () => {
  startAgent();
  return { success: true };
});
ipcMain.handle("stop-agent", async () => {
  await stopAgent();
  return { success: true };
});
ipcMain.handle("minimize-window", () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.handle("hide-window", () => {
  if (mainWindow) mainWindow.hide();
});

// ============================================
// SQL Onboarding IPC Handlers
// ============================================

ipcMain.handle("sql-onboarding-status", () => {
  return {
    isConfigured: sqlOnboarding.isConfigured(),
    credentials: sqlOnboarding.getSavedCredentials(),
  };
});

ipcMain.handle("sql-onboarding-run", async (event, params) => {
  try {
    const result = await sqlOnboarding.runOnboarding(params || {});
    return result;
  } catch (error) {
    return { status: "error", error: error.message };
  }
});

ipcMain.handle("sql-onboarding-test-sql", async (event, params) => {
  try {
    const result = await sqlOnboarding.trySqlAuth(
      params.host,
      params.database,
      params.user,
      params.password,
    );
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("sql-onboarding-create-user", async (event, params) => {
  try {
    const result = await sqlOnboarding.createAppUser(params);
    if (result.success) {
      // Guardar las nuevas credenciales
      sqlOnboarding.saveCredentials({
        host: params.host,
        database: params.database,
        user: result.user,
        password: result.password,
      });
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("sql-onboarding-clear", () => {
  sqlOnboarding.clearCredentials();
  return { success: true };
});

ipcMain.handle("sql-onboarding-discover", () => {
  try {
    const result = sqlOnboarding.discoverSqlConfig();
    return result;
  } catch (error) {
    return { found: false, error: error.message };
  }
});

ipcMain.handle("sql-onboarding-diagnostics", () => {
  try {
    const result = sqlOnboarding.getDiagnostics();
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle("sql-onboarding-save-sql", async (event, params) => {
  try {
    sqlOnboarding.saveCredentials({
      host: params.host,
      database: params.database,
      user: params.user,
      password: params.password,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// App
// ============================================

app.whenReady().then(() => {
  // Configurar inicio automático con Windows
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath("exe"),
  });

  createTray();
  showWindow();

  if (configExists()) {
    startAgent();
  }
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", async () => await stopAgent());

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}
