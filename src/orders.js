/**
 * Orders Module - Gestión de Órdenes/Cheques
 * Inserta órdenes en tempcheques/tempcheqdet con soporte de descuentos
 */

const {
  sql,
  getPool,
  ensureSqlConnection,
  getActiveTurno,
  getNextNumCheque,
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

// Insertar nueva orden en tempcheques y tempcheqdet
async function insertOrder(orderData) {
  await ensureSqlConnection();
  const pool = getPool();
  const turno = await getActiveTurno();
  const numcheque = await getNextNumCheque();

  if (!turno) throw new Error("No hay turno abierto en Soft Restaurant");

  const idempresa = orderData.idempresa || "1";

  // 1. Aplicar promociones a cada item
  const itemsConPromo = [];
  for (const item of orderData.items) {
    const itemPromo = await applyPromoToItem(item, idempresa);
    itemsConPromo.push(itemPromo);
  }

  // 2. Calcular totales
  let totalSinDescuento = 0;
  let totalConDescuento = 0;
  let totalImpuesto = 0;
  let subtotalSinImp = 0;

  for (const item of itemsConPromo) {
    const impuesto = item.impuesto || 16;
    const precioOriginal = item.preciocatalogo;
    const precioFinal = item.precioFinal;
    const precioSinImp = precioFinal / (1 + impuesto / 100);

    totalSinDescuento += precioOriginal * item.cantidad;
    totalConDescuento += precioFinal * item.cantidad;
    subtotalSinImp += precioSinImp * item.cantidad;
    totalImpuesto += (precioFinal - precioSinImp) * item.cantidad;
  }

  const descuentoTotal = totalSinDescuento - totalConDescuento;

  // 3. INSERT tempcheques con todos los campos correctos (no NULLs)
  const codigoUnicoAF = generateCodigoUnicoAF();

  const insertResult = await pool
    .request()
    .input("fecha", sql.DateTime, new Date())
    .input("cierre", sql.DateTime, new Date())
    .input("estacion", sql.VarChar, "XQUISITO")
    .input("numcheque", sql.BigInt, numcheque)
    .input("mesa", sql.VarChar, orderData.mesa || "XQ01")
    .input("nopersonas", sql.Int, orderData.nopersonas || 1)
    .input("idmesero", sql.VarChar, orderData.idmesero || "")
    .input("idarearestaurant", sql.VarChar, orderData.idarearestaurant || "03")
    .input("idempresa", sql.VarChar, idempresa)
    .input("tipodeservicio", sql.Int, orderData.tipodeservicio || 3)
    .input("idturno", sql.BigInt, turno.idturno)
    .input("usuarioapertura", sql.VarChar, "XQUISITO")
    .input("subtotal", sql.Money, subtotalSinImp)
    .input("subtotalsinimpuestos", sql.Money, null)
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
        totalsindescuento, descuentoimporte, totaldescuentos,
        totalalimentos, totalcondonativo, totalconpropinacargodonativo,
        observaciones, appname, orderreference,
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
        pedidovistosrx, impresoenbitacorasrm, TKC_Token, TKC_Transaction,
        TKC_Authorization, TKC_Cupon, TKC_ExpirationDate, TKC_Recompensa,
        campoadicional2, campoadicional3, estrateca_CardNumber, estrateca_VoucherText,
        campoadicional4, campoadicional5, sacoa_CardNumber, sacoa_credits,
        estrateca_TypeDisccount, estrateca_DiscountCode, estrateca_DiscountID,
        estrateca_DiscountAmount, donativo, status_domicilio, enviopagado,
        diet_restrictions, sl_cupon_descuento, sl_tipo_cupon, TUKI_CardNumber,
        WorkspaceId, SentSync, procesar_descuento_emenu, procesar_descuento_sr,
        imprimenotabluetooth, datosimpresionnotaconsumo, mv_room, mv_lastname,
        idcliente, comentariodescuento, usuariodescuento, idtipodescuento,
        numerotarjeta, ncf, numerocuenta, titulartarjetamonedero,
        autorizacionfolio, puntosmonederogenerados, usuariopago
      )
      OUTPUT INSERTED.folio
      VALUES (
        @fecha, @cierre, @estacion, @numcheque, @mesa, @nopersonas, @idmesero,
        @idarearestaurant, @idempresa, @tipodeservicio, @idturno,
        @usuarioapertura, @subtotal, @subtotalsinimpuestos,
        @total, @totalconpropina, @totalimpuesto1, @totalconcargo,
        @totalconpropinacargo, @totalarticulos,
        @totalsindescuento, @descuentoimporte, @totaldescuentos,
        @totalalimentos, @totalcondonativo, @totalconpropinacargodonativo,
        @observaciones, @appname, @orderreference,
        '', 0, 0, 0, 0, '',
        0, 0, 0, 0, 0, 0, 0,
        1, 0, 0,
        0, 0, 0,
        0, 0, 0, 0,
        0, @totalalimentossindescuentos, 0, 0,
        0, 0, @subtotalcondescuento, @codigounicoaf, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0,
        1, '', '',
        -1, '', 0, -1, '',
        0, -1, -1, '', 0,
        0, 0, '', '',
        '', '', '', 0,
        '', '', '', '',
        '', '', '', 0,
        '', '', '',
        0, 0, 0, 0,
        '', '', '', '',
        NEWID(), 0, 0, 0,
        0, '', '', '',
        '', '', '', '',
        '', '', '', '',
        '', 0, 'XQUISITO'
      )
    `);

  const folio = insertResult.recordset[0].folio;

  // 4. INSERT tempcheqdet con campos de descuento
  let movimiento = 1;
  for (const item of itemsConPromo) {
    const impuesto = item.impuesto || 16;
    const precioSinImp = item.precioFinal / (1 + impuesto / 100);

    await pool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, item.precioFinal)
      .input("preciocatalogo", sql.Money, item.preciocatalogo)
      .input("descuento", sql.Numeric, item.descuento || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("promovolumen", sql.Bit, item.promovolumen ? 1 : 0)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("hora", sql.DateTime, new Date()).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          preciocatalogo, descuento, idtipodescuento, promovolumen,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos,
          hora, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor, nivel,
          sistema_envio, iddispositivo, productsyncidsr,
          subtotalsrx, totalsrx, idmovtobillar, impuestoimporte3,
          estrateca_DiscountCode, estrateca_DiscountID, estrateca_DiscountAmount,
          procesadosrx, escargoarea, WorkspaceId
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @preciocatalogo, @descuento, @idtipodescuento, @promovolumen,
          @impuesto1, 0, 0, @preciosinimpuestos,
          @hora, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0, 0,
          '', '', 0,
          0, 0, NEWID()
        )
      `);
    movimiento++;
  }

  if (descuentoTotal > 0) {
    console.log(
      `[ORDER] Descuento aplicado: $${descuentoTotal.toFixed(2)} (${((descuentoTotal / totalSinDescuento) * 100).toFixed(1)}%)`,
    );
  }

  return {
    folio,
    total: totalConDescuento,
    subtotal: subtotalSinImp,
    tax: totalImpuesto,
    descuento: descuentoTotal,
    totalSinDescuento,
    itemsCount: orderData.items.length,
  };
}

// Aplicar pago a un folio
async function applyPayment(folio, amount, tenderId, reference) {
  await ensureSqlConnection();
  const pool = getPool();

  const cheque = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(`SELECT total FROM tempcheques WHERE folio = @folio`);

  if (!cheque.recordset.length) throw new Error(`Folio ${folio} no encontrado`);

  const totalCheque = cheque.recordset[0].total;
  const importePago = amount === 0 ? totalCheque : amount;

  let formaPago = tenderId;
  if (!formaPago) {
    const formas = await pool.request().query(`
      SELECT TOP 1 idformadepago FROM formasdepago ORDER BY prioridadboton ASC
    `);
    if (formas.recordset.length > 0) {
      formaPago = formas.recordset[0].idformadepago;
    } else {
      throw new Error("No hay formas de pago en el sistema");
    }
  }

  await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .input("idformadepago", sql.VarChar, formaPago)
    .input("importe", sql.Money, importePago)
    .input("propina", sql.Money, 0)
    .input("referencia", sql.VarChar, reference || "XQUISITO").query(`
      INSERT INTO tempchequespagos (folio, idformadepago, importe, propina, referencia)
      VALUES (@folio, @idformadepago, @importe, @propina, @referencia)
    `);

  const totalPagado = await pool
    .request()
    .input("folio", sql.BigInt, folio)
    .query(
      `SELECT ISNULL(SUM(importe), 0) as totalPagado FROM tempchequespagos WHERE folio = @folio`,
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
    totalCheque,
  };
}

// Agregar items a un folio existente (FlexBill)
async function addItemsToOrder(folio, items) {
  await ensureSqlConnection();
  const pool = getPool();

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
    const precioSinImp = item.precioFinal / (1 + impuesto / 100);

    subtotalNuevo += precioSinImp * item.cantidad;
    impuestoNuevo += (item.precioFinal - precioSinImp) * item.cantidad;
    totalSinDescuentoNuevo += item.preciocatalogo * item.cantidad;
    descuentoNuevo += (item.preciocatalogo - item.precioFinal) * item.cantidad;

    await pool
      .request()
      .input("foliodet", sql.BigInt, folio)
      .input("movimiento", sql.Numeric, movimiento)
      .input("cantidad", sql.Numeric, item.cantidad)
      .input("idproducto", sql.VarChar, item.idproducto)
      .input("precio", sql.Money, item.precioFinal)
      .input("preciocatalogo", sql.Money, item.preciocatalogo)
      .input("descuento", sql.Numeric, item.descuento || 0)
      .input("idtipodescuento", sql.VarChar, item.idtipodescuento || "")
      .input("promovolumen", sql.Bit, item.promovolumen ? 1 : 0)
      .input("impuesto1", sql.Numeric, impuesto)
      .input("preciosinimpuestos", sql.Money, precioSinImp)
      .input("hora", sql.DateTime, new Date()).query(`
        INSERT INTO tempcheqdet (
          foliodet, movimiento, cantidad, idproducto, precio,
          preciocatalogo, descuento, idtipodescuento, promovolumen,
          impuesto1, impuesto2, impuesto3, preciosinimpuestos,
          hora, modificador, mitad, marcar,
          productocompuestoprincipal, estatuspatin, estadomonitor, nivel,
          sistema_envio, iddispositivo, productsyncidsr,
          subtotalsrx, totalsrx, idmovtobillar, impuestoimporte3,
          estrateca_DiscountCode, estrateca_DiscountID, estrateca_DiscountAmount,
          procesadosrx, escargoarea, WorkspaceId
        ) VALUES (
          @foliodet, @movimiento, @cantidad, @idproducto, @precio,
          @preciocatalogo, @descuento, @idtipodescuento, @promovolumen,
          @impuesto1, 0, 0, @preciosinimpuestos,
          @hora, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0, 0,
          '', '', 0,
          0, 0, NEWID()
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

  return {
    mesa,
    nopersonas: xquisitoOrder.guests || 1,
    idmesero: "",
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

module.exports = {
  insertOrder,
  applyPayment,
  addItemsToOrder,
  getChecksByTable,
  transformOrder,
};
