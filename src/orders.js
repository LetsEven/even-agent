/**
 * Orders Module - Gestión de Órdenes/Cheques
 * Inserta órdenes en cheques/cheqdet con soporte de descuentos
 */

const {
  sql,
  getPool,
  ensureSqlConnection,
  getActiveTurno,
  getOrCreateMeseroXquisito,
  getNextFolios,
} = require("./database");
const { applyPromoToItem } = require("./promos");

// Genera código único para codigo_unico_af
function generateCodigoUnicoAF() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "XQ"; // Prefijo Xquisito
  for (let i = 0; i < 7; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Insertar nueva orden en cheques y cheqdet
async function insertOrder(orderData) {
  console.log(
    "[ORDER] insertOrder llamado con:",
    JSON.stringify(orderData, null, 2),
  );
  await ensureSqlConnection();
  const pool = getPool();

  // Verificar duplicados por orderReference
  const orderRef = orderData.orderReference || `XQ-${Date.now()}`;
  const existingOrder = await pool
    .request()
    .input("ref", sql.VarChar, orderRef)
    .query("SELECT folio, total FROM tempcheques WHERE orderreference = @ref");

  if (existingOrder.recordset.length > 0) {
    const existing = existingOrder.recordset[0];
    console.log(
      `[ORDER] Orden duplicada detectada: ${orderRef}, folio existente: ${existing.folio}`,
    );
    return {
      folio: existing.folio,
      total: existing.total,
      duplicate: true,
    };
  }

  const turno = await getActiveTurno();
  const { numcheque, orden, folionotadeconsumo } = await getNextFolios();

  if (!turno) throw new Error("No hay turno abierto en Soft Restaurant");

  // Obtener idempresa de la tabla empresas
  const empresaResult = await pool
    .request()
    .query(`SELECT TOP 1 idempresa FROM empresas`);
  const idempresa =
    empresaResult.recordset.length > 0
      ? empresaResult.recordset[0].idempresa
      : "1";

  // 1. Aplicar promociones a cada item
  console.log(`[ORDER] Procesando ${orderData.items?.length || 0} items...`);
  const itemsConPromo = [];
  for (const item of orderData.items) {
    console.log("[ORDER] Item original:", item);
    const itemPromo = await applyPromoToItem(item, idempresa);
    console.log("[ORDER] Item con promo:", itemPromo);
    itemsConPromo.push(itemPromo);
  }

  // 2. Calcular totales
  let totalSinDescuento = 0;
  let totalConDescuento = 0;
  let totalImpuesto = 0;
  let subtotalSinImp = 0;
  let totalSinDescuentoSinImp = 0;

  for (const item of itemsConPromo) {
    const impuesto = item.impuesto || 16;
    const precioOriginal = item.preciocatalogo;
    const extraPrice = item.extraPrice || 0;
    const precioFinal = item.precioFinal + extraPrice; // Incluir extraPrice
    const precioSinImp = precioFinal / (1 + impuesto / 100);
    const precioOriginalSinImp =
      (precioOriginal + extraPrice) / (1 + impuesto / 100);

    totalSinDescuento += (precioOriginal + extraPrice) * item.cantidad;
    totalConDescuento += precioFinal * item.cantidad;
    subtotalSinImp += precioSinImp * item.cantidad;
    totalImpuesto += (precioFinal - precioSinImp) * item.cantidad;
    totalSinDescuentoSinImp += precioOriginalSinImp * item.cantidad;
  }

  const descuentoTotal = totalSinDescuento - totalConDescuento;

  // DEBUG: Log de totales calculados
  console.log("[ORDER] Totales calculados:", {
    items: itemsConPromo.length,
    subtotalSinImp,
    totalConDescuento,
    totalImpuesto,
    totalSinDescuento,
    totalSinDescuentoSinImp,
    descuentoTotal,
  });

  // 3. INSERT cheques con todos los campos correctos (no NULLs)
  const codigoUnicoAF = generateCodigoUnicoAF();

  // Obtener o crear mesero XQUISITO
  const idmesero = await getOrCreateMeseroXquisito();

  const insertResult = await pool
    .request()
    .input("estacion", sql.VarChar, "XQUISITO")
    .input("numcheque", sql.BigInt, numcheque)
    .input("mesa", sql.VarChar, orderData.mesa || "XQ01")
    .input("nopersonas", sql.Int, orderData.nopersonas || 1)
    .input("idmesero", sql.VarChar, idmesero)
    .input("idarearestaurant", sql.VarChar, orderData.idarearestaurant || "03")
    .input("idempresa", sql.VarChar, idempresa)
    .input("tipodeservicio", sql.Int, 1)
    .input("idturno", sql.BigInt, turno.idturno)
    .input("usuarioapertura", sql.VarChar, "XQUISITO")
    .input("subtotal", sql.Money, subtotalSinImp)
    .input("subtotalsinimpuestos", sql.Money, subtotalSinImp)
    .input("total", sql.Money, totalConDescuento)
    .input("totalconpropina", sql.Money, totalConDescuento)
    .input("totalimpuesto1", sql.Money, totalImpuesto)
    .input("totalconcargo", sql.Money, totalConDescuento)
    .input("totalconpropinacargo", sql.Money, totalConDescuento)
    .input("totalarticulos", sql.Numeric, orderData.items.length)
    .input("totalsindescuento", sql.Money, totalSinDescuento)
    .input("descuentoimporte", sql.Money, descuentoTotal)
    .input("totaldescuentos", sql.Money, descuentoTotal)
    .input("totalalimentos", sql.Money, totalConDescuento)
    .input("totalcondonativo", sql.Money, 0)
    .input("totalconpropinacargodonativo", sql.Money, 0)
    .input("subtotalcondescuento", sql.Money, subtotalSinImp)
    .input("totalalimentossindescuentos", sql.Money, totalConDescuento)
    .input("codigounicoaf", sql.VarChar, codigoUnicoAF)
    .input("observaciones", sql.VarChar, orderData.observaciones || "")
    .input("appname", sql.VarChar, "XQUISITO")
    .input("orden", sql.BigInt, orden)
    .input("folionotadeconsumo", sql.BigInt, folionotadeconsumo)
    .input("orderreference", sql.VarChar, orderRef).query(`
      INSERT INTO tempcheques (
        fecha, cierre, estacion, numcheque, mesa, nopersonas, idmesero,
        idarearestaurant, idempresa, tipodeservicio, idturno,
        usuarioapertura, subtotal, subtotalsinimpuestos,
        total, totalconpropina, totalimpuesto1, totalconcargo,
        totalconpropinacargo, totalarticulos,
        totalsindescuento, descuentoimporte, totaldescuentos,
        totalalimentos, totalcondonativo, totalconpropinacargodonativo,
        observaciones, appname, orderreference, folionotadeconsumo,
        seriefolio, orden, cambio, descuento, propinaincluida, tarjetadescuento,
        cargo, efectivo, tarjeta, vales, otros, propina, propinatarjeta,
        tipoventarapida, totalbebidas, totalotros,
        totaldescuentoalimentos, totaldescuentobebidas, totaldescuentootros,
        totalcortesias, totalcortesiaalimentos, totalcortesiabebidas, totalcortesiaotros,
        totaldescuentoycortesia, totalalimentossindescuentos, totalbebidassindescuentos, totalotrossindescuentos,
        descuentocriterio, descuentomonedero, subtotalcondescuento, codigo_unico_af, saldoanteriormonedero,
        pagado, cancelado, impreso, impresiones, reabiertas, facturado,
        propinapagada, propinamanual, comisionpagada, callcenter, enviado,
        EnviadoRW, totalimpuestod1, totalimpuestod2, totalimpuestod3,
        sistema_envio, idformadepagoDescuento, titulartarjetamonederodescuento,
        c_iddispositivo, salerestaurantid, esalestatus, statusSR, paymentreference,
        foodorder, cashpaymentwith, paymentmethod_id, surveycode, intentoEnvioAF,
        TKC_Token, TKC_Transaction,
        TKC_Authorization, TKC_Cupon, TKC_ExpirationDate, TKC_Recompensa,
        campoadicional2, campoadicional3, estrateca_CardNumber, estrateca_VoucherText,
        campoadicional4, campoadicional5, sacoa_CardNumber, sacoa_credits,
        estrateca_TypeDisccount, estrateca_DiscountCode, estrateca_DiscountID,
        estrateca_DiscountAmount, donativo, status_domicilio, enviopagado,
        diet_restrictions, sl_cupon_descuento, sl_tipo_cupon, TUKI_CardNumber,
        WorkspaceId, SentSync,
        mv_room, mv_lastname,
        idcliente, comentariodescuento, usuariodescuento, idtipodescuento,
        numerotarjeta, ncf, numerocuenta, titulartarjetamonedero,
        autorizacionfolio, puntosmonederogenerados, usuariopago
      )
      OUTPUT INSERTED.folio
      VALUES (
        GETDATE(), GETDATE(), @estacion, @numcheque, @mesa, @nopersonas, @idmesero,
        @idarearestaurant, @idempresa, @tipodeservicio, @idturno,
        @usuarioapertura, @subtotal, @subtotalsinimpuestos,
        @total, @totalconpropina, @totalimpuesto1, @totalconcargo,
        @totalconpropinacargo, @totalarticulos,
        @totalsindescuento, @descuentoimporte, @totaldescuentos,
        @totalalimentos, @totalcondonativo, @totalconpropinacargodonativo,
        @observaciones, @appname, @orderreference, @folionotadeconsumo,
        '', @orden, 0, 0, 0, '',
        0, 0, 0, 0, 0, 0, 0,
        1, 0, 0,
        0, 0, 0,
        0, 0, 0, 0,
        0, @totalalimentossindescuentos, 0, 0,
        0, 0, @subtotalcondescuento, @codigounicoaf, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, @totalimpuesto1, 0, 0,
        1, '', '',
        -1, '', 0, -1, '',
        0, -1, -1, '', 0,
        '', '',
        '', '', '', 0,
        '', '', '', '',
        '', '', '', 0,
        '', '', '',
        0, 0, 0, 0,
        '', '', '', '',
        NEWID(), 0,
        '', '',
        '', '', '', '',
        '', '', '', '',
        '', 0, 'XQUISITO'
      )
    `);

  const folio = insertResult.recordset[0].folio;
  console.log(`[ORDER] Cheque insertado con folio: ${folio}`);

  // 4. INSERT cheqdet con campos de descuento
  console.log(`[ORDER] Insertando ${itemsConPromo.length} items en cheqdet...`);
  let movimiento = 1;
  for (const item of itemsConPromo) {
    const extraPrice = item.extraPrice || 0;
    const precioConExtra = item.precioFinal + extraPrice;
    const comentario = item.comment || "";
    console.log(`[ORDER] Item ${movimiento}:`, {
      idproducto: item.idproducto,
      cantidad: item.cantidad,
      precioFinal: item.precioFinal,
      extraPrice: extraPrice,
      precioConExtra: precioConExtra,
      preciocatalogo: item.preciocatalogo,
      comentario: comentario,
    });
    const impuesto = item.impuesto || 16;
    const precioSinImp = precioConExtra / (1 + impuesto / 100);

    await pool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, precioConExtra)
      .input("preciocatalogo", sql.Money, item.preciocatalogo + extraPrice)
      .input("descuento", sql.Numeric, item.descuento || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("promovolumen", sql.Bit, item.promovolumen ? 1 : 0)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("idestacion", sql.VarChar, "XQUISITO")
      .input("comentario", sql.VarChar, comentario).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          preciocatalogo, descuento, idtipodescuento, promovolumen,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos,
          hora, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor,
          idestacion, comentario, WorkspaceId
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @preciocatalogo, @descuento, @idtipodescuento, @promovolumen,
          @impuesto1, 0, 0, @preciosinimpuestos,
          GETDATE(), 0, 0, 0,
          0, 0, 0,
          @idestacion, @comentario, NEWID()
        )
      `);
    movimiento++;
  }

  if (descuentoTotal > 0) {
    console.log(
      `[ORDER] Descuento aplicado: $${descuentoTotal.toFixed(2)} (${((descuentoTotal / totalSinDescuento) * 100).toFixed(1)}%)`,
    );
  }

  // Obtener nombres de productos para la notificación
  const ids = itemsConPromo
    .map((i) => `'${i.idproducto.replace(/'/g, "''")}'`)
    .join(",");
  const nombresResult = await pool
    .request()
    .query(
      `SELECT idproducto, descripcion FROM productos WHERE idproducto IN (${ids})`,
    );
  const nombreMap = {};
  for (const r of nombresResult.recordset) {
    nombreMap[r.idproducto] = r.descripcion;
  }
  const itemDetails = itemsConPromo.map((i) => {
    const nombre = nombreMap[i.idproducto] || i.idproducto;
    const extraPrice = i.extraPrice || 0;
    const precioFinal = (i.precioFinal + extraPrice) * i.cantidad;
    return { nombre, cantidad: i.cantidad, total: precioFinal };
  });

  return {
    folio,
    numcheque,
    total: totalConDescuento,
    subtotal: subtotalSinImp,
    tax: totalImpuesto,
    descuento: descuentoTotal,
    totalSinDescuento,
    itemsCount: orderData.items.length,
    itemDetails,
    idmesero,
  };
}

// ============================================================================
// FUNCIONES RELACIONADAS CON EL CORTE DE CAJA
// ============================================================================

// Actualizar declaracion de cajero (UPSERT para forma de pago)
// Esta función inserta/actualiza en la tabla 'declaracioncajero' que es la base
// para el corte de caja. Cada pago se acumula aquí por forma de pago (efectivo, tarjeta, etc.)
// y Soft Restaurant lo usa para mostrar el resumen de ventas por tipo de pago en el corte.
async function updateDeclaracionCajero(
  idturno,
  idturnointerno,
  importe,
  formaPago,
) {
  const pool = getPool();

  // Verificar si ya existe registro para este turno + forma de pago
  const existeResult = await pool
    .request()
    .input("idturno", sql.BigInt, idturno)
    .input("idformadepago", sql.VarChar, formaPago).query(`
      SELECT idturnointerno, importedeclarado
      FROM declaracioncajero
      WHERE idturno = @idturno AND idformadepago = @idformadepago
    `);

  if (existeResult.recordset.length > 0) {
    // UPDATE: acumular al importe existente
    await pool
      .request()
      .input("idturno", sql.BigInt, idturno)
      .input("idformadepago", sql.VarChar, formaPago)
      .input("importe", sql.Money, importe).query(`
        UPDATE declaracioncajero
        SET importedeclarado = importedeclarado + @importe
        WHERE idturno = @idturno AND idformadepago = @idformadepago
      `);
  } else {
    // INSERT: nuevo registro
    await pool
      .request()
      .input("idturnointerno", sql.BigInt, idturnointerno)
      .input("idturno", sql.BigInt, idturno)
      .input("idformadepago", sql.VarChar, formaPago)
      .input("importe", sql.Money, importe).query(`
        INSERT INTO declaracioncajero (
          idturnointerno, idturno, idformadepago, importedeclarado,
          tipodecambio, tipo, descripcion, WorkspaceId
        )
        VALUES (
          @idturnointerno, @idturno, @idformadepago, @importe,
          1.0, 2, 'TARJETA DE CREDITO', NEWID()
        )
      `);
  }
}

// Aplicar pago a un folio
async function applyPayment(folio, amount, tenderId, reference, tip = 0) {
  await ensureSqlConnection();
  const pool = getPool();

  const cheque = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT total, propina FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) throw new Error(`Folio ${folio} no encontrado`);

  const totalCheque = cheque.recordset[0].total;
  const propinaActual = cheque.recordset[0].propina || 0;
  const importePago = amount === 0 ? totalCheque : amount;
  const propinaPago = tip || 0;

  // Obtener turno activo (valida que el último turno esté abierto)
  const turno = await getActiveTurno();
  const idTurnoCierre = turno.idturno;

  // Determinar forma de pago: usar tenderId si se especifica, sino buscar tarjeta existente
  let formaPago = tenderId;
  if (!formaPago) {
    // Buscar forma de pago de tarjeta que exista en el sistema
    const formasResult = await pool.request().query(`
      SELECT TOP 1 idformadepago FROM formasdepago
      WHERE idformadepago IN ('TC', 'TAR', 'TD')
      ORDER BY CASE idformadepago WHEN 'TC' THEN 1 WHEN 'TAR' THEN 2 WHEN 'TD' THEN 3 END
    `);
    if (formasResult.recordset.length > 0) {
      formaPago = formasResult.recordset[0].idformadepago;
    } else {
      throw new Error(
        "No se encontró forma de pago de tarjeta (TC, TAR, TD) en el sistema",
      );
    }
  }
  console.log(`[PAYMENT] Forma de pago: ${formaPago}, Turno: ${idTurnoCierre}`);

  // Insertar pago con propina y campos requeridos
  await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("idformadepago", sql.VarChar, formaPago)
    .input("importe", sql.Money, importePago)
    .input("propina", sql.Money, propinaPago).query(`
      INSERT INTO tempchequespagos (folio, idformadepago, importe, propina, tipodecambio, sistema_envio, referencia)
      VALUES (@folio, @idformadepago, @importe, @propina, 1.00, 1, '')
    `);

  // Actualizar cheques: tarjeta y propina si aplica
  const nuevaPropina = propinaActual + propinaPago;
  await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("tarjeta", sql.Money, importePago + propinaPago)
    .input("propina", sql.Money, nuevaPropina)
    .input("propinatarjeta", sql.Money, nuevaPropina).query(`
      UPDATE tempcheques SET
        tarjeta = ISNULL(tarjeta, 0) + @tarjeta,
        propina = @propina,
        propinatarjeta = @propinatarjeta,
        totalconpropina = total + @propina,
        totalconpropinacargo = totalconcargo + @propina,
        propinapagada = CASE WHEN @propina > 0 THEN 1 ELSE propinapagada END
      WHERE folio = @folio
    `);

  if (propinaPago > 0) {
    console.log(
      `[PAYMENT] Propina de $${propinaPago} aplicada al folio ${folio}`,
    );
  }
  console.log(`[PAYMENT] Tarjeta actualizada: +$${importePago + propinaPago}`);

  // DESHABILITADO: Actualizar declaracion de cajero y turnos para el corte
  // if (turnoResult.recordset.length > 0) {
  //   await updateDeclaracionCajero(
  //     turnoResult.recordset[0].idturno,
  //     turnoResult.recordset[0].idturnointerno,
  //     importePago,
  //     formaPago,
  //   );
  //
  //   // Actualizar columna tarjeta en turnos (acumular pagos de tarjeta)
  //   const montoTotal = importePago;
  //   await pool
  //     .request()
  //     .input("idturno", sql.BigInt, turnoResult.recordset[0].idturno)
  //     .input("monto", sql.Money, montoTotal).query(`
  //       UPDATE turnos
  //       SET tarjeta = ISNULL(tarjeta, 0) + @monto
  //       WHERE idturno = @idturno
  //     `);
  //   console.log(
  //     `[PAYMENT] Turno ${turnoResult.recordset[0].idturno} actualizado: +$${montoTotal} en tarjeta`,
  //   );
  // }

  const totalPagado = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT ISNULL(SUM(importe), 0) as totalPagado, ISNULL(SUM(propina), 0) as totalPropina FROM tempchequespagos WHERE folio = @folio`,
    );

  const pagadoCompleto = totalPagado.recordset[0].totalPagado >= totalCheque;

  if (pagadoCompleto) {
    await pool
      .request()
      .input("folio", sql.BigInt, folio)
      .query(`UPDATE tempcheques SET pagado = 1 WHERE folio = @folio`);
  }

  return {
    success: true,
    pagado: pagadoCompleto,
    status: pagadoCompleto ? "closed" : "open",
    totalPagado: totalPagado.recordset[0].totalPagado,
    totalPropina: totalPagado.recordset[0].totalPropina,
    totalCheque,
  };
}

// Agregar items a un folio existente (FlexBill)
async function addItemsToOrder(folio, items) {
  await ensureSqlConnection();
  const pool = getPool();

  // Obtener turno activo para idturno_cierre
  const turno = await getActiveTurno();
  if (!turno) throw new Error("No hay turno abierto en Soft Restaurant");

  // Verificar que el folio existe y no está pagado
  const cheque = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT folio, pagado, total FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) throw new Error(`Folio ${folio} no encontrado`);
  if (cheque.recordset[0].pagado)
    throw new Error(`Folio ${folio} ya está pagado`);

  // Obtener el último movimiento
  const lastMov = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT ISNULL(MAX(movimiento), 0) as lastMov FROM tempcheqdet WHERE foliodet = @folio`,
    );

  let movimiento = lastMov.recordset[0].lastMov + 1;
  let subtotalNuevo = 0;
  let impuestoNuevo = 0;
  let totalSinDescuentoNuevo = 0;
  let descuentoNuevo = 0;

  // Aplicar promociones a cada item
  const itemsConPromo = [];
  for (const item of items) {
    const itemPromo = await applyPromoToItem(item, "1");
    itemsConPromo.push(itemPromo);
  }

  // Insertar cada item con promoción aplicada
  for (const item of itemsConPromo) {
    const impuesto = item.impuesto || 16;
    const extraPrice = item.extraPrice || 0;
    const precioConExtra = item.precioFinal + extraPrice;
    const precioSinImp = precioConExtra / (1 + impuesto / 100);
    const comentario = item.comment || "";

    subtotalNuevo += precioSinImp * item.cantidad;
    impuestoNuevo += (precioConExtra - precioSinImp) * item.cantidad;
    totalSinDescuentoNuevo +=
      (item.preciocatalogo + extraPrice) * item.cantidad;
    descuentoNuevo += (item.preciocatalogo - item.precioFinal) * item.cantidad;

    await pool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, precioConExtra)
      .input("preciocatalogo", sql.Money, item.preciocatalogo + extraPrice)
      .input("descuento", sql.Numeric, item.descuento || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("promovolumen", sql.Bit, item.promovolumen ? 1 : 0)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("idestacion", sql.VarChar, "XQUISITO")
      .input("comentario", sql.VarChar, comentario).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          preciocatalogo, descuento, idtipodescuento, promovolumen,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos,
          hora, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor,
          idestacion, comentario, WorkspaceId
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @preciocatalogo, @descuento, @idtipodescuento, @promovolumen,
          @impuesto1, 0, 0, @preciosinimpuestos,
          GETDATE(), 0, 0, 0,
          0, 0, 0,
          @idestacion, @comentario, NEWID()
        )
      `);
    movimiento++;
  }

  // Actualizar totales del cheque
  const totalNuevo = subtotalNuevo + impuestoNuevo;
  await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("subtotalNuevo", sql.Money, subtotalNuevo)
    .input("totalNuevo", sql.Money, totalNuevo)
    .input("impuestoNuevo", sql.Money, impuestoNuevo)
    .input("descuentoNuevo", sql.Money, descuentoNuevo)
    .input("totalSinDescuentoNuevo", sql.Money, totalSinDescuentoNuevo)
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
        totalconpropinacargodonativo = totalconpropinacargodonativo + @totalNuevo,
        totalsindescuento = ISNULL(totalsindescuento, 0) + @totalSinDescuentoNuevo,
        descuentoimporte = ISNULL(descuentoimporte, 0) + @descuentoNuevo,
        totaldescuentos = ISNULL(totaldescuentos, 0) + @descuentoNuevo
      WHERE folio = @folio
    `);

  // Obtener totales actualizados
  const updated = await pool
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

// Obtener cheques abiertos por mesa (Tap & Pay)
async function getChecksByTable(tableNumber, includeClosed = false) {
  await ensureSqlConnection();
  const pool = getPool();

  const query = includeClosed
    ? `SELECT folio, mesa, fecha, nopersonas, subtotal, total, totalimpuesto1, pagado
       FROM tempcheques WHERE mesa = @mesa ORDER BY fecha DESC`
    : `SELECT folio, mesa, fecha, nopersonas, subtotal, total, totalimpuesto1, pagado
       FROM tempcheques WHERE mesa = @mesa AND pagado = 0 ORDER BY fecha DESC`;

  const result = await pool
    .request()
    .input("mesa", sql.VarChar, String(tableNumber))
    .query(query);

  const checks = [];
  for (const cheque of result.recordset) {
    // Obtener items del cheque
    const items = await pool.request().input("folio", sql.BigInt, cheque.folio)
      .query(`
        SELECT d.movimiento, d.idproducto, d.cantidad, d.precio, d.preciosinimpuestos,
               p.descripcion as nombre
        FROM tempcheqdet d
        LEFT JOIN productos p ON d.idproducto = p.idproducto
        WHERE d.foliodet = @folio
        ORDER BY d.movimiento
      `);

    // Obtener pagos del cheque
    const pagos = await pool
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

// Transforma orden de Xquisito a formato Soft Restaurant
function transformOrder(xquisitoOrder) {
  // Asegurar que mesa sea siempre un string válido
  let mesa = xquisitoOrder.tableNumber || xquisitoOrder.table_number || "XQ01";
  if (mesa === null || mesa === undefined || mesa === "") {
    mesa = "XQ01";
  }
  mesa = String(mesa).trim() || "XQ01";

  // idarearestaurant: "01" = COMEDOR (dine_in), "03" = RAPIDO (pick_and_go, room_service, etc.)
  const idarearestaurant = "01";

  return {
    mesa,
    nopersonas: xquisitoOrder.guests || 1,
    idmesero: "",
    idarearestaurant: idarearestaurant,
    idempresa: "1",
    tipodeservicio: xquisitoOrder.orderType === "delivery" ? 2 : 3,
    observaciones: xquisitoOrder.notes || "",
    orderReference: xquisitoOrder.id || `XQ-${Date.now()}`,
    items: (xquisitoOrder.items || []).map((item) => ({
      idproducto: item.productId || item.sku,
      cantidad: item.quantity || 1,
      precio: item.price || 0,
      extraPrice: item.extraPrice || 0,
      comment: item.comment || "",
      impuesto: 16,
    })),
  };
}

module.exports = {
  insertOrder,
  applyPayment,
  addItemsToOrder,
  getChecksByTable,
  transformOrder,
};
