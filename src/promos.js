/**
 * Promos Module - Promociones y Descuentos
 * Consulta y aplica promociones desde promoproductos
 */

const { getPool, sql, ensureSqlConnection } = require("./database");

// Consulta si un producto tiene promoción activa en promoproductos
async function getActivePromo(idproducto, idempresa = "1") {
  await ensureSqlConnection();
  const pool = getPool();

  const result = await pool
    .request()
    .input("idproducto", sql.VarChar, idproducto)
    .input("idempresa", sql.VarChar, idempresa).query(`
      SELECT TOP 1
        preciopromocion,
        descuento,
        idtipodescuento
      FROM promoproductos
      WHERE idproducto = @idproducto
        AND idempresa = @idempresa
        AND (preciopromocion > 0 OR descuento > 0)
    `);

  if (result.recordset.length > 0) {
    const promo = result.recordset[0];
    return {
      hasPromo: true,
      preciopromocion: promo.preciopromocion || 0,
      descuento: promo.descuento || 0,
      idtipodescuento: promo.idtipodescuento || "",
    };
  }

  return {
    hasPromo: false,
    preciopromocion: 0,
    descuento: 0,
    idtipodescuento: "",
  };
}

// Aplica promoción a un item si existe
async function applyPromoToItem(item, idempresa = "1") {
  const promo = await getActivePromo(item.idproducto, idempresa);

  if (!promo.hasPromo) {
    return {
      ...item,
      preciocatalogo: item.precio,
      precioFinal: item.precio,
      descuento: 0,
      idtipodescuento: "",
      promovolumen: false,
    };
  }

  let precioFinal = item.precio;
  let descuentoPorcentaje = 0;

  // Prioridad: precio de promo directo > porcentaje de descuento
  if (promo.preciopromocion && promo.preciopromocion > 0) {
    precioFinal = promo.preciopromocion;
    descuentoPorcentaje = ((item.precio - precioFinal) / item.precio) * 100;
  } else if (promo.descuento && promo.descuento > 0) {
    descuentoPorcentaje = promo.descuento;
    precioFinal = item.precio * (1 - descuentoPorcentaje / 100);
  }

  console.log(
    `[PROMO] ${item.idproducto}: $${item.precio} -> $${precioFinal.toFixed(2)} (${descuentoPorcentaje.toFixed(1)}% off)`,
  );

  return {
    ...item,
    preciocatalogo: item.precio, // Precio original
    precioFinal: precioFinal, // Precio con descuento
    descuento: descuentoPorcentaje, // Porcentaje
    idtipodescuento: promo.idtipodescuento,
    promovolumen: false,
  };
}

module.exports = {
  getActivePromo,
  applyPromoToItem,
};
